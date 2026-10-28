import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative } from "node:path";
import type { FactoryConfig } from "../config/schema.ts";
import { PreconditionError } from "../errors.ts";
import { commitPaths } from "../git/commit.ts";
import { factoryDir } from "../state/files.ts";
import { wastedReads } from "../usage/usage.ts";
import {
  ARTIFACTS_DIR,
  type ArtifactKind,
  artifactDir,
  artifactFile,
  isArtifactId,
} from "./paths.ts";

/**
 * Snapshots a change's final report, approval and usage ledger into the committed
 * `factory-records/` tree (ADR-0035). The source of truth stays `.factory/`; this is a copy
 * made once the change is finished, so a fresh clone or another machine keeps the record.
 * Logs, paused reports, context packs, drafts and run state are never exported.
 */

export interface ExportResult {
  readonly id: string;
  /** Workspace-relative paths written (or that would be written, with `dryRun`). */
  readonly written: readonly string[];
  /** Paths whose content was already current. */
  readonly unchanged: readonly string[];
  readonly commit?: string;
}

export interface ExportOptions {
  /** Skip writes and commits; report what would change. */
  readonly dryRun?: boolean;
  /** Set false to write without committing (the caller commits a batch). */
  readonly commit?: boolean;
}

export interface SyncAllResult {
  readonly changes: readonly ExportResult[];
  readonly written: readonly string[];
  readonly commit?: string;
}

export const artifactsEnabled = (config: FactoryConfig): boolean => config.artifacts.mode === "git";

function sourceFile(root: string, id: string, kind: ArtifactKind): string {
  switch (kind) {
    case "reports":
      return factoryDir(root, "reports", `${id}.md`);
    case "approvals":
      return factoryDir(root, "approvals", `${id}.json`);
    case "usage":
      return factoryDir(root, "usage", `${id}.json`);
  }
}

function enabled(config: FactoryConfig, kind: ArtifactKind): boolean {
  return config.artifacts[kind];
}

/**
 * The text to commit for one record. The usage snapshot carries `wastedReads`, because the
 * log it is derived from stays local and a clone would otherwise report zero.
 */
function content(root: string, id: string, kind: ArtifactKind): string | undefined {
  const file = sourceFile(root, id, kind);
  if (!existsSync(file)) return undefined;
  if (kind !== "usage") return readFileSync(file, "utf8");
  let ledger: Record<string, unknown>;
  try {
    ledger = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    // A corrupt ledger is already reported by `usage`; do not commit it.
    return undefined;
  }
  return `${JSON.stringify({ ...ledger, wastedReads: wastedReads(root, id) }, null, 2)}\n`;
}

function writeAtomic(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

/** Validates the mode and id both callers rely on; returns the guard error to throw. */
function precondition(config: FactoryConfig, id: string): PreconditionError | undefined {
  if (!isArtifactId(id))
    return new PreconditionError(`"${id}" is not a valid change id`, [
      "change and quick-task ids are lowercase slugs",
      `nothing was written to ${ARTIFACTS_DIR}`,
    ]);
  if (!artifactsEnabled(config))
    return new PreconditionError('artifacts.mode is "local"', [
      'set "artifacts": { "mode": "git" } in factory.config.jsonc',
      "run `ai-factory update` to apply the config, then `ai-factory artifacts sync --all`",
    ]);
  return undefined;
}

/** Copies one change's records into `factory-records/` and commits them. */
export async function exportArtifacts(
  root: string,
  config: FactoryConfig,
  id: string,
  options: ExportOptions = {},
): Promise<ExportResult> {
  const error = precondition(config, id);
  if (error !== undefined) throw error;

  const pending: { rel: string; abs: string; text: string }[] = [];
  const unchanged: string[] = [];
  for (const kind of ["reports", "approvals", "usage"] as const) {
    if (!enabled(config, kind)) continue;
    const text = content(root, id, kind);
    if (text === undefined) continue;
    const name = kind === "reports" ? `${id}.md` : `${id}.json`;
    const abs = artifactFile(root, kind, name);
    const rel = relative(root, abs);
    if (existsSync(abs) && readFileSync(abs, "utf8") === text) unchanged.push(rel);
    else pending.push({ rel, abs, text });
  }

  if (options.dryRun === true) return { id, written: pending.map((p) => p.rel), unchanged };

  for (const file of pending) writeAtomic(file.abs, file.text);
  const written = pending.map((p) => p.rel);
  if (options.commit === false || written.length === 0) return { id, written, unchanged };

  const commit = await commitPaths(root, written, `docs(factory): record ${id}`, {
    "Change-Id": id,
  });
  return { id, written, unchanged, ...(commit === undefined ? {} : { commit }) };
}

/** Every id with a local record under `.factory/` (resume reports are not records). */
function localIds(root: string): string[] {
  const ids = new Set<string>();
  for (const [kind, suffix] of [
    ["reports", ".md"],
    ["approvals", ".json"],
    ["usage", ".json"],
  ] as const) {
    const dir = factoryDir(root, kind);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(suffix)) continue;
      // Pause reports are transient and embed gate output; they are not records.
      if (kind === "reports" && name.endsWith("-paused.md")) continue;
      const id = name.slice(0, -suffix.length);
      if (isArtifactId(id)) ids.add(id);
    }
  }
  return [...ids].sort();
}

/**
 * Backfills every id that still has local records. One commit for the whole batch, so
 * turning the mode on in an existing workspace does not add a commit per past change.
 */
export async function syncAllArtifacts(
  root: string,
  config: FactoryConfig,
  options: ExportOptions = {},
): Promise<SyncAllResult> {
  if (!artifactsEnabled(config)) {
    throw new PreconditionError('artifacts.mode is "local"', [
      'set "artifacts": { "mode": "git" } in factory.config.jsonc',
      "run `ai-factory update` to apply the config",
    ]);
  }
  const changes: ExportResult[] = [];
  for (const id of localIds(root)) {
    changes.push(await exportArtifacts(root, config, id, { ...options, commit: false }));
  }
  const written = changes.flatMap((c) => c.written);
  if (options.dryRun === true || written.length === 0) return { changes, written };

  const commit = await commitPaths(
    root,
    written,
    `docs(factory): backfill ${new Set(changes.filter((c) => c.written.length > 0).map((c) => c.id)).size} change record(s)`,
  );
  return { changes, written, ...(commit === undefined ? {} : { commit }) };
}

/** Count of committed records, for `doctor`. */
export function committedRecords(root: string): number {
  let n = 0;
  for (const kind of ["reports", "approvals", "usage"] as const) {
    const dir = artifactDir(root, kind);
    if (!existsSync(dir)) continue;
    n += readdirSync(dir).length;
  }
  return n;
}

/** Convenience for hooks: exports only when the mode is on. */
export async function maybeExport(
  root: string,
  config: FactoryConfig,
  id: string,
  options: ExportOptions = {},
): Promise<ExportResult | undefined> {
  if (!artifactsEnabled(config)) return undefined;
  return exportArtifacts(root, config, id, options);
}
