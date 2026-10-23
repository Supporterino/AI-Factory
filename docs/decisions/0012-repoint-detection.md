# ADR-0012: `repoint` detection order

**Context.** Squash merges drop `Change-Id` trailers (verified). Patch-ids of the cumulative branch diff equal the squash commit's patch-id (verified).

**Decision.** After `git fetch`, for each provisional pointer, look on `origin/<defaultBranch>` in this order:
1. A commit with the trailer `Change-Id: <id>`.
2. A merge commit with the recorded `change/<id>` tip as a parent.
3. A single commit whose `git patch-id --stable` equals that of `git diff <base> <tip>`.

If there are zero or several matches, report it and leave the pointer. The replacement is one AI-repo commit, `chore(submodules): repoint <id>`.

**Consequences.** Works for merge, rebase and squash MRs. Edited-during-review squashes fall back to the report.
