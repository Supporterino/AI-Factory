import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PONYTAIL_DIR } from "../addons/ponytail.ts";
import type { FactoryConfig } from "../config/schema.ts";
import { PreconditionError } from "../errors.ts";
import { git } from "../exec.ts";
import { commitPaths } from "../git/commit.ts";
import { type HookStatus, installPrePush } from "../git/hooks.ts";
import {
  buildLock,
  LOCK_FILE,
  type Lock,
  type LockEntry,
  readLock,
  serializeLock,
} from "../lock/lock.ts";
import { executeSync, type PlannedChange, planSync, type SyncAction } from "../managed/sync.ts";
import { OPENSPEC_TOOLS_TEMPLATE } from "../openspec/cli.ts";
import { type ManagedFile, renderWorkspace } from "../render/workspace.ts";
import { PONYTAIL } from "../versions.ts";

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
  /** Three-way merge user-edited files with the new templates (`update`). */
  readonly merge?: boolean;
  /**
   * OpenSpec's generated opencode files (`renderOpenspecTools`), for init and `update --tools`.
   * Without them, their lock entries are carried over untouched.
   */
  readonly tools?: readonly ManagedFile[];
}

/** Lock entries of OpenSpec-generated files to carry over when they are not regenerated. */
function carriedTools(
  previous: Readonly<Record<string, LockEntry>>,
  options: SyncOptions,
): Record<string, LockEntry> {
  if (options.tools !== undefined) return {};
  return Object.fromEntries(
    Object.entries(previous).filter(([, e]) => e.template === OPENSPEC_TOOLS_TEMPLATE),
  );
}

export interface SyncResult {
  readonly plan: PlannedChange[];
  readonly lock: Lock;
  readonly merged: string[];
  readonly conflicts: string[];
  readonly hooks: { repo: string; result: HookStatus }[];
}

/** Plans the sync and fails on conflicts, before anything is written. */
export function planWorkspace(
  root: string,
  config: FactoryConfig,
  options: SyncOptions = {},
): PlannedChange[] {
  const previous = readLock(root)?.managed ?? {};
  const tools = options.tools ?? [];
  const plan = planSync(root, [...renderWorkspace(config, { root }), ...tools], previous, {
    unmanaged: config.unmanaged,
    ...options,
    carry: Object.keys(carriedTools(previous, options)),
    // Installs before OpenSpec files were managed have them without a lock entry.
    ownEdits: tools.map((f) => f.path),
  });
  // A modified or deleted vendored add-on file is a hash mismatch, not a user edit or
  // deletion to respect (§12): refused, or put back with `--restore` (audit G5).
  const vendored = (c: PlannedChange): boolean =>
    c.path.startsWith(`${PONYTAIL_DIR}/`) && !c.path.endsWith("/PRECEDENCE.md");
  const BROKEN: ReadonlySet<SyncAction> = new Set(["keep-user-edit", "conflict", "keep-deleted"]);
  const tampered = plan.filter((c) => vendored(c) && BROKEN.has(c.action));
  if (tampered.length > 0 && !options.restore) {
    throw new PreconditionError("Ponytail add-on files were modified (content hash mismatch)", [
      ...tampered.map((c) => (c.action === "keep-deleted" ? `${c.path} (deleted)` : c.path)),
      "restore them (`ai-factory update --restore`) or set addons.ponytail.enabled to false",
    ]);
  }
  const repaired = plan.map(
    (c): PlannedChange =>
      vendored(c) && BROKEN.has(c.action)
        ? { ...c, action: c.action === "keep-deleted" ? "create" : "overwrite" }
        : c,
  );
  const conflicts = repaired.filter((c) => c.action === "conflict").map((c) => c.path);
  if (conflicts.length > 0) {
    throw new PreconditionError("files already exist that ai-factory did not create", [
      ...conflicts,
      "move them away, list them under `unmanaged` in factory.config.jsonc, or rerun with --force",
    ]);
  }
  return repaired;
}

/** Renders managed files, writes them and the lock, and (re)installs hooks. */
export async function syncWorkspace(
  root: string,
  config: FactoryConfig,
  options: SyncOptions = {},
): Promise<SyncResult> {
  const previous = readLock(root)?.managed ?? {};
  const plan = planWorkspace(root, config, options);

  const executed = await executeSync(root, plan, previous, {
    ...(options.merge ? { merge: true } : {}),
  });
  const { merged, conflicts } = executed;
  const managed = { ...carriedTools(previous, options), ...executed.managed };
  const ponytail = config.addons.ponytail;
  const lock = buildLock(
    managed,
    ponytail.enabled
      ? {
          ponytail: {
            ref: ponytail.ref,
            contentSha256: PONYTAIL.contentSha256,
            files: [...PONYTAIL.files],
          },
        }
      : {},
  );
  writeFileSync(join(root, LOCK_FILE), serializeLock(lock));

  const hooks: SyncResult["hooks"] = [];
  for (const repo of config.repos) {
    hooks.push({ repo: repo.name, result: await installPrePush(join(root, repo.path)) });
  }
  return { plan, lock, hooks, merged, conflicts };
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
