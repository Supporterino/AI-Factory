# ADR-0001: One private `opencode serve` per run

**Context.** `opencode run` processes share one SQLite DB, and a `--standalone` server resumes "in progress" sessions it does not own (source-read risk). One server can run many sessions with different `location.directory` values (verified).

**Decision.** For each `run`/`resume`/`approve`, the CLI spawns one `opencode serve --hostname 127.0.0.1 --port <free>`:
- with a random `OPENCODE_PASSWORD` and `OPENCODE_DB=.factory/opencode/opencode.db`
- with agent env markers (`AI_FACTORY_AGENT=1`, the push block from ADR-0003)

It drives the server through its REST API (originally planned with `@opencode/client`; ADR-0019 explains the switch), pinned to the opencode version:
- one session per task, with `location.directory = <task worktree>`
- session-level `permissions` for the dynamic scopes

`maxAgents` bounds open sessions. The server is a child in the CLI's process group and dies with it.

**Consequences.** No daemon (the server lives only as long as the CLI command). The user's own opencode sessions are never touched. Three behaviours are verified in slices 5/7 with the stub provider (ADR-0009):
- env inheritance into the shell tool (fallback: the `shell.create.before` hook)
- credential lookup with a relocated DB: env credentials work, but credentials stored by
  `opencode auth login` live in the opencode database, so they are bridged separately (ADR-0037)
- `tool.execute.before` blocking

**Update (slice 6, verified end to end; docs/research/opencode-e2e.md).**
- **Model per session.** Every `POST /api/session` passes the role's `model` explicitly: the agent frontmatter `model` is not applied to new sessions.
- **Curated server env.** The server is started with an allowlist env: PATH, HOME, USER, LANG, TMPDIR and SHELL; the credentials of the providers named in `models` only; and the factory variables. Ambient tokens (e.g. `GITLAB_TOKEN`) would otherwise enable extra providers.
- **Startup.** The CLI polls `GET /api/agent?location[directory]=…` until the factory agents are loaded before creating sessions.
- **Session ids.** Sessions are created with a CLI-chosen `ses_…` id, so the session context file exists before the first tool call.
- **Permission prompts.** Any `permission.asked` event is answered with `reject` and logged, because headless `ask` would block forever.
