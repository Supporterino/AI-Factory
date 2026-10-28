import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { FactoryConfig, RepoConfig } from "../config/schema.ts";
import { PreconditionError } from "../errors.ts";
import { git, gitOk } from "../exec.ts";
import { trackedBranch } from "../git/branching.ts";
import { commitPaths } from "../git/commit.ts";
import {
  changeBranch,
  currentBranch,
  dirtyPaths,
  ensureClean,
  refExists,
  revParse,
} from "../git/repo.ts";
import { driverAlive, readActive, releaseActive } from "../state/active.ts";
import { factoryDir } from "../state/files.ts";
import { loadRun, type RunState } from "../state/run.ts";
import { dropAgentSnapshot } from "../update/snapshot.ts";

export type LandMergeStatus = "already-merged" | "fast-forward" | "merge" | "missing";

export interface LandRepoResult {
  readonly repo: string;
  readonly path: string;
  readonly target: string;
  readonly branch: string;
  readonly status: LandMergeStatus;
  readonly commit?: string;
}

export interface LandOutcome {
  readonly id: string;
  readonly dryRun: boolean;
  readonly repos: readonly LandRepoResult[];
  readonly pointerCommit?: string;
  readonly deletedBranches: readonly string[];
  readonly keptBranches: readonly string[];
  readonly cleaned: readonly string[];
  readonly kept: readonly string[];
}

export interface LandOptions {
  readonly dryRun?: boolean;
}

const refs = {
  local: (branch: string): string => `refs/heads/${branch}`,
  remote: (branch: string): string => `refs/remotes/origin/${branch}`,
};

const isAncestor = async (dir: string, ancestor: string, descendant: string): Promise<boolean> =>
  (await git(["merge-base", "--is-ancestor", ancestor, descendant], { cwd: dir })).code === 0;

const branchTip = async (dir: string, branch: string): Promise<string | undefined> => {
  if (!(await refExists(dir, refs.local(branch)))) return undefined;
  return revParse(dir, refs.local(branch));
};

const targetRef = async (dir: string, branch: string): Promise<string | undefined> => {
  if (await refExists(dir, refs.local(branch))) return refs.local(branch);
  if (await refExists(dir, refs.remote(branch))) return refs.remote(branch);
  return undefined;
};

/** Switch a checkout to its base branch, creating the local branch from origin if needed. */
async function switchToTarget(dir: string, branch: string): Promise<void> {
  if ((await currentBranch(dir)) === branch) return;
  if (await refExists(dir, refs.local(branch))) {
    await gitOk(["switch", "-q", branch], { cwd: dir });
    return;
  }
  if (await refExists(dir, refs.remote(branch))) {
    await gitOk(["switch", "-q", "-c", branch, refs.remote(branch)], { cwd: dir });
    return;
  }
  throw new PreconditionError(`base branch ${branch} not found in ${dir}`, [
    "fetch it, or set defaultBranch on the repo in factory.config.jsonc",
  ]);
}

async function rejectionFiles(dir: string): Promise<string[]> {
  const out = await gitOk(["diff", "--name-only", "--diff-filter=U"], { cwd: dir });
  return out === "" ? [] : out.split("\n");
}

async function mergeBranch(
  dir: string,
  target: string,
  source: string,
  subject: string,
): Promise<{ status: LandMergeStatus; commit?: string }> {
  const tip = await branchTip(dir, source);
  if (tip === undefined) return { status: "missing" };
  await switchToTarget(dir, target);
  const before = await revParse(dir, "HEAD");
  if (tip === before || (await isAncestor(dir, tip, before))) return { status: "already-merged" };
  const merged = await git(["merge", "--no-edit", "--no-verify", "-m", subject, source], {
    cwd: dir,
    env: { GIT_EDITOR: "true", GIT_MERGE_AUTOEDIT: "no" },
  });
  if (merged.code !== 0) {
    const files = await rejectionFiles(dir);
    await git(["merge", "--abort"], { cwd: dir });
    throw new PreconditionError(`merging ${source} into ${target} conflicted in ${dir}`, [
      ...files,
      "the merge was aborted; nothing was changed in this repo",
    ]);
  }
  const after = await revParse(dir, "HEAD");
  return { status: after === tip ? "fast-forward" : "merge", commit: after };
}

