import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { exec } from "../exec.ts";
import { appendLog } from "../logs/log.ts";
import { factoryDir, readJson, withFileLock, writeJsonAtomic } from "../state/files.ts";
import { toolBin, toolEnv } from "../tools.ts";
import { GRAPHIFY } from "../versions.ts";

/**
 * The workspace graph (ADR-0006, ADR-0007): one Graphify graph over the AI repo and every
 * submodule, in the gitignored `graphify-out/`, updated by the CLI only. Agents query it
 * read-only with `--graph $AI_FACTORY_GRAPH`.
 */

export const graphDir = (root: string): string => join(root, "graphify-out");
export const graphFile = (root: string): string => join(graphDir(root), "graph.json");
const metaFile = (root: string): string => factoryDir(root, "graph-meta.json");

export interface GraphMeta {
  readonly builtAt: string;
  readonly durationMs: number;
  readonly full: boolean;
  readonly schemaVersion?: number;
  readonly graphifyVersion?: string;
  readonly nodes: number;
  readonly links: number;
}

export interface GraphResult {
  readonly ok: boolean;
  readonly meta?: GraphMeta;
  readonly error?: string;
}

interface GraphDoc {
  readonly graph?: { schema_version?: number; graphify_version?: string };
  readonly built_at_commit?: string;
  readonly nodes?: { id: string; source_file?: string }[];
  readonly links?: { source: string; target: string; relation?: string; source_file?: string }[];
}

function readGraph(root: string): GraphDoc | undefined {
  try {
    return JSON.parse(readFileSync(graphFile(root), "utf8")) as GraphDoc;
  } catch {
    return undefined;
  }
}

/**
 * Builds (`full`, from scratch) or incrementally updates the graph. Never calls an LLM and
 * never refreshes files in $HOME (GRAPHIFY_ENV). A failure is reported, not thrown: the
 * graph is an aid, and agents fall back to grep.
 */
export function updateGraph(
  root: string,
  options: { full?: boolean; changeId?: string } = {},
): Promise<GraphResult> {
  // One graphify run per workspace, also across processes (`ai-factory graph` during a run).
  const limit = 25 * 60_000;
  return withFileLock(factoryDir(root, "graph.lock"), () => runGraphify(root, options), limit, {
    staleAfterMs: limit,
  });
}

async function runGraphify(
  root: string,
  options: { full?: boolean; changeId?: string },
): Promise<GraphResult> {
  const full = options.full === true || !existsSync(graphFile(root));
  if (options.full) rmSync(graphDir(root), { recursive: true, force: true });
  const started = Date.now();
  // --force lets the graph shrink when files were deleted.
  const res = await exec([toolBin("graphify"), "update", root, "--force"], {
    cwd: root,
    env: toolEnv("graphify"),
    timeoutMs: 20 * 60_000,
  });
  const durationMs = Date.now() - started;
  const doc = readGraph(root);
  if (res.code !== 0 || doc === undefined) {
    const error =
      res.code !== 0
        ? (res.stderr || res.stdout).trim().slice(-2000)
        : "graphify wrote no graph.json";
    if (options.changeId)
      appendLog(root, options.changeId, { kind: "graph-update", ok: false, durationMs, error });
    return { ok: false, error };
  }
  const meta: GraphMeta = {
    builtAt: new Date().toISOString(),
    durationMs,
    full,
    ...(doc.graph?.schema_version === undefined ? {} : { schemaVersion: doc.graph.schema_version }),
    ...(doc.graph?.graphify_version === undefined
      ? {}
      : { graphifyVersion: doc.graph.graphify_version }),
    nodes: doc.nodes?.length ?? 0,
    links: doc.links?.length ?? 0,
  };
  writeJsonAtomic(metaFile(root), meta);
  if (options.changeId)
    appendLog(root, options.changeId, { kind: "graph-update", ok: true, ...meta });
  return { ok: true, meta };
}

/**
 * Why the graph must be rebuilt from scratch, if it must: a format this factory cannot read,
 * or one built by another Graphify release than the installed one (audit G6).
 */
export function graphRebuildReason(
  status: GraphStatus,
  installedGraphify: string | undefined,
): string | undefined {
  if (status.state === "unsupported")
    return `format ${status.schemaVersion ?? "unknown"} differs from what this factory reads`;
  if (status.state !== "ok") return undefined;
  const built = status.meta?.graphifyVersion;
  if (built !== undefined && installedGraphify !== undefined && built !== installedGraphify)
    return `built by graphify ${built}, installed is ${installedGraphify}`;
  return undefined;
}

export type GraphStatus =
  | { state: "missing" }
  | { state: "unsupported"; schemaVersion: number | undefined }
  | { state: "ok"; meta?: GraphMeta; ageMs: number; builtAtCommit?: string };

/** For `doctor` and `status`: is there a graph, and in a format this factory reads? */
export function graphStatus(root: string): GraphStatus {
  if (!existsSync(graphFile(root))) return { state: "missing" };
  const doc = readGraph(root);
  const schema = doc?.graph?.schema_version;
  if (schema !== GRAPHIFY.graphSchemaVersion)
    return { state: "unsupported", schemaVersion: schema };
  let meta: GraphMeta | undefined;
  try {
    meta = existsSync(metaFile(root)) ? (readJson(metaFile(root)) as GraphMeta) : undefined;
  } catch {
    meta = undefined; // unreadable metadata only loses the age details (audit P15)
  }
  return {
    state: "ok",
    ...(meta ? { meta } : {}),
    ageMs: Date.now() - statSync(graphFile(root)).mtimeMs,
    ...(doc?.built_at_commit ? { builtAtCommit: doc.built_at_commit } : {}),
  };
}

const DEPENDENCY_RELATIONS = new Set(["calls", "imports", "imports_from", "references", "method"]);

let cache: { root: string; mtime: number; doc: GraphDoc } | undefined;

/**
 * Files (workspace-relative) whose code calls, imports or references something defined in
 * `files` (workspace-relative). Used to widen affected-test selection (§9). Empty without
 * a graph.
 */
export function dependentFiles(root: string, files: readonly string[]): Set<string> {
  const out = new Set<string>();
  if (files.length === 0 || !existsSync(graphFile(root))) return out;
  const mtime = statSync(graphFile(root)).mtimeMs;
  if (cache?.root !== root || cache.mtime !== mtime) {
    const doc = readGraph(root);
    if (doc === undefined) return out;
    cache = { root, mtime, doc };
  }
  const doc = cache.doc;
  const wanted = new Set(files);
  const fileOf = new Map((doc.nodes ?? []).map((n) => [n.id, n.source_file]));
  for (const link of doc.links ?? []) {
    if (!DEPENDENCY_RELATIONS.has(link.relation ?? "")) continue;
    const target = fileOf.get(link.target);
    const from = link.source_file ?? fileOf.get(link.source);
    if (target !== undefined && wanted.has(target) && from !== undefined && from !== target)
      out.add(from);
  }
  return out;
}
