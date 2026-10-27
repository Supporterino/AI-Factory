# opencode v2.2.0 re-verification (2026-10-27)

Source: github.com/anomalyco/opencode tag `v2.2.0` (`1097e266`), released 2026-10-27. Baseline:
the 2.1.2 findings in [`opencode.md`](opencode.md). Labels **[S]** source, **[X]** tested against
the real binary (isolated HOME/XDG, no credentials, no real model).

## 1. API diff vs 2.1.2 [S, X]

- **No removals.** The OpenAPI documents have 119 paths in 2.1.2 and 130 in 2.2.0; every 2.1.2
  path still exists. Every route the factory calls is unchanged:
  - `GET /api/plugin` (server readiness)
  - `GET /api/agent?location[directory]=…`
  - `POST /api/session`, `GET /api/session/{id}`
  - `POST /api/session/{id}/prompt`
  - `GET /api/session/{id}/message?order=desc&limit=200`
  - `POST /api/experimental/session/{id}/wait`
  - `POST /api/session/{id}/permission/{permissionID}/reply`
  - `GET /api/event`
- **Additive changes:**
  - `GET /api/event` accepts `types` (single value or array) to filter the SSE stream.
  - `GET /api/model` accepts `types`; its default is now `chat`.
  - New routes: `/api/plugin/gui`, `/api/experimental/generate/{text,image,decisions}`,
    `/api/experimental/media/{hash}`, `/api/experimental/voice/models`,
    `/api/experimental/client-mcp[/token]`, `/api/experimental/fs/watch`,
    `/api/experimental/usage/limits`, `/api/debug/heap-dump`.
  - `/api/info` now reports the machine hostname; `/api/agent` can return `503` while plugins
    reload. The runtime's `#awaitAgent` already retries any non-array response.
  - `serve` honours `OPENCODE_SERVER_USERNAME`; the factory starts its own server with a curated
    env that does not pass that variable, so the Basic-auth user stays `opencode`.
- **Unchanged for the factory:** the `Permission.*` schemas, session message/prompt schemas,
  permission reply, and `/wait` request/response schemas are identical to 2.1.2.

## 2. Plugin and agent discovery [X]

- The plain-object plugin shape (`export default { id, setup(ctx) }`, `ctx.tool.hook`,
  `ctx.shell.hook`) still loads. The 2.2.0 breaking changes affect `@opencode/ai` package entry
  points and TUI plugins (OpenTUI 0.7), not this API.
- A plugin at the workspace root loads for sessions whose `location.directory` is a nested
  worktree directory (verified with two locations and a setup marker).
- Nested `.opencode/agents` are merged into the visible set, and a same-id agent in the nearest
  `.opencode/agents` wins over the parent copy (verified with `GET /api/agent`). This preserves
  the snapshot behaviour in ADR-0022.
- The stub provider path `@opencode/ai/providers/anthropic-compatible` still resolves; the
  real-runtime E2E test passes on 2.2.0 (2/2), including the guarded shell, password scrub,
  sandbox, handoff and usage assertions.

## 3. Direct tool exposure when `execute` is denied [S]

`packages/core/src/tool.ts` changed `Tool.snapshot`: when `execute` is wholly denied, the direct
tool list is now every permitted tool, not only tools marked `codemode: false`. Consequences:

- MCP and plugin tools are visible to factory agents (all of them deny `execute`). Each tool's
  own permission is still evaluated, so a denied tool stays hidden and a call still passes the
  permission stack. This makes `mcp.roles` work as documented.
- Because the factory's agent rules only enumerate built-in actions plus the configured
  `mcp.roles` patterns, a global `allow` rule for an MCP action can now expose that tool to a
  role that did not list it. 2.1.2 hid these tools entirely when `execute` was denied, so this
  is new reachability, not a change to the matcher.
- No catch-all deny was added in this release. The residual risk is noted in the changeset and
  in `docs/research/tooling.md`. Closing it later means prepending
  `{ action: "*", resource: "*", effect: "deny" }` to every agent ruleset and teaching
  `ruleEffect` to match action wildcards.

## 4. Verification commands

```bash
# 2.2.0 (installed binary)
AI_FACTORY_E2E=1 bun test test/opencode-runtime.e2e.test.ts --timeout 180000

# 2.1.2 (isolated npm install, PATH first)
tmp=$(mktemp -d)
npm install --prefix "$tmp" @opencode/cli@2.1.2
PATH="$tmp/node_modules/.bin:$PATH" \
  AI_FACTORY_E2E=1 bun test test/opencode-runtime.e2e.test.ts --timeout 180000
```
