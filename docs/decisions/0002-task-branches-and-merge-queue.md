# ADR-0002: Task branches and the per-repo merge queue

**Context.** A branch can be checked out in only one worktree. `change/<id>` is checked out in the repo's main checkout. A ref `change/<id>/<task>` cannot coexist with `change/<id>`.

**Decision.** Each task gets a temporary local branch `change/<id>--<task>` and worktree `.factory/worktrees/<id>/<repo>/<task>`, created from the repo's own git dir (`git -C <repo> worktree add`). Merge-back per repo, one task at a time:
1. `git rebase change/<id>` in the task worktree.
2. Re-run the task gates.
3. `git -C <repo> merge --ff-only change/<id>--<task>`.
4. Remove the worktree and delete the branch.

On a rebase conflict, the implementer gets one resolution attempt (it counts against the retry budget); after that the task is requeued as serial. `withinRepo: "serial"` runs tasks directly in the repo checkout on `change/<id>`.

**Consequences.** The only branch that survives is `change/<id>` (the locked name). History is linear, one commit per task.
