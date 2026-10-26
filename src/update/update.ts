import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { parseConfigText } from "../config/load.ts";
import { CONFIG_FILE, type FactoryConfig } from "../config/schema.ts";
import { diffDetection, formatChange } from "../detect/diff.ts";
import { detectWorkspace } from "../detect/workspace.ts";
import { PreconditionError } from "../errors.ts";
import { git } from "../exec.ts";
import { graphStatus } from "../graph/graph.ts";
import { LOCK_FILE, type Lock, readLock } from "../lock/lock.ts";
import type { PlannedChange } from "../managed/sync.ts";
import { migrateConfigText } from "../migrations/index.ts";
import type { ManagedFile } from "../render/workspace.ts";
import { readActive, readQueue } from "../state/active.ts";
import { factoryDir, writeJsonAtomic } from "../state/files.ts";
import { scanRuns } from "../state/run.ts";
import { FACTORY_VERSION } from "../version.ts";
import { GRAPHIFY } from "../versions.ts";
import { INSTALL_PATHS, planWorkspace } from "../workspace/sync.ts";

/**
 * `ai-factory update` (§10): migrate the config, re-render managed files with three-way
 * merges of user edits, refresh tools, all behind a backup and in one commit.
 */

const WRITES: ReadonlySet<PlannedChange["action"]> = new Set([
  "create",
  "update",
  "overwrite",
  "keep-user-edit",
  "remove",
]);
const IN_PROGRESS = new Set([
  "queued",
  "implementing",
  "reviewing",
  "contracts",
  "full-suite",
  "closing",
]);

/** Changes that are active, or approved and waiting: `update` refuses while they exist. */
export function changesInProgress(root: string): string[] {
  const ids = new Set<string>();
  const active = readActive(root);
  if (active) ids.add(active.changeId);
  for (const e of readQueue(root).entries) ids.add(e.changeId);
  const { runs, corrupt } = scanRuns(root);
  for (const run of runs) {
    if (IN_PROGRESS.has(run.phase) || (run.phase === "paused" && run.tasks.length > 0))
      ids.add(run.id);
  }
  // A corrupt run may be in progress: `update` waits until it is fixed or removed.
  for (const c of corrupt) ids.add(c.id);
  return [...ids].sort();
}

export interface UpdatePlan {
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly configText: string;
  readonly config: FactoryConfig;
  readonly migrations: string[];
  readonly changes: PlannedChange[];
  /** Workspace-relative paths that will be written or removed (backed up first). */
  readonly touched: string[];
  readonly openspecRefresh: boolean;
  readonly graphRebuild: boolean;
  readonly warnings: string[];
}

export interface PlanOptions {
  readonly tools?: boolean;
  readonly restore?: boolean;
  /** OpenSpec's regenerated opencode files (with `--tools`). */
  readonly toolFiles?: readonly ManagedFile[];
}

export async function planUpdate(
  root: string,
  lock: Lock,
  options: PlanOptions,
): Promise<UpdatePlan> {
  const original = readFileSync(join(root, CONFIG_FILE), "utf8");
  const migration = migrateConfigText(original);
  const config = parseConfigText(migration.text, CONFIG_FILE);
  const plan = planWorkspace(root, config, {
    ...(options.restore ? { restore: true } : {}),
    ...(options.toolFiles !== undefined ? { tools: options.toolFiles } : {}),
    merge: true,
  });
  const changes = plan.filter((c) => WRITES.has(c.action));

  const touched = new Set<string>(changes.map((c) => c.path));
  touched.add(LOCK_FILE);
  if (migration.applied.length > 0) touched.add(CONFIG_FILE);
  // `openspec init` refreshes its own opencode files.
  if (options.tools) {
    for (const dir of [".opencode/commands", ".opencode/skills"]) touched.add(dir);
  }

  const warnings: string[] = [];
  const drift = diffDetection(await detectWorkspace(root), config);
  if (drift.length > 0) {
    warnings.push(
      "detection differs from the config (not applied; see `ai-factory detect`):",
      ...drift.map((c) => `  ${formatChange(c)}`),
    );
  }
  const graph = graphStatus(root);
  const graphRebuild =
    options.tools === true &&
    (lock.graph.schemaVersion !== GRAPHIFY.graphSchemaVersion || graph.state === "unsupported");
  return {
    fromVersion: lock.factoryVersion,
    toVersion: FACTORY_VERSION,
    configText: migration.text,
    config,
    migrations: migration.applied,
    changes,
    touched: [...touched].sort(),
    openspecRefresh: options.tools === true,
    graphRebuild,
    warnings,
  };
}

