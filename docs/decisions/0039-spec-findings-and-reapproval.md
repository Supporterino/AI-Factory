# ADR-0039: Spec findings and re-approval after implementation starts

**Context.** The reviewer and contract reviewer run after the code is merged, when the change's spec is already approved and hashed. A finding whose `file` points at `openspec/changes/<id>/` was turned into a `review-fix` task and handed to an implementer. That worktree is a code repo, and the edit scope forbids `openspec/**` for implementers and testers, so every attempt was reverted and the change dead-ended at the implementer's retry budget. Contract-review findings were worse: their `file` is workspace-relative, so a spec path was silently rewritten to whatever repo the fallback picked.

The other half is the approval itself. `approve` is the initial gate and refuses once a task has started. `verifyApproval` hard-fails on any non-checkbox edit, with only "restore the approved spec" as advice. A legitimate clarification after review therefore left the change unresumable.

**Decision.**
- **Classify by path.** Non-`nice` findings under `openspec/` are not code. They are recorded on the run as `specFindings` (a `Finding[]`, so the report still shows them) and never become implementer tasks. `nice` findings stay report-only. The same partition applies to the contract review, whose `file` is workspace-relative.
- **Pause, do not auto-edit.** A change with `specFindings` pauses. The pause is sticky across `resume`, `abort` and the phase shortcuts, because the affected repos are already marked reviewed and the reviewing phase would otherwise be skipped. The human decides; the architect never silently rewrites an approved spec.
- **Two explicit rescue commands.** `reword` runs one architect session over the change folder from the recorded findings (or `--prompt`). `reapprove` accepts a hand edit. Both validate with `checkDesign`, commit `openspec/changes/<id>` on `change/<id>` as `docs(spec): reword <id>`, and re-stamp the approval with the new commit and hash. Neither reloads `run.tasks`, which is why `approve` cannot be reused. The replaced hash and commit are kept in the approval's optional `history`.
- **Wording only.** Neither command may change the approved task plan: ids, repos, deps, touches and the task count must match the spec commit being replaced, or the attempt is rejected. A new task plan needs a new change.
- **Failures restore.** Before the architect runs, the change folder is snapshotted. A blocked, invalid, out-of-scope or structural attempt restores the folder and any out-of-scope edits, so the working tree stays hashable and the findings stay recorded.
- **The hash stays exact.** Only `tasks.md` checkboxes are normalised. Ignoring "wording" mechanically cannot distinguish a clarification from `must` → `must not`; the explicit commands are the human acknowledgement instead.
- **Guards.** Both commands refuse before initial approval (use `approve`), after `done` (the spec is archived), while another change is active, or while a live driver holds the change. The spec directory must be on `change/<id>`.

**Consequences.**
- Reviewers can flag spec problems without spending implementer retries or dead-ending the run.
- A spec finding pauses automation until a human runs `reword` or `reapprove`; that is the intended cost of keeping approval meaningful.
- Wording can change, but the task plan cannot: adding or changing tasks after approval needs a new change.
- Approvals gain an optional `history` array; older records remain valid, and the plugin only reads `hash`.
- The final report still lists every finding, including resolved spec findings, via the harvested handoffs.

**Follow-up: the reviewer must point at the spec.** Path classification only works when the reviewer sets `file` to the spec. The reviewer and contract-reviewer prompts now say: when the fix is a wording change in `openspec/changes/<id>/`, use that path (and line), never the code file where the mismatch shows. `review-fix` tasks also keep their source `Finding` on the task state. If such a task blocks with a reason naming `openspec` anyway, the factory moves that finding into `specFindings`, drops the impossible task (and its worktree/branch) and pauses with `specPauseReason`. This is a fallback, not a second approval path: `reword`/`reapprove` still decide the wording. A blocked task of any other kind is unchanged.
