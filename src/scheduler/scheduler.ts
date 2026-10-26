import { TransientError } from "../errors.ts";
import { MergeQueue } from "../git/merge-queue.ts";
import { loadRun, type RunState, recordTask, type TaskState, updateRun } from "../state/run.ts";
import { dependentsOf } from "../tasks/dag.ts";
import { touchesOverlap } from "../tasks/glob.ts";
import { Semaphore } from "../util/semaphore.ts";

/**
 * The task scheduler (§11): deterministic CLI code, not an LLM. It runs the task DAG with at
 * most `maxAgents` agent sessions, never runs two tasks with overlapping `touches` in the
 * same repo at once, merges through a per-repo queue, enforces the retry budget, isolates
 * failures to dependents, and persists every transition so a crash or abort can resume.
 */

export interface AttemptContext {
  readonly signal: AbortSignal;
  /** Compacted gate output of the previous failed attempt, if any. */
  readonly feedback?: string;
  /** 1 for the first attempt. */
  readonly attempt: number;
}

export type AttemptResult =
  | { status: "passed"; commit?: string }
  | { status: "gate-failed"; output: string }
  /** The agent cannot finish within its scope; a human must look. Not retried. */
  | { status: "blocked"; reason: string }
  | { status: "error"; reason: string }
  /**
   * Infrastructure failed (agent server down, rate-limited too long, dependency install):
   * retried without spending the budget; the change pauses after repeats.
   */
  | { status: "transient"; reason: string };

/** Consecutive infrastructure failures after which the change pauses instead of looping. */
const MAX_TRANSIENT = 3;

export type MergeResult =
  | { status: "merged"; commit: string }
  | { status: "conflict"; conflicts: string[] }
  | { status: "gates-failed"; output: string };

/** The side-effecting work per task; the pipeline provides the real one, tests a fake. */
export interface TaskRunner {
  /** One implementation attempt: agent session, gates and the task commit in its worktree. */
  attempt(task: TaskState, ctx: AttemptContext): Promise<AttemptResult>;
  /** Rebase, re-gate and fast-forward the task (idempotent if already merged). */
  merge(task: TaskState): Promise<MergeResult>;
  /** The implementer's one attempt to resolve a rebase conflict. */
  resolveConflict(
    task: TaskState,
    conflicts: readonly string[],
    signal: AbortSignal,
  ): Promise<boolean>;
  /** Drops the task's worktree and branch so it starts over from the latest change tip. */
  reset(task: TaskState): Promise<void>;
  /** Runs after each merge, one at a time, in merge order (graph update). */
  afterMerge?(task: TaskState, mergeSeq: number): Promise<void>;
}

export interface SchedulerOptions {
  readonly root: string;
  readonly id: string;
  readonly maxAgents: number;
  readonly maxRetries: number;
  /** Repos whose tasks must never run concurrently (`withinRepo: "serial"`). */
  readonly serialRepos?: readonly string[];
  readonly runner: TaskRunner;
  /** External stop (signal handler). `abortRequested` in the run state is polled too. */
  readonly signal?: AbortSignal;
}

export interface RunSummary {
  readonly status: "complete" | "paused" | "aborted";
  readonly merged: string[];
  readonly failed: string[];
  readonly cancelled: string[];
  readonly pending: string[];
}

const TERMINAL = new Set(["merged", "failed", "cancelled"]);

/** Puts a failed task back in the queue with a fresh budget and un-cancels its dependents. */
export function retryTask(draft: RunState, taskId: string): void {
  const task = draft.tasks.find((t) => t.id === taskId);
  if (task === undefined) throw new Error(`no task ${taskId}`);
  task.status = "pending";
  task.failures = 0;
  delete task.lastError;
  recordTask(task, "retry", "budget reset by a human");
  for (const t of draft.tasks) if (t.status === "cancelled") t.status = "pending";
  for (const failed of draft.tasks.filter((t) => t.status === "failed")) {
    for (const dep of dependentsOf(draft.tasks, failed.id)) {
      const t = draft.tasks.find((x) => x.id === dep);
      if (t && t.status === "pending") t.status = "cancelled";
    }
  }
}