async function dryRunMerge(
  dir: string,
  target: string,
  source: string,
): Promise<{ status: LandMergeStatus }> {
  const tip = await branchTip(dir, source);
  if (tip === undefined) return { status: "missing" };
  const ref = await targetRef(dir, target);
  if (ref === undefined)
    throw new PreconditionError(`base branch ${target} not found in ${dir}`, [
      "fetch it, or set defaultBranch on the repo in factory.config.jsonc",
    ]);
  const targetTip = await revParse(dir, ref);
  if (tip === targetTip || (await isAncestor(dir, tip, targetTip)))
    return { status: "already-merged" };
  return { status: (await isAncestor(dir, targetTip, tip)) ? "fast-forward" : "merge" };
}

function reposFor(config: FactoryConfig, run: RunState): RepoConfig[] {
  const names = new Set([...run.tasks.map((task) => task.repo), ...Object.keys(run.branches)]);
  const touched = config.repos.filter((repo) => repo.path !== "." && names.has(repo.name));
  const ai = config.repos.find((repo) => repo.path === ".");
  return [...touched, ...(ai === undefined ? [] : [ai])];
}

async function baseBranch(root: string, repo: RepoConfig): Promise<string> {
  const tracked = repo.path === "." ? undefined : await trackedBranch(root, repo.path);
  return tracked ?? repo.defaultBranch ?? "main";
}

interface WorktreeEntry {
  readonly repo: string;
  readonly path: string;
}

/** Task worktrees still present under `.factory/worktrees/<id>`, including stale directories. */
function worktreeEntries(root: string, id: string): WorktreeEntry[] {
  const dir = factoryDir(root, "worktrees", id);
  if (!existsSync(dir)) return [];
  const entries: WorktreeEntry[] = [];
  for (const repo of readdirSync(dir)) {
    if (repo === ".opencode") continue;
    const repoDir = join(dir, repo);
    let tasks: string[];
    try {
      tasks = readdirSync(repoDir);
    } catch {
      continue;
    }
    for (const task of tasks) {
      const path = join(repoDir, task);
      if (existsSync(path)) entries.push({ repo, path });
    }
  }
  return entries;
}

async function assertCleanWorktrees(root: string, id: string): Promise<void> {
  const dirty: string[] = [];
  for (const entry of worktreeEntries(root, id)) {
    if (!existsSync(join(entry.path, ".git"))) continue;
    const paths = await dirtyPaths(entry.path);
    if (paths.length > 0)
      dirty.push(`${entry.path} (${paths.length} change${paths.length === 1 ? "" : "s"})`);
  }
  const draft = factoryDir(root, "drafts", id);
  if (existsSync(join(draft, ".git"))) {
    const paths = await dirtyPaths(draft);
    if (paths.length > 0)
      dirty.push(`${draft} (${paths.length} change${paths.length === 1 ? "" : "s"})`);
  }
  if (dirty.length > 0)
    throw new PreconditionError(`the change's worktrees have uncommitted changes`, [
      ...dirty,
      "commit, stash or remove them before `land`",
    ]);
}

async function removeWorktrees(
  root: string,
  id: string,
  config: FactoryConfig,
): Promise<{ cleaned: string[]; kept: string[] }> {
  const cleaned: string[] = [];
  const kept: string[] = [];
  for (const entry of worktreeEntries(root, id)) {
    const repo = config.repos.find((candidate) => candidate.name === entry.repo);
    if (repo !== undefined) {
      const dir = join(root, repo.path);
      if (existsSync(join(entry.path, ".git"))) {
        const removed = await git(["worktree", "remove", entry.path], { cwd: dir });
        if (removed.code !== 0) {
          kept.push(entry.path);
          continue;
        }
      }
      await git(["worktree", "prune"], { cwd: dir });
    }
    if (existsSync(entry.path)) rmSync(entry.path, { recursive: true, force: true });
  }
  const draft = factoryDir(root, "drafts", id);
  if (existsSync(draft)) {
    if (existsSync(join(draft, ".git"))) {
      const removed = await git(["worktree", "remove", draft], { cwd: root });
      if (removed.code !== 0) {
        kept.push(`.factory/drafts/${id}`);
      } else {
        await git(["worktree", "prune"], { cwd: root });
        rmSync(draft, { recursive: true, force: true });
        cleaned.push(`.factory/drafts/${id}`);
      }
    } else {
      rmSync(draft, { recursive: true, force: true });
      cleaned.push(`.factory/drafts/${id}`);
    }
  }
  const dir = factoryDir(root, "worktrees", id);
  if (kept.length === 0 && existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
    cleaned.push(`.factory/worktrees/${id}`);
  }
  return { cleaned, kept };
}

