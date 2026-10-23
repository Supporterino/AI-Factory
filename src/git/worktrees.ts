import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { git, gitOk } from "../exec.ts";
import { changeBranch, dirtyPaths, refExists } from "./repo.ts";

/**
 * One git worktree per task (§11, ADR-0002), created from the repo's own git dir, so
 * submodules work the same as a single repo. Commands, for a submodule at repos/backend:
 *
 *   git -C repos/backend worktree add -b change/<id>--<task> \
 *       <ws>/.factory/worktrees/<id>/backend/<task> change/<id>
 *   git -C repos/backend worktree remove <path>
 *   git -C repos/backend branch -d change/<id>--<task>
 */

/** Temporary task branch. `change/<id>/<task>` would collide with the ref `change/<id>`. */
export const taskBranch = (id: string, task: string): string => `${changeBranch(id)}--${task}`;

export const worktreePath = (root: string, id: string, repo: string, task: string): string =>
  join(root, ".factory", "worktrees", id, repo, task);

export interface TaskWorktree {
  readonly path: string;
  readonly branch: string;
  /** False when an existing worktree was reused (resume after a crash). */
  readonly created: boolean;
}

/** Creates (or reuses) the task's worktree off the current tip of `change/<id>`. */
export async function addTaskWorktree(
  root: string,
  repoDir: string,
  repoName: string,
  id: string,
  task: string,
): Promise<TaskWorktree> {
  const path = worktreePath(root, id, repoName, task);
  const branch = taskBranch(id, task);
  if (existsSync(join(path, ".git"))) return { path, branch, created: false };
  mkdirSync(dirname(path), { recursive: true });
  // A stale registration (worktree dir deleted by hand) would block `worktree add`.
  await gitOk(["worktree", "prune"], { cwd: repoDir });
  const args = (await refExists(repoDir, `refs/heads/${branch}`))
    ? ["worktree", "add", "-q", path, branch]
    : ["worktree", "add", "-q", "-b", branch, path, changeBranch(id)];
  await gitOk(args, { cwd: repoDir });
  return { path, branch, created: true };
}

/**
 * Removes a merged task's worktree and branch. Refuses (returns false) when the worktree
 * still has uncommitted changes, so nothing is lost.
 */
export async function removeTaskWorktree(
  repoDir: string,
  wt: Pick<TaskWorktree, "path" | "branch">,
): Promise<boolean> {
  if (existsSync(wt.path)) {
    if ((await dirtyPaths(wt.path)).length > 0) return false;
    await gitOk(["worktree", "remove", wt.path], { cwd: repoDir });
  }
  // -d (not -D): only deletes a branch that is merged into the current branch.
  const del = await git(["branch", "-q", "-d", wt.branch], { cwd: repoDir });
  return del.code === 0 || !(await refExists(repoDir, `refs/heads/${wt.branch}`));
}
