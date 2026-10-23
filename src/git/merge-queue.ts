import { git, gitOk } from "../exec.ts";
import { changeBranch, currentBranch } from "./repo.ts";
import { removeTaskWorktree, type TaskWorktree } from "./worktrees.ts";

/**
 * Per-repo merge queue (§11, ADR-0002): one task at a time per repo, rebased onto the latest
 * `change/<id>`, gated again, then fast-forwarded. Different repos merge in parallel.
 */

const NON_INTERACTIVE = { GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true" } as const;

export type RebaseResult = { ok: true } | { ok: false; conflicts: string[] };

async function conflictedFiles(worktree: string): Promise<string[]> {
  const out = await gitOk(["diff", "--name-only", "--diff-filter=U"], { cwd: worktree });
  return out === "" ? [] : out.split("\n");
}

async function rebaseInProgress(worktree: string): Promise<boolean> {
  const res = await git(["rev-parse", "--verify", "--quiet", "REBASE_HEAD"], { cwd: worktree });
  return res.code === 0;
}

/** Rebases the task branch onto `onto`. On conflict the rebase stays in progress for resolution. */
export async function rebaseOnto(worktree: string, onto: string): Promise<RebaseResult> {
  const res = await git(["rebase", "-q", onto], { cwd: worktree, env: NON_INTERACTIVE });
  if (res.code === 0) return { ok: true };
  if (await rebaseInProgress(worktree))
    return { ok: false, conflicts: await conflictedFiles(worktree) };
  throw new Error(`git rebase ${onto} failed: ${res.stderr.trim()}`);
}

/** After an agent resolved conflicts: stage and continue. Further conflicts are reported. */
export async function continueRebase(worktree: string): Promise<RebaseResult> {
  await gitOk(["add", "-A"], { cwd: worktree });
  const res = await git(["rebase", "--continue"], { cwd: worktree, env: NON_INTERACTIVE });
  if (res.code === 0) return { ok: true };
  if (await rebaseInProgress(worktree))
    return { ok: false, conflicts: await conflictedFiles(worktree) };
  throw new Error(`git rebase --continue failed: ${res.stderr.trim()}`);
}

export async function abortRebase(worktree: string): Promise<void> {
  if (await rebaseInProgress(worktree)) await gitOk(["rebase", "--abort"], { cwd: worktree });
}

/** Fast-forwards `change/<id>` in the repo checkout to the task branch. */
export async function fastForward(repoDir: string, id: string, branch: string): Promise<string> {
  const target = changeBranch(id);
  if ((await currentBranch(repoDir)) !== target) {
    throw new Error(`${repoDir} is not on ${target}; cannot merge ${branch}`);
  }
  await gitOk(["merge", "-q", "--ff-only", branch], { cwd: repoDir });
  return gitOk(["rev-parse", "HEAD"], { cwd: repoDir });
}

export type MergeOutcome =
  | { status: "merged"; head: string }
  /** Rebase conflict left in progress; the caller may resolve and call `mergeTask` again. */
  | { status: "conflict"; conflicts: string[] }
  /** Gates failed after the rebase; the rebased branch stays for another attempt. */
  | { status: "gates-failed" };

export interface MergeTaskInput {
  readonly repoDir: string;
  readonly id: string;
  readonly worktree: TaskWorktree;
  /** Re-runs the task gates in the rebased worktree. */
  readonly regate: (worktree: string) => Promise<boolean>;
}

/**
 * Rebase → gates → fast-forward → remove worktree. Call through `MergeQueue.run` so tasks of
 * one repo never merge concurrently. If a rebase is already in progress (an agent resolved
 * the conflict), it is continued instead of started.
 */
export async function mergeTask(input: MergeTaskInput): Promise<MergeOutcome> {
  const wt = input.worktree.path;
  const rebased = (await rebaseInProgress(wt))
    ? await continueRebase(wt)
    : await rebaseOnto(wt, changeBranch(input.id));
  if (!rebased.ok) return { status: "conflict", conflicts: rebased.conflicts };
  if (!(await input.regate(wt))) return { status: "gates-failed" };
  const head = await fastForward(input.repoDir, input.id, input.worktree.branch);
  await removeTaskWorktree(input.repoDir, input.worktree);
  return { status: "merged", head };
}

/** FIFO serialisation per key (repo name). Work for different keys runs concurrently. */
export class MergeQueue {
  readonly #tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    const next = previous.then(work, work);
    // Keep the chain alive even when a job fails; the caller still sees the rejection.
    this.#tails.set(
      key,
      next.catch(() => undefined),
    );
    return next;
  }
}