async function deleteBranch(dir: string, branch: string): Promise<boolean> {
  if (!(await refExists(dir, refs.local(branch)))) return true;
  // -d also compares with an upstream branch, which change branches do not use. The
  // ancestor check is the real safety net; then -D is safe.
  if (!(await isAncestor(dir, branch, "HEAD"))) return false;
  const deleted = await git(["branch", "-D", branch], { cwd: dir });
  return deleted.code === 0;
}

async function taskBranches(dir: string, id: string): Promise<string[]> {
  const out = await gitOk(
    ["branch", "--format=%(refname:short)", "--list", `${changeBranch(id)}--*`],
    { cwd: dir },
  );
  return out.split("\n").filter(Boolean);
}

async function deleteBranches(
  root: string,
  id: string,
  repos: readonly RepoConfig[],
): Promise<{ deleted: string[]; kept: string[] }> {
  const deleted: string[] = [];
  const kept: string[] = [];
  for (const repo of repos) {
    const dir = join(root, repo.path);
    for (const branch of await taskBranches(dir, id)) {
      if (await deleteBranch(dir, branch)) deleted.push(`${repo.name}:${branch}`);
      else kept.push(`${repo.name}:${branch}`);
    }
    if (await deleteBranch(dir, changeBranch(id))) deleted.push(`${repo.name}:${changeBranch(id)}`);
    else if (await refExists(dir, refs.local(changeBranch(id))))
      kept.push(`${repo.name}:${changeBranch(id)}`);
  }
  return { deleted, kept };
}

function removePath(root: string, path: string): boolean {
  const abs = join(root, path);
  if (!existsSync(abs)) return false;
  rmSync(abs, { recursive: true, force: true });
  return true;
}

/** Session context files are named by opencode session id; the body names the change. */
function removeSessions(root: string, id: string): string[] {
  const dir = factoryDir(root, "sessions");
  if (!existsSync(dir)) return [];
  const removed: string[] = [];
  for (const name of readdirSync(dir).filter((entry) => entry.endsWith(".json"))) {
    try {
      const context = JSON.parse(readFileSync(join(dir, name), "utf8")) as {
        changeId?: unknown;
      };
      if (context.changeId !== id) continue;
      rmSync(join(dir, name), { force: true });
      removed.push(`.factory/sessions/${name}`);
    } catch {
      // Never let a corrupt session file block cleanup of the change.
    }
  }
  return removed;
}

/**
 * Land a finished change: merge its change branches into the base branches, update submodule
 * pointers, delete local branches and remove ephemeral state. Reports, usage ledgers and logs
 * are kept. On any branch that cannot be deleted, the run and approval stay so `land` can be
 * retried.
 */
