import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FactoryConfig } from "../config/schema.ts";
import { PreconditionError } from "../errors.ts";
import { git } from "../exec.ts";
import { commitPaths } from "../git/commit.ts";
import { type HookStatus, installPrePush } from "../git/hooks.ts";
import { buildLock, LOCK_FILE, type Lock, readLock, serializeLock } from "../lock/lock.ts";
import { executeSync, type PlannedChange, planSync } from "../managed/sync.ts";
import { renderWorkspace } from "../render/workspace.ts";

/**
 * Paths a factory install commits in the AI repo. OpenSpec's own init output is included;
 * everything else in `openspec/` (specs, changes) is never part of an install commit.
 */
export const INSTALL_PATHS = [
  "AGENTS.md",
  ".gitignore",
  ".graphifyignore",
  ".opencode",
  "openspec/config.yaml",
  "openspec/specs/.gitkeep",
  "openspec/changes/archive/.gitkeep",
  "factory.config.jsonc",
  LOCK_FILE,
] as const;

export interface SyncOptions {
  readonly force?: boolean;
  readonly restore?: boolean;
  readonly adopt?: readonly string[];
}

export interface SyncResult {
  readonly plan: PlannedChange[];
  readonly lock: Lock;
  readonly hooks: { repo: string; result: HookStatus }[];
}

/** Plans the sync and fails on conflicts, before anything is written. */
export function planWorkspace(
  root: string,
  config: FactoryConfig,
  options: SyncOptions = {},
): PlannedChange[] {
  const previous = readLock(root)?.managed ?? {};
  const plan = planSync(root, renderWorkspace(config), previous, {
    unmanaged: config.unmanaged,
    ...options,
  });
  const conflicts = plan.filter((c) => c.action === "conflict").map((c) => c.path);
  if (conflicts.length > 0) {
    throw new PreconditionError("files already exist that ai-factory did not create", [
      ...conflicts,
      "move them away, list them under `unmanaged` in factory.config.jsonc, or rerun with --force",
    ]);
  }
  return plan;
}

/** Renders managed files, writes them and the lock, and (re)installs hooks. */
export async function syncWorkspace(
  root: string,
  config: FactoryConfig,
  options: SyncOptions = {},
): Promise<SyncResult> {
  const previous = readLock(root)?.managed ?? {};
  const plan = planWorkspace(root, config, options);

  const managed = await executeSync(root, plan, previous);
  const lock = buildLock(managed);
  writeFileSync(join(root, LOCK_FILE), serializeLock(lock));

  const hooks: SyncResult["hooks"] = [];
  for (const repo of config.repos) {
    hooks.push({ repo: repo.name, result: await installPrePush(join(root, repo.path)) });
  }
  return { plan, lock, hooks };
}

/** Install paths with uncommitted changes, which an install commit would sweep in. */
export async function dirtyInstallPaths(
  root: string,
  ignore: readonly string[] = [],
): Promise<string[]> {
  const res = await git(
    ["status", "--porcelain=v1", "--untracked-files=all", "--", ...INSTALL_PATHS],
    {
      cwd: root,
    },
  );
  return res.stdout
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => l.slice(3))
    .filter((p) => !ignore.includes(p));
}

/**
 * Commits the install paths only (other staged work is left alone). Returns the new commit,
 * or undefined when there was nothing to commit.
 */
export function commitInstall(root: string, message: string): Promise<string | undefined> {
  // Removed managed files (e.g. a dropped implementer) are staged via their parent directory.
  return commitPaths(
    root,
    INSTALL_PATHS.filter((p) => existsSync(join(root, p))),
    message,
  );
}
