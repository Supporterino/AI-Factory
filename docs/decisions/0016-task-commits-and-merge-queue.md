# ADR-0016: Task commits and merge-queue mechanics

**Decision.**
- **Task commit subject.** A Conventional Commit derived from the task title's leading verb:
  - fix/correct/handle → `fix`
  - test/cover → `test`
  - rename/move/extract → `refactor`
  - document → `docs`
  - bump/upgrade → `chore`
  - optimise → `perf`
  - anything else → `feat`

  Trailers: `Change-Id: <id>` and `Task: <task id>`.
- **Hooks.** CLI commits use `--no-verify`. The gates already checked the content. A commit hook that rewrites files would bypass the check-only guard, and one that fails would turn the repo's tooling into an unbounded retry source.
- **Branch names.** Task branches are `change/<id>--<task>` (ADR-0002). They are created with the worktree from the tip of `change/<id>` at dispatch time, and deleted with `git branch -d` after the merge, so an unmerged branch is never deleted.
- **Merge steps.**
  - `git rebase change/<id>` runs in the task worktree. On a conflict the rebase stays in progress and `mergeTask` reports the conflicted files.
  - After the implementer's one resolution attempt, a second `mergeTask` continues the rebase with `git add -A && git rebase --continue`.
  - Gates re-run after the rebase. `change/<id>` is then fast-forwarded in the repo checkout, and the worktree removed.
- **Queue.** `MergeQueue` serialises per repo key in FIFO order and keeps going after a failed job. Different repos merge concurrently.
- **Start points.** Submodules branch from the tracked branch in `.gitmodules` (`submodule.<name>.branch`, except `.`), else `defaultBranch`. The local branch wins, otherwise `origin/<branch>`. The CLI does not fetch before branching; a stale local default branch is the user's to update.
