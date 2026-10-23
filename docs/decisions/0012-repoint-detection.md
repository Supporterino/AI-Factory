# ADR-0012: `repoint` detection order

**Context.** Squash merges drop `Change-Id` trailers (verified). The patch-id of the cumulative branch diff equals the patch-id of the squash commit (verified). In a merge-commit MR, the change tip becomes an ancestor of upstream, so an ancestor check alone would point at the branch tip instead of the merge commit. (Revised in slice 4.)

**Decision.** The provisional bump commit, `chore(submodules): bump for <id> [provisional]` with trailer `Change-Id: <id>`, is the record. `repoint` reads the pointers from that commit's gitlink changes, so it works without `.factory/` state. After `git fetch`, for each pointer, it looks on `origin/<tracked or default branch>` in this order:
1. **Upstream contains the tip.** Walk the mainline (`--first-parent`) back to the first commit that contains it.
   - If that commit is the tip itself, it was a fast-forward (`already-merged`; the pointer stays).
   - Otherwise it is the merge commit, which becomes the new pointer.
2. **Trailer (rebase merge).** The newest mainline commit with `Change-Id: <id>`.
3. **Patch-id (squash merge).** Exactly one mainline commit whose `git patch-id --stable` equals that of `git diff <base> <tip>`.

If none matches, the result is `not-merged`; if several match, `ambiguous`. Both leave the pointer provisional and make `repoint` exit with 4. A pointer that no longer equals the provisional value, or a dirty submodule, is skipped.

The new pointers land in one AI-repo commit, `chore(submodules): repoint <id>`. History is never rewritten.

**Consequences.** Works for fast-forward, merge, rebase and squash MRs. A squash edited during review falls back to the report.