export class Scheduler {
  readonly #opts: SchedulerOptions;
  readonly #agents: Semaphore;
  readonly #merges = new MergeQueue();
  #afterMergeChain: Promise<void> = Promise.resolve();
  readonly #abort = new AbortController();
  /** Tasks dispatched and not yet settled (pending on a slot, running, or merging). */
  readonly #inFlight = new Map<string, Promise<void>>();
  #state!: RunState;
  #wake: () => void = () => {};
  /** Consecutive infrastructure failures, and the reason once dispatch stopped for them. */
  #transient = 0;
  #halted: string | undefined;

  constructor(opts: SchedulerOptions) {
    this.#opts = opts;
    this.#agents = new Semaphore(opts.maxAgents);
    opts.signal?.addEventListener("abort", () => this.#abort.abort(), { once: true });
  }

  async #update(mutate: (draft: RunState) => void): Promise<RunState> {
    this.#state = await updateRun(this.#opts.root, this.#opts.id, mutate);
    return this.#state;
  }

  #task(id: string): TaskState {
    const task = this.#state.tasks.find((t) => t.id === id);
    if (task === undefined) throw new Error(`no task ${id}`);
    return task;
  }

  async #mutateTask(id: string, mutate: (task: TaskState) => void): Promise<TaskState> {
    await this.#update((draft) => {
      const task = draft.tasks.find((t) => t.id === id);
      if (task) mutate(task);
    });
    return this.#task(id);
  }

  /** Whether `task` may start now, given what is in flight. */
  #canStart(task: TaskState): boolean {
    if (task.status !== "pending" || this.#inFlight.has(task.id)) return false;
    const done = (dep: string): boolean =>
      this.#state.tasks.find((t) => t.id === dep)?.status === "merged";
    if (!task.deps.every(done)) return false;
    const serialRepo = this.#opts.serialRepos?.includes(task.repo) ?? false;
    const busy = [...this.#inFlight.keys()]
      .map((id) => this.#task(id))
      .filter((t) => t.repo === task.repo);
    if (task.serial || serialRepo) return busy.length === 0;
    if (busy.some((t) => t.serial || touchesOverlap(t.touches, task.touches))) return false;
    // A waiting serial task in the repo goes first, so it cannot starve.
    const serialWaiting = this.#state.tasks.some(
      (t) => t.repo === task.repo && t.serial && t.status === "pending" && t.deps.every(done),
    );
    return !serialWaiting;
  }

  async #fail(id: string, reason: string): Promise<void> {
    await this.#update((draft) => {
      const task = draft.tasks.find((t) => t.id === id);
      if (task === undefined) return;
      task.status = "failed";
      task.lastError = reason;
      recordTask(task, "failed", reason);
      for (const depId of dependentsOf(draft.tasks, id)) {
        const dep = draft.tasks.find((t) => t.id === depId);
        if (dep && !TERMINAL.has(dep.status)) {
          dep.status = "cancelled";
          recordTask(dep, "cancelled", `dependency ${id} failed`);
        }
      }
    });
  }

  /** Counts one failure against the budget; true when the task may try again. */
  async #spend(id: string, event: string, output?: string): Promise<boolean> {
    const task = await this.#mutateTask(id, (t) => {
      t.failures += 1;
      if (output !== undefined) t.lastGateOutput = output;
      recordTask(t, event, `failure ${t.failures} of ${this.#opts.maxRetries + 1} allowed`);
    });
    if (task.failures > this.#opts.maxRetries) {
      await this.#fail(id, `${event}; retry budget (${this.#opts.maxRetries}) exhausted`);
      return false;
    }
    return true;
  }

  /** Back to pending after an interrupt; the task resumes where it stopped. */
  async #interrupted(id: string): Promise<void> {
    await this.#mutateTask(id, (t) => {
      t.status = "pending";
      recordTask(t, "interrupted");
    });
  }

  /** Drops the task's work and queues it to run alone in its repo from the latest tip. */
  async #requeueSerially(id: string, reason: string): Promise<void> {
    await this.#opts.runner.reset(this.#task(id));
    await this.#mutateTask(id, (t) => {
      t.status = "pending";
      t.serial = true;
      t.gatesPassed = false;
      t.installed = false;
      delete t.worktree;
      delete t.branch;
      recordTask(t, "requeued serially", reason);
    });
  }

  /** Checks the run state for an abort another process requested (`ai-factory abort`). */
  #abortRequested(): boolean {
    if (!this.#aborted() && loadRun(this.#opts.root, this.#opts.id)?.abortRequested)
      this.#abort.abort();
    return this.#aborted();
  }

  #aborted(): boolean {
    return this.#abort.signal.aborted;
  }

  async #process(id: string): Promise<void> {
    const runner = this.#opts.runner;
    const signal = this.#abort.signal;
    for (;;) {
      // Implementation attempts until the task passes its gates (a resumed task that already
      // passed goes straight to the merge, audit P8).
      let passed = this.#task(id).gatesPassed;
      while (!passed) {
        if (this.#aborted()) return;
        const result = await this.#agents.run(async () => {
          // Tasks waiting for a slot must see an abort requested meanwhile.
          if (this.#abortRequested()) return undefined;
          const task = await this.#mutateTask(id, (t) => {
            t.status = "running";
            t.gatesPassed = false;
            recordTask(t, "attempt", `attempt ${t.failures + 1}`);
          });
          try {
            return await runner.attempt(task, {
              signal,
              attempt: task.failures + 1,
              ...(task.lastGateOutput === undefined ? {} : { feedback: task.lastGateOutput }),
            });
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            return err instanceof TransientError
              ? ({ status: "transient", reason: `the agent runtime failed (${reason})` } as const)
              : ({ status: "error", reason } as const);
          }
        });
        if (result === undefined || this.#aborted()) return this.#interrupted(id);
        if (result.status === "transient") {
          // Not the task's fault: back to pending, budget untouched; stop after repeats.
          this.#transient++;
          await this.#mutateTask(id, (t) => {
            t.status = "pending";
            recordTask(t, "infrastructure failed", result.reason);
          });
          if (this.#transient >= MAX_TRANSIENT) {
            this.#halted ??= result.reason;
            return;
          }
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }
        if (result.status === "passed") {
          passed = true;
          this.#transient = 0;
          await this.#mutateTask(id, (t) => {
            if (result.commit) t.commit = result.commit;
            t.gatesPassed = true;
            delete t.lastGateOutput;
            recordTask(t, "gates passed", result.commit);
          });
        } else if (result.status === "blocked") {
          await this.#fail(id, `blocked: ${result.reason}`);
          return;
        } else {
          const output = result.status === "gate-failed" ? result.output : result.reason;
          if (!(await this.#spend(id, result.status, output))) return;
        }
      }

      // Merge through the repo's queue; conflicts get one resolution attempt.
      let resolvedOnce = false;
      for (;;) {
        await this.#mutateTask(id, (t) => {
          t.status = "merging";
        });
        const task = this.#task(id);
        const merge = await this.#merges.run(task.repo, () => runner.merge(task));
        if (merge.status === "merged") {
          const seq = (
            await this.#update((draft) => {
              draft.mergeSeq += 1;
              const t = draft.tasks.find((x) => x.id === id);
              if (t) {
                t.status = "merged";
                t.commit = merge.commit;
                t.mergeSeq = draft.mergeSeq;
                recordTask(t, "merged", merge.commit);
              }
            })
          ).mergeSeq;
          if (runner.afterMerge) {
            const merged = this.#task(id);
            this.#afterMergeChain = this.#afterMergeChain.then(() =>
              runner.afterMerge?.(merged, seq),
            );
            await this.#afterMergeChain;
          }
          return;
        }
        // An interrupt kills the re-gate or the rebase: nothing is spent, the work stays
        // (audit P7). The resumed task merges again.
        if (this.#aborted()) return this.#interrupted(id);
        if (merge.status === "gates-failed") {
          await this.#mutateTask(id, (t) => {
            t.gatesPassed = false;
          });
          if (!(await this.#spend(id, "gates failed after rebase", merge.output))) return;
          break; // back to implementation attempts in the rebased worktree
        }
        // Conflict.
        if (this.#task(id).serial || resolvedOnce) {
          if (this.#task(id).serial) {
            await this.#fail(
              id,
              `merge conflict while running serially: ${merge.conflicts.join(", ")}`,
            );
            return;
          }
          // The one resolution attempt did not work: start over, alone in the repo.
          await this.#requeueSerially(id, "conflict still unresolved after one attempt");
          return;
        }
        if (!(await this.#spend(id, "merge conflict", `conflicts: ${merge.conflicts.join(", ")}`)))
          return;
        resolvedOnce = true;
        const resolved = await this.#agents.run(() =>
          runner.resolveConflict(this.#task(id), merge.conflicts, signal).catch(() => false),
        );
        if (this.#aborted()) {
          // The interrupted resolution is not the task's failure: refund it, keep the branch.
          await this.#mutateTask(id, (t) => {
            t.failures = Math.max(0, t.failures - 1);
          });
          return this.#interrupted(id);
        }
        if (!resolved) {
          await this.#requeueSerially(id, "conflict resolution failed");
          return;
        }
      }
    }
  }

  #dispatch(): void {
    if (this.#halted !== undefined) return;
    for (const task of this.#state.tasks) {
      if (this.#aborted()) return;
      if (!this.#canStart(task)) continue;
      const work = this.#process(task.id)
        .catch(async (err: unknown) => {
          await this.#fail(
            task.id,
            `internal error: ${err instanceof Error ? err.message : String(err)}`,
          );
        })
        .finally(() => {
          this.#inFlight.delete(task.id);
          this.#wake();
        });
      this.#inFlight.set(task.id, work);
    }
  }

  /** Crash recovery: interrupted work goes back to pending, merges are retried. */
  async #recover(): Promise<void> {
    await this.#update((draft) => {
      draft.phase = "implementing";
      delete draft.pausedReason;
      for (const t of draft.tasks) {
        if (t.status === "running") {
          t.status = "pending";
          recordTask(t, "recovered", "was running when the previous run stopped");
        }
        if (t.status === "merging") {
          // Its gates passed; the merge is idempotent, so it resumes there (audit P8).
          t.status = "pending";
          t.gatesPassed = true;
          recordTask(t, "recovered", "was merging when the previous run stopped");
        }
      }
    });
  }

  async run(): Promise<RunSummary> {
    const loaded = loadRun(this.#opts.root, this.#opts.id);
    if (loaded === undefined) throw new Error(`no run state for ${this.#opts.id}`);
    this.#state = loaded;
    await this.#recover();

    for (;;) {
      if (!this.#abortRequested()) {
        const fresh = loadRun(this.#opts.root, this.#opts.id);
        if (fresh) this.#state = fresh;
        this.#dispatch();
      }
      if (this.#inFlight.size === 0) break;
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
        // Poll for an external abort even while every task is busy.
        setTimeout(resolve, 1000);
      });
    }

    const tasks = this.#state.tasks;
    const ids = (status: TaskState["status"]) =>
      tasks.filter((t) => t.status === status).map((t) => t.id);
    const summary: RunSummary = {
      status: this.#aborted()
        ? "aborted"
        : ids("merged").length === tasks.length
          ? "complete"
          : "paused",
      merged: ids("merged"),
      failed: ids("failed"),
      cancelled: ids("cancelled"),
      pending: ids("pending"),
    };
    if (summary.status === "paused") {
      await this.#update((draft) => {
        draft.phase = "paused";
        draft.pausedReason =
          this.#halted !== undefined
            ? `${this.#halted}, ${MAX_TRANSIENT} times in a row; fix it and resume (no retry budget was spent)`
            : `failed: ${summary.failed.join(", ") || "none"}; cancelled: ${summary.cancelled.join(", ") || "none"}`;
      });
    }
    return summary;
  }
}
