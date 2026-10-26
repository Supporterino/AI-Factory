# ADR-0019: Pipeline decisions

**Context.** §7 defines the steps. These are the choices made to implement them (slice 7).

**Decision.**
- **REST, not `@opencode/client`.** `OpencodeRuntime` calls the server's REST API with `fetch`; every endpoint was verified end to end (docs/research/opencode-e2e.md). This avoids pinning a second package that changed shape in 2.1.0.
  - Turn completion: `/wait` can return before a queued prompt starts. A turn is complete when the newest message is an `idle` entry newer than our prompt.
  - Messages are read newest first; 200 per page is the server maximum.
- **Drafts.** If another change occupies the AI-repo checkout (active, or awaiting approval on its branch), `run` drafts the new change in `.factory/drafts/<id>`, an AI-repo worktree on `change/<id>` created from the occupying change's base.
  - `approve` commits the spec there.
  - Activation removes the draft worktree and switches the main checkout to `change/<id>`.
  - The approval file always lives in the workspace root.
- **Intake id.** The orchestrator's `change-id` is used when it matches the OpenSpec rule. Otherwise a slug of the request is used. Duplicates get `-2`, `-3`, ….
- **Design repair.** After the architect, the CLI runs `openspec validate --strict`, the proposal check (gap G7), the `tasks.md` parser and DAG validation. Problems go back to the same architect session, up to `gates.maxRetries` rounds; after that the change pauses in design.
- **Approval.** Commits `docs(spec): <id>` (or reuses the last commit of the change folder) and records `{approver, specCommit, hash}`.
  - `approve` checks the phase again under the run lock, so a concurrent `approve` or `resume` cannot reset loaded tasks (audit P14).
  - On activation **and** on entering every later phase (implementing, reviewing, contracts, full suite, closing), the CLI re-checks the hash and that the spec commit is an ancestor of `change/<id>` (audit P9). Once implementation has started the change cannot be approved again: the error shows how to restore the approved spec, or to abort. Closing skips the check once the archive has moved the spec.
- **Context packs.** One architect session writes all missing packs after approval. A missing pack gets a deterministic fallback (task, metadata, spec text), and any pack is truncated to `contextPackMaxTokens` (estimated at 4 characters per token), cut at the last whole line (audit P20). Reviewer and tester prompts cap the spec the same way and point to the spec files for the rest.
- **Explorers** are context, not a gate: one that fails is noted in the architect's prompt and the others still count (audit P20). Only when every explorer fails (the runtime is down) does the design pause.
- **Contract order.** Design validation requires every task in a consumer repo to depend on the tasks that change a contract it consumes; before, only the architect's prompt asked for it (audit G9).
- **`touches` globs** must be valid: unbalanced `[` or `{` fails design validation (audit G9).
- **Attempts.** Each attempt is a fresh session. Earlier work stays in the worktree, and the full compacted gate output is the feedback, with a note on top when it repeats the previous attempt's. Diff-only feedback left fresh sessions without the error text (audit P1).
  - After the session, the CLI audits the worktree diff against the scope. Out-of-scope files are reverted and the attempt counts as a failure.
  - On a successful attempt the CLI commits: spec tasks get a Conventional type from the title, testers `test:`, follow-ups `fix:`.
  - A failed dependency install blocks the task without spending budget.
- **Review and tests.**
  - Once all tasks merged, each touched repo gets one reviewer pass and one tester task, both once per change.
  - `must` and `should` findings become `fix-<repo>-<n>` tasks (touches `**`; the finding is their context pack). `nice` findings go to the report only.
  - The tester task is `test-<repo>`.
  - A reviewer or contract reviewer that returns no handoff (crash, timeout, prose) is not a clean review: the change pauses and the repo is reviewed again on `resume` (audit P13).
  - Reviews start once every repo has merged, and the tester task follows its repo's review. This is deliberate (audit G9 asked): the reviewer sees the integrated change, and tests are not written for code that a review fix then rewrites. Starting per-repo reviews earlier would mean running the scheduler inside the review phase.
- **Full suite.** Failures become `suite-<repo>-<round>` fix tasks, seeded with the gate output. After two rounds the change pauses.
- **Close.** In order:
  1. Mirror the task checkboxes into `tasks.md`.
  2. Commit the provisional pointer bump (submodules).
  3. `openspec validate`, then `openspec archive --yes`, committed as `chore(spec): archive <id>`.
  4. Write the report to `.factory/reports/<id>.md`.
  5. Release the lock and start the next queued change in the same process.

  Steps 2 and 3 are recorded in the run state when done (`pointersBumped`, `archivedAs`, `archiveCommit`), and the report is built from those records. A close resumed after a crash skips what is recorded; an archive that `openspec` moved but the CLI did not commit yet is detected and committed (audit P6). Nothing is pushed.
- **Interrupts.** SIGINT/SIGTERM abort the pipeline signal: the scheduler stops dispatching, sessions are interrupted, state stays resumable. The runtime is always closed and the driver released. Exit codes: 6 = paused or aborted, 4 = a precondition (e.g. the spec changed after approval).
