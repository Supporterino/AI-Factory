# ADR-0040: Re-reviewing after a fix round

**Context.** Review ran exactly once per touched repo. `must`/`should` findings became `review-fix` tasks, the tasks merged, and the pipeline moved on to contracts — it never asked the reviewer whether the fixes were right. A wrong or partial fix was only visible in the final report. The `reviewed` set made a second pass impossible: after the first pass every repo was marked reviewed, so re-entering `reviewing` found no work.

**Decision.**
- **One knob.** `workflow.reviewRounds` (integer, 1–10, default 1) is the number of reviewer passes per change. `1` is the old single pass; `N` allows up to `N-1` further passes.
- **Only code findings extend the loop.** A pass with `must`/`should` findings that are not under `openspec/` creates fix tasks and queues another pass. `nice` findings and tester work never do.
- **Every touched repo is re-reviewed.** After a fix round, all touched repos take the next pass, not only the ones with fixes. This catches interactions and keeps the comparison across repos honest; the cost is one reviewer session per touched repo per round.
- **Full diff.** Later passes run the same prompt and the same `git diff base..change/<id>` range. No previous findings are injected, so the reviewer is not anchored by its own earlier verdict.
- **The tester runs once.** Test coverage is a one-shot task per repo; re-running it after every review round would duplicate work. A fix task may add tests within its `touches`.
- **The cap does not pause.** At `reviewRounds`, the last round's fix tasks still run, a warning is printed, and the pipeline proceeds to contracts with the remaining findings in the report. This matches the old behaviour for `1` and avoids blocking on a reviewer that keeps reporting the same thing.
- **Round-scoped fix ids.** Fix tasks are `fix-<repo>-<round>-<n>`. The old `fix-<repo>-<n>` restarted at 0 each pass, and `addTask` drops duplicate ids, so a second round would have added nothing and ended the loop by accident.
- **State.** `RunState` gains `reviewRound` (passes completed) and `reReview` (repos queued for the next pass). `reviewed` keeps its meaning: the first reviewer+tester pass is done. A crashed pass does not consume the cap; a resume retries the whole pass.

**Consequences.**
- Each extra round costs one reviewer session per touched repo, so the setting is opt-in (default 1) and bounded (max 10).
- A loop that cannot converge stops at the cap with the findings recorded; it cannot run forever.
- Contracts and full-suite fixes are unchanged: they return to `implementing`, and `reviewing` only runs again when a re-review is queued.
- Fix task ids from earlier runs (`fix-<repo>-<n>`) remain valid; new ids do not collide with them.
