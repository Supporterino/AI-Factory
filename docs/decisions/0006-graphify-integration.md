# ADR-0006: Graphify integration

**Context.** `graphify install --project --platform opencode` writes:
- an AGENTS.md section telling agents to run `graphify update .` (which conflicts with CLI-serialised updates)
- a plugin that echoes a hint into the first shell call (wasted tokens)

Graphify also rewrites files in `$HOME` unless `GRAPHIFY_NO_AUTO_REFRESH=1` is set. Queries default to `./graphify-out` relative to the cwd, but agents run in worktrees.

**Decision.**
- `init` checks that `graphify` is installed at the pinned version and does a full build. It does not run Graphify's own installer.
- The factory renders its own short "graph first" instructions into the agent bodies. Agents use `graphify query|explain|path|affected --graph <ws>/graphify-out/graph.json` via shell.
- `graphify update` is blocked for agents, because only the CLI updates the graph.
- `graph.exclude` from the config is rendered into a root `.graphifyignore` (a managed file).
- Every graphify call goes through the exec wrapper with `GRAPHIFY_NO_AUTO_REFRESH=1 GRAPHIFY_BACKEND=none`.
- MCP (`graphify-mcp`) is an optional later switch, not v1. It needs the `[mcp]` extra, and opencode MCP wiring was not verified.

**Consequences.** One graph over the whole workspace, including the submodules, as verified. The graph is gitignored and rebuilt locally.
