# opencode 2.1.2 end-to-end spike (slice 6)

> Re-verified against 2.2.0 on 2026-10-27: see [`notes/opencode-2.2.0.md`](notes/opencode-2.2.0.md). The runtime E2E test passes on both versions.

Run on 2026-10-23 against the real `opencode` 2.1.2 binary, with a stub model server and a sandboxed private server (isolated XDG dirs, HOME, TMPDIR, `OPENCODE_DB`; outbound network denied except localhost). The workspace was produced by `ai-factory init` on the single-repo fixture.

## Setup that worked

- **Stub provider.** The bundled `@opencode/ai/providers/anthropic-compatible` package means nothing is downloaded:

  ```jsonc
  "providers": { "stub": { "package": "@opencode/ai/providers/anthropic-compatible",
    "settings": { "baseURL": "http://127.0.0.1:<port>/v1", "apiKey": "x" },
    "models": { "claude-stub": { "limit": { "context": 200000, "output": 8000 } } } } }
  ```
- **Server.** `opencode serve --hostname 127.0.0.1 --port <p>` with `OPENCODE_PASSWORD` (HTTP Basic user `opencode`), `AI_FACTORY_WORKSPACE`, `AI_FACTORY_AGENT=1` and the `GIT_CONFIG_*` push block.

## Verified

| Question                             | Result                                                                                                                                                                                                                      |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plugin loads                         | `loading plugin … .opencode/plugins/factory.js`; `GET /api/plugin` → `ai-factory`, `status: active`, no id clash                                                                                                            |
| Agents load (`mode: primary`)        | All 7 factory agents. **Loading is asynchronous**: poll `GET /api/agent?location[directory]=…` until the agent appears                                                                                                      |
| Malformed agent file                 | **Silently dropped** (no log) → the factory validates frontmatter itself                                                                                                                                                    |
| `git push` blocked                   | Model received `is_error: true`, "ai-factory blocked this call: git push is not allowed…"; `sh -c 'git push …'` too; `blocked` log line written                                                                             |
| `execute.before` vs permissions      | The plugin runs first; its message wins                                                                                                                                                                                     |
| Shell inherits server env            | Yes: `AI_FACTORY_WORKSPACE`, `AI_FACTORY_AGENT`, `GIT_CONFIG_*` all visible                                                                                                                                                 |
| opencode rules alone (control agent) | `git push` → permission denied, but **`sh -c 'git push …'` passed the glob rule** and was stopped only by the `GIT_CONFIG` push block (`remote helper 'ai-factory-push-blocked' aborted`). All three layers are needed      |
| Edits                                | No approval → blocked; `.env` read → secret; `.opencode/x` → managed by the factory; no session context file → every call refused                                                                                           |
| Tool list                            | Deny-all agents only get the allowed tools: `edit, glob, grep, read, shell, write`                                                                                                                                          |
| Usage                                | `GET /api/session/{id}` → `tokens{input,output,reasoning,cache{read,write}}`, `cost`, `outcome`; per step in `session.step.ended` / `session.usage.updated`; sums exact                                                     |
| System prompt order                  | Agent body first (`cache_control: ephemeral`), then the model note, AGENTS.md, date/`<env>`, then a 238-char `execute` hint (sent although `execute` is denied). The last tool and the newest message part are cache points |

## API calls (Basic auth)

- **Create:** `POST /api/session` with `{"agent","model":{"providerID","id"},"location":{"directory"},"title"}`. A caller-chosen `"id":"ses_…"` is accepted, so the session context file can be written before the session exists.
- **Prompt:** `POST /api/session/{id}/prompt` with `{"text"}` returns 200 at once.
- **Wait:** `POST /api/experimental/session/{id}/wait` returns 204 when idle. Events come from `GET /api/event` (SSE): `session.execution.succeeded|failed|interrupted`, `session.tool.*`, `permission.asked`, `session.usage.updated`.
- **Interrupt:** `POST /api/session/{id}/interrupt`.
- **Messages:** `GET /api/session/{id}/message?order=asc`.
- **Pending permissions:** `GET /api/session/{id}/permission`.

## Surprises → factory rules

1. **The agent's `model:` frontmatter is not applied to new sessions.** Without an explicit model the server falls back to its default model (`core/src/session/runner/model.ts`). → The CLI always passes `model` on `POST /api/session`. In the spike's first unsandboxed run, one request went to opencode's free hosted model; it was rejected (410 deprecated), cost nothing and produced no output.
2. **The server enables providers from credentials in its environment.** A `GITLAB_TOKEN` in the shell enabled GitLab Duo and made it the default model; `lmstudio` was auto-enabled too. → The CLI starts the server with a curated env: an allowlist of system variables, plus only the credentials of the providers named in `models`, plus the factory variables. (The env names `OPENCODE_DISABLE_FREE_MODELS` and `OPENCODE_DISABLE_MODELS_FETCH` were not verified.)
3. **`HTTP_PROXY` was applied to a 127.0.0.1 provider** although `NO_PROXY` was set. Unverified cause; relevant behind corporate proxies. → `doctor` warns when proxy variables are set.
4. **Headless `ask` waits forever** (`permission.asked`, no auto-reject on the server). → All rules are allow/deny only (ADR-0011), and the CLI replies `reject` to any `permission.asked` event and logs it.
5. **Token waste:** the `execute` hint is sent even when `execute` is denied (≈60 tokens per session). Noted for usage reporting; not fixable from the factory.

## Not verified

Permission reply endpoint, the session-create `permissions` override, the OpenAI-compatible stub path, title generation.