export async function landChange(
  root: string,
  config: FactoryConfig,
  id: string,
  options: LandOptions = {},
): Promise<LandOutcome> {
  const dryRun = options.dryRun === true;
  const run = loadRun(root, id);
  if (run === undefined) throw new PreconditionError(`no change ${id} in this workspace`);
  if (run.phase !== "done")
    throw new PreconditionError(`cannot land ${id}: the change is ${run.phase}, not done`, [
      `finish it first (for example \`ai-factory resume ${id}\`)`,
    ]);

  const active = readActive(root);
  if (active !== undefined && active.changeId !== id)
    throw new PreconditionError(`${active.changeId} is the active change; cannot land ${id}`, [
      "finish or abort the active change first",
    ]);
  if (active !== undefined && driverAlive(active))
    throw new PreconditionError(`${id} is still being driven by pid ${active.pid}; cannot land`);

  const repos = reposFor(config, run);
  if (repos.length === 0) throw new PreconditionError(`no repos found for ${id}`);
  for (const repo of repos) {
    const dir = join(root, repo.path);
    await ensureClean(dir, repo.path === "." ? "the AI repo" : `submodule ${repo.path}`);
    if (await inProgress(dir))
      throw new PreconditionError(`${dir} has a merge or rebase in progress`, [
        "finish or abort it first",
      ]);
  }
  await assertCleanWorktrees(root, id);

  const results: LandRepoResult[] = [];
  const ai = repos.find((repo) => repo.path === ".");
  const submodules = repos.filter((repo) => repo.path !== ".");
  const branch = changeBranch(id);

  // The pointer update belongs on the AI change branch, before it is merged. Move there
  // first: merging a submodule can already make the superproject's gitlinks dirty.
  if (
    !dryRun &&
    config.layout === "submodules" &&
    ai !== undefined &&
    (await refExists(root, refs.local(branch))) &&
    (await currentBranch(root)) !== branch
  ) {
    await gitOk(["switch", "-q", branch], { cwd: root });
  }

  for (const repo of submodules) {
    const dir = join(root, repo.path);
    const target = await baseBranch(root, repo);
    if (dryRun) {
      results.push({
        repo: repo.name,
        path: repo.path,
        target,
        branch,
        ...(await dryRunMerge(dir, target, branch)),
      });
    } else {
      results.push({
        repo: repo.name,
        path: repo.path,
        target,
        branch,
        ...(await mergeBranch(dir, target, branch, `chore(change): land ${id}`)),
      });
    }
  }

  let pointerCommit: string | undefined;
  if (
    !dryRun &&
    config.layout === "submodules" &&
    submodules.length > 0 &&
    ai !== undefined &&
    (await refExists(root, refs.local(branch)))
  ) {
    // A merged submodule may point at a merge commit rather than the change tip.
    pointerCommit = await commitPaths(
      root,
      submodules.map((repo) => repo.path),
      `chore(submodules): point to landed ${id}`,
      { "Change-Id": id },
    );
  }

  if (ai !== undefined) {
    const target = await baseBranch(root, ai);
    results.push({
      repo: ai.name,
      path: ai.path,
      target,
      branch,
      ...(dryRun
        ? await dryRunMerge(root, target, branch)
        : await mergeBranch(root, target, branch, `chore(change): land ${id}`)),
    });
  }

  if (dryRun) {
    const cleaned = [
      `.factory/worktrees/${id}`,
      `.factory/context/${id}`,
      `.factory/drafts/${id}`,
      `.factory/approvals/${id}.json`,
      `.factory/runs/${id}.json`,
      `.factory/runs/${id}`,
      `.factory/sessions/ (this change)`,
      `.factory/reports/${id}-paused.md`,
    ];
    return {
      id,
      dryRun,
      repos: results,
      deletedBranches: [],
      keptBranches: [],
      cleaned,
      kept: [`.factory/reports/${id}.md`, `.factory/usage/${id}.json`, `.factory/logs/${id}`],
    };
  }

  const worktrees = await removeWorktrees(root, id, config);
  dropAgentSnapshot(root, id);
  const branches = await deleteBranches(root, id, repos);

  const cleaned = [...worktrees.cleaned, ...removeSessions(root, id)];
  for (const path of [`.factory/context/${id}`, `.factory/reports/${id}-paused.md`])
    if (removePath(root, path)) cleaned.push(path);
  const incomplete = branches.kept.length > 0 || worktrees.kept.length > 0;
  // Keep the run and approval when cleanup was incomplete, so `land` can be retried.
  if (!incomplete) {
    for (const path of [
      `.factory/runs/${id}.json`,
      `.factory/runs/${id}`,
      `.factory/approvals/${id}.json`,
    ])
      if (removePath(root, path)) cleaned.push(path);
  }
  if (active !== undefined) await releaseActive(root, id);

  return {
    id,
    dryRun,
    repos: results,
    ...(pointerCommit === undefined ? {} : { pointerCommit }),
    deletedBranches: branches.deleted,
    keptBranches: branches.kept,
    cleaned,
    kept: [
      `.factory/reports/${id}.md`,
      `.factory/usage/${id}.json`,
      `.factory/logs/${id}`,
      ...worktrees.kept,
      ...(incomplete ? [`.factory/runs/${id}.json`, `.factory/approvals/${id}.json`] : []),
    ],
  };
}

const inProgress = async (dir: string): Promise<boolean> => {
  if ((await git(["rev-parse", "--verify", "--quiet", "MERGE_HEAD"], { cwd: dir })).code === 0)
    return true;
  for (const name of ["rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "REVERT_HEAD"]) {
    const path = (await git(["rev-parse", "--git-path", name], { cwd: dir })).stdout.trim();
    if (path !== "" && (existsSync(path) || existsSync(join(dir, path)))) return true;
  }
  return false;
};
