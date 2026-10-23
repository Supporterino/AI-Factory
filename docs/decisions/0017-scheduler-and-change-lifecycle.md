# ADR-0017: Scheduler semantics and the change lifecycle

**Decision.**
- **Run state.** `.factory/runs/<id>.json` is zod-validated, written atomically (temp file + rename), and every read-modify-write holds `<file>.lock` (`O_EXCL`; broken when the owner pid died or after 60 s). The scheduler re-reads the file before each dispatch, so writes from other processes (`abort`, `retry`) are never lost.
- **Task states:** `pending → running → merging → merged`, or `failed` / `cancelled`. Waiting on dependencies is derived, not stored.
- **Concurrency.**
  - At most `maxAgents` agent calls (attempts and conflict resolutions) run at once.
  - A task is _in flight_ from dispatch until it merges or fails. Two in-flight tasks in one repo never have overlapping `touches`.
  - The exclusion lasts through the merge, so the second task starts from a tip that contains the first.
  - Overlap is a conservative glob test: it serialises when in doubt.
- **Retry budget.** These count as failures: gate failures (including after a rebase), merge-conflict resolution attempts, and runner errors (an agent session that crashed). That keeps infrastructure failures from looping forever. Rate-limit waits and installs never count. A task fails when its failures exceed `gates.maxRetries` (3 retries after the first attempt). `blocked` (the agent cannot finish within its scope) fails at once.
- **Conflicts.**
  - The first conflict counts against the budget and gets one resolution attempt.
  - If that does not work, the task's worktree and branch are dropped and it is requeued as **serial**: it runs from scratch, alone in its repo, and blocks other tasks there while it waits, so it cannot starve.
  - A conflict while serial fails the task.
- **Failure isolation.** A failed task cancels only its transitive dependents. Independent tasks finish, then the change pauses (`phase: paused`, with a reason). `retry` resets one failed task's budget, un-cancels everything and re-cancels the dependents of any task still failed.
- **Graph updates** (`afterMerge`) run one at a time, in merge order, and every merge increments `mergeSeq` (for ADR-0007 coverage).
- **Crash and resume.** On start, `running` tasks go back to `pending` and reuse their kept worktree with a fresh session. `merging` tasks also go back to `pending` (the merge is idempotent).
- **Active change.**
  - `.factory/active.lock` names the change that owns the workspace from implementation start until close or abort, paused or not.
  - Its `pid` is the current driver: `null` when nobody drives it, and replaceable when the process is dead (stale-lock recovery).
  - A second change gets `busy` and waits in `.factory/queue.json` in approval order.
- **Abort.**
  - Sets `abortRequested` and `phase: aborted`, removes the change from the queue and releases the lock. Branches and worktrees stay.
  - The driver notices within a second (or before its next agent call), interrupts agents and leaves unfinished tasks `pending`.
  - Abort does **not** start the next queued change: the user decides when.
