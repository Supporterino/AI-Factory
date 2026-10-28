# ADR-0033: Workspace-wide usage reporting

**Context.** ADR-0021 records one usage entry per agent session in `.factory/usage/<id>.json`, and `status` and the change reports show a change's totals. There was no way to see what the factory has spent across the whole workspace: every change's ledger was only visible by asking `status <id>`, and quick tasks write ledgers under `quick-<slug>` that are not run states.

**Decision.**
- **New `usage` command.** It scans every `.factory/usage/*.json`, including quick tasks and archived changes, and aggregates the existing `Usage` counters. It reads state only; no config or lock is required, and no run is affected.
- **Filters.** `--since` and `--until` are inclusive UTC days (`YYYY-MM-DD`, matching the ISO timestamps). `--change`, `--agent` and `--model` accept repeated flags or comma lists.
- **Dimensions.** The human report prints tables for `change`, `agent`, `model` and/or `day` (`--by`, default `change,agent,model`). The JSON report always includes every dimension plus `sessionsByChange`, filters and the list of unreadable ledgers.
- **Same definitions as ADR-0021.** Tokens are input + cache reads + cache writes + output + reasoning. Retry overhead is attempts after the first plus conflict resolutions. Cost is the provider's figure. Wasted re-reads come from the plugin's `waste` log lines for included changes.
- **Status summary.** `status` without an id prints one workspace-wide usage line, and `status --json` adds `workspaceUsage`. Per-change usage is unchanged.
- **Corruption is reported, not fatal.** A ledger that does not parse is skipped and named on stderr (and in JSON `corrupt`); the rest still aggregates.
- **Local by design.** The ledgers and report stay in gitignored `.factory/`; usage is never committed, enforced or used as a gate.

**Consequences.**
- One place answers "what has the factory cost in this repo"; `usage --json` can feed a dashboard or a release note.
- Filters combine (AND), so a query such as `--since 2026-10-01 --agent implementer-backend` is possible.
- Wasted re-reads are counted per included change, because the log is not timestamped against individual entries; the report says "wasted re-reads", not a filtered count.
- Deleted ledgers are gone; the report cannot reconstruct sessions from reports or logs. This follows the existing local-state policy.
- Bench runs execute in throwaway workspaces and are not part of the user's ledger; the report does not claim to include them.
