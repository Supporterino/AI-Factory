# ADR-0001: One private `opencode serve` per run

**Context.** `opencode run` processes share one SQLite DB, and a `--standalone` server resumes "in progress" sessions it does not own (source-read risk). One server can run many sessions with different `location.directory` values (verified).

**Decision.** For each `run`/`resume`/`approve`, the CLI spawns one `opencode serve --hostname 127.0.0.1 --port <free>`:
- with a random `OPENCODE_PASSWORD` and `OPENCODE_DB=.factory/opencode/opencode.db`
- with agent env markers (`AI_FACTORY_AGENT=1`, the push block from ADR-0003)

It drives the server through `@opencode/client`, pinned to the opencode version:
- one session per task, with `location.directory = <task worktree>`
- session-level `permissions` for the dynamic scopes

`maxAgents` bounds open sessions. The server is a child in the CLI's process group and dies with it.

**Consequences.** No daemon (the server lives only as long as the CLI command). The user's own opencode sessions are never touched. Three behaviours are verified in slices 5/7 with the stub provider (ADR-0009):
- env inheritance into the shell tool (fallback: the `shell.create.before` hook)
- credential lookup with a relocated DB
- `tool.execute.before` blocking
