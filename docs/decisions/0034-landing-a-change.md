# ADR-0034: Landing a finished change locally

**Context.** `close` leaves the change on local `change/<id>` branches in the AI repo and every touched submodule. The report says to push the branches and open MRs, and `repoint` only replaces provisional pointers after those MRs merge upstream. Users who work entirely locally had no single step to merge the finished result into their base branches and remove the temporary branches, worktrees and state. Cleanup by hand is error-prone: the AI repo's submodule pointers must match the merged submodule commits, and deleting a branch that is still checked out loses nothing but leaves misleading state.

**Decision.**
- **`ai-factory land <id>`.** It requires a `done` change, no other active change, clean repo checkouts and clean change worktrees. It never pushes.
- **Order.** Submodules merge first into their tracked branch (`.gitmodules`), `defaultBranch`, or `main`; then the AI repo's change branch is merged into its base. If a submodule merge created a merge commit instead of a fast-forward, the AI repo gets a `chore(submodules): point to landed <id>` commit on `change/<id>` before that branch merges, so the gitlinks match the landed submodule tips.
- **Conflicts.** A conflicting merge is aborted in that repo and the command exits 4 with the conflicted paths. Earlier repos are not rolled back; the output names what landed. This is the same partial-progress rule as the rest of the factory: keep what is real, report the rest.
- **Cleanup.** Worktrees and drafts are removed first, then leftover task branches and the change branch in every repo. The change's context packs, paused report, approvals and run state are removed only when cleanup completed. Final report, usage ledger and redacted logs are kept as the record. A branch that cannot be deleted is kept and reported, with run/approval left for a retry.
- **Safety.** Branches are force-deleted only after an ancestor check against the checked-out base; this avoids `git branch -d`'s upstream comparison, which does not apply to factory change branches.
- **Dry run.** `--dry-run` prints the planned merges and paths without switching, merging or deleting. `--json` exposes the same result for scripts.

**Consequences.**
- A local-only user can finish with one command after reviewing the change, and the workspace no longer accumulates change branches and `.factory` state.
- The command is not a replacement for `repoint`: if the submodule MRs merged upstream, use `repoint`; `land` merges the local change branches into local base branches.
- Keeping reports, usage and logs preserves the human and cost history even though the run state is removed.
- Partial failure is explicit. The next `land` sees the remaining branches (run state is still there) and can finish the cleanup; already-landed repos report `already-merged`.
