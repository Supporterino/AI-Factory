# ADR-0035: Committed change records

**Context.** Everything the factory needs to run is in git: the config, the lock, `.opencode/`, the OpenSpec tree. What it produces is not. A finished change leaves its final report, approval and usage ledger in the gitignored `.factory/`, so a fresh clone or another machine loses them. ADR-0033 made that explicit for usage ("local by design"). That was a reasonable default when the only consumer was `ai-factory usage` on the machine that ran the change, but it makes the factory's history unportable: the one record of what a change did, who approved it and what it cost exists on one disk.

**Decision.**
- **Opt-in, off by default.** A new config block:

  ```jsonc
  "artifacts": { "mode": "local", "reports": true, "approvals": true, "usage": true }
  ```

  `"local"` keeps the current behaviour. `"git"` snapshots the records below into a committed tree. The migration to schema v4 writes the block with `local`, so an existing workspace changes nothing until a human flips the mode.
- **A fixed top-level directory: `factory-records/`.** Not `docs/factory/` (keeps `docs/` human-only) and not `factory/` (the agent policy lists are static; a generic name would deny edits to an unrelated directory in a target repo). Layout: `reports/<id>.md`, `approvals/<id>.json`, `usage/<id>.json`.
- **When.** `close` records a finished change; `land` records before cleanup deletes the local approval; `quick` records the `quick-<slug>` ledger even when the task failed (the tokens were spent); `ai-factory artifacts sync <id>|--all` backfills and retries. Each write is content-compared, so a repeat writes no file and makes no commit.
- **What is never recorded.** Logs (redaction is best effort; committing them is a leak risk), paused reports (they embed gate output), context packs, drafts, snapshots and run state. History and state stay local; only the per-change record travels.
- **Usage carries its own waste count.** `wastedReads` is derived from logs, which do not travel, so the committed snapshot stores the count and `usage` uses it when the logs are gone.
- **Usage reads both.** `usage` and `status` scan the live `.factory/usage/` and the committed `factory-records/usage/`, with the live ledger winning for an id. Archived changes stay visible after `land` and after a clone; nothing is counted twice.
- **Records are factory-owned.** `factory-records` is added to the same static protection lists as `.factory/`: `src/policy/paths.ts`, the rendered permission rules, the plugin's own copy, the sandbox write-deny list and the `AGENTS.md` deny bullet. Only the CLI writes and commits them.
- **Out of the graph.** `factory-records/**` joins `graph.exclude` (and the v3 → v4 migration appends it) so the code graph does not index prose records.
- **Not a mid-flight handoff.** Only finished changes are recorded. Worktrees, sessions, opencode's database, locks and run state remain local; switching machines during a change still requires `land` or `abort` first.

**Consequences.**
- A clone carries the audit trail: report, approval (approver email, spec commit, pass count), and per-change cost. `usage` and `doctor` work on a fresh machine without the original `.factory/`.
- One extra commit per change (`docs(factory): record <id>`, with a `Change-Id` trailer), plus one for a backfill. The records are per-change files, so changes that land in parallel do not conflict.
- The report is a snapshot from `close`. Its "provisional pointers" wording can go stale after `repoint`; re-running `artifacts sync <id>` refreshes the copy but does not rewrite the text.
- Reports contain findings and risks, not gate output; approvals contain the approver's git email. A workspace that considers either sensitive keeps `"mode": "local"` or disables the kind (`"reports": false`, …).
- Switching `git` → `local` leaves already committed records in history; remove them with `git rm -r factory-records` if that is intended.
- `doctor` reports the record count when the mode is `git`, and warns when the directory is gitignored or missing.