export function formatPlan(plan: UpdatePlan): string[] {
  const label: Partial<Record<PlannedChange["action"], string>> = {
    create: "create",
    update: "update",
    overwrite: "overwrite",
    "keep-user-edit": "merge with your edits",
    remove: "remove",
  };
  return [
    `update ${plan.fromVersion} → ${plan.toVersion}`,
    plan.migrations.length > 0
      ? `config migrations: ${plan.migrations.join(", ")}`
      : "config migrations: none",
    ...(plan.changes.length > 0
      ? plan.changes.map((c) => `  ${label[c.action] ?? c.action}: ${c.path}`)
      : ["managed files: up to date"]),
    ...(plan.openspecRefresh
      ? ["tools: OpenSpec's opencode files regenerated and merged like the factory's own"]
      : []),
    ...(plan.graphRebuild
      ? ["tools: the graph format changed; rebuild the graph (graph --full)"]
      : []),
    ...plan.warnings,
  ];
}

export interface BackupManifest {
  readonly at: string;
  readonly fromVersion: string;
  readonly toVersion: string;
  /** Paths that existed and were copied. */
  readonly files: string[];
  /** Paths that did not exist before the update (rollback deletes them). */
  readonly created: string[];
  restored?: boolean;
}

const backupsDir = (root: string): string => factoryDir(root, "backups");

/** Copies every path the update may touch to `.factory/backups/<timestamp>/`. */
export function backup(root: string, plan: UpdatePlan): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = join(backupsDir(root), stamp);
  const files: string[] = [];
  const created: string[] = [];
  for (const rel of plan.touched) {
    const abs = join(root, rel);
    if (!existsSync(abs)) {
      created.push(rel);
      continue;
    }
    mkdirSync(dirname(join(dir, "files", rel)), { recursive: true });
    cpSync(abs, join(dir, "files", rel), { recursive: true });
    files.push(rel);
  }
  writeJsonAtomic(join(dir, "manifest.json"), {
    at: new Date().toISOString(),
    fromVersion: plan.fromVersion,
    toVersion: plan.toVersion,
    files,
    created,
  } satisfies BackupManifest);
  return dir;
}

/** The newest backup that was not restored yet. */
export function latestBackup(root: string): { dir: string; manifest: BackupManifest } | undefined {
  const base = backupsDir(root);
  if (!existsSync(base)) return undefined;
  for (const name of readdirSync(base).sort().reverse()) {
    const file = join(base, name, "manifest.json");
    if (!existsSync(file)) continue;
    const manifest = JSON.parse(readFileSync(file, "utf8")) as BackupManifest;
    if (!manifest.restored) return { dir: join(base, name), manifest };
  }
  return undefined;
}

/** Puts every backed-up path back and removes what the update created. */
export async function restoreBackup(
  root: string,
  dir: string,
  manifest: BackupManifest,
): Promise<string[]> {
  for (const rel of manifest.created) rmSync(join(root, rel), { recursive: true, force: true });
  for (const rel of manifest.files) {
    const target = join(root, rel);
    rmSync(target, { recursive: true, force: true });
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(dir, "files", rel), target, { recursive: true });
  }
  writeFileSync(
    join(dir, "manifest.json"),
    `${JSON.stringify({ ...manifest, restored: true }, null, 2)}\n`,
  );
  return [...manifest.files, ...manifest.created];
}

/** Dirty paths outside what an update writes block it (and rollback). */
export async function dirtyOutside(root: string, allowed: readonly string[]): Promise<string[]> {
  const res = await git(["status", "--porcelain=v1", "--untracked-files=all"], { cwd: root });
  return res.stdout
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => l.slice(3))
    .filter((p) => !allowed.some((a) => p === a || p.startsWith(`${a}/`)));
}

export const UPDATE_COMMIT_PATHS = [...INSTALL_PATHS];

export function requireInstalled(root: string): Lock {
  const lock = readLock(root);
  if (lock === undefined)
    throw new PreconditionError("ai-factory is not installed here", ["run `ai-factory init`"]);
  return lock;
}
