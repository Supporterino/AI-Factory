# Tooling research (Phase 0)

Checked on 2026-10-23 on macOS (arm64). Each fact is tagged with how it was verified:
**[S]** source code at the given tag, **[D]** official docs, **[H]** local `--help`, **[X]** tested in a spike.
Raw notes with more detail are in [`notes/`](notes/). Pinned versions live in [`src/versions.ts`](../../src/versions.ts).

| Tool | Installed | Latest | Factory pin | Primary sources |
|---|---|---|---|---|
| opencode v2 | 2.1.2 | 2.1.3 (2026-10-23) | `>=2.1.2 <2.2.0`, tested 2.1.2 | github.com/anomalyco/opencode @ `v2.1.2` (a517687f), opencode.ai/v2/docs |
| OpenSpec | 1.10.0 | 1.14.3 | `>=1.10.0 <2`, tested 1.10.0 + 1.14.3 | github.com/Fission-AI/OpenSpec @ `v1.10.0`, npm `@fission-ai/openspec` |
| Graphify | 0.9.93 | 0.9.94 | `>=0.9.93 <0.10`, tested 0.9.93 | PyPI `graphifyy`, github.com/Graphify-Labs/graphify, docs.graphify.com |
| Ponytail | n/a | v5.3.2 | `v5.3.2` @ `16352ac2…` | github.com/DietrichGebert/ponytail, npm `@dietrichgebert/ponytail` |
| git | 2.54.0 | | `>=2.31` (needs `GIT_CONFIG_COUNT`) | git-scm docs, spikes |
| Bun | 1.3.11 | | `>=1.3.0` | |

> **opencode.ai/docs is still the V1 documentation.** V2 docs live at **opencode.ai/v2/docs**. V1 plugins do not load in V2 [X].

---

## 1. opencode v2 (2.1.2)

### Install
- `npm install --global @opencode/cli` or the curl installer, which replaces the V1 binary [D v2/docs]. The npm package `opencode-ai` is the **V1** line (`latest` = 1.19.4); never use it.

### Config [S `packages/schema/src/config.ts`, D v2/docs/config]
- Files: `opencode.json` / `opencode.jsonc`. Precedence: global `~/.config/opencode/` < project files (farthest → closest) < `.opencode/` < system/managed. `$schema`: `https://opencode.ai/config.json`.
- V2 keys the factory uses: `model`, `default_agent`, `update` (`"disable"`), `permissions`, `agents`, `plugins`, `instructions`, `skills`, `commands`, `mcp{timeout,servers}`, `providers`, `formatter`, `experimental`.
- V1 keys (`agent`, `permission`, `tools`, `plugin`, `provider`, `autoupdate` …) are converted in memory [S `normalize.ts`, X]. **The factory writes V2 keys only.**

### Agents [S `config/plugin/agent.ts`, D, X]
- `.opencode/agents/<id>.md`. Frontmatter: `description`, `mode` (`primary|subagent|all`), `model` (`provider/model#variant`), `permissions`, `steps`, `hidden`, `disabled`, `color`, `request{headers,body}`. The body is the system prompt.
- There is no `tools` key: tools are removed by a final `{action:<tool>, resource:"*", effect:"deny"}` rule [S `tool.ts` `whollyDisabled`].

### Permissions [S, D v2/docs/permissions]
- `permissions: [{ action, resource, effect: "allow"|"ask"|"deny" }]`. **The last matching rule wins.** No match means `ask`. A deny on any resource denies the whole call.
- Layering: base defaults → built-in agent → global → agent → **session** (`session.create({permissions})`).
- Actions: `shell`, `edit` (edit + write + patch), `read`, `glob`, `grep`, `subagent`, `webfetch`, `websearch`, `skill`, `question`, `external_directory`, `<mcp>_<tool>`, `execute`.
- `edit`/`read` resources are **paths relative to the session directory**, so path-scoped edits work. `*` matches `/`; `?` matches one character.
- **`external_directory` is allowed by default**, so the factory must deny it.
- Shell commands are split into sub-commands and each one is checked.
- Headless `ask`: `opencode run` auto-rejects and the model continues. `--auto` approves; deny is always enforced [S `cli/src/run/noninteractive.ts`].

### Plugin API [S `core/src/plugin/hooks.ts`, D v2/docs/build_plugins]
- Loaded from `.opencode/plugins/` and the config `plugins` list. Shape: `export default Plugin.define({ id, setup(ctx) })` from `@opencode/plugin`.
- Hooks:
  - `tool.execute.before`, `tool.execute.after`
  - `session.prompt|context|compaction|generate|title|model.request|http.request|http.response|retry`, plus `session.experimental.ws.*`
  - `permission.evaluate`
  - `shell.create.before`
  - `aisdk.sdk`, `aisdk.language`
  - Events arrive via `ctx.event.subscribe()`.
- `tool.execute.before` can rewrite `event.tool`/`event.input` and **throw to block the call**. It runs before the permission check.
- Tool inputs:
  - shell: `{command, workdir?, timeout?, background?}`
  - edit: `{path, oldString, newString, replaceAll?}`
  - write: `{path, content}`
  - patch: `{patchText}`
- Only the `experimental.*` hooks are marked unstable, but 2.1.0 deliberately broke plugin/SDK contracts, so the API is young (**gap G1**).

### Headless and server [H, S, X]
- `opencode run [--standalone] [--server <url>] [-s <id>] [-c] [--fork] [-m p/m] [--agent a] [--format json] [-f file] [--title] [--thinking] [--auto]`. Exit codes: 0 ok, 1 error, 130 SIGINT [X].
- JSON events: `step_start`, `text`, `reasoning`, `tool_use`, `step_finish` (`part.tokens`, `part.cost`), `error`.
- `opencode serve [--hostname] [--port] [--cors] [--stdio]` requires `OPENCODE_PASSWORD` (HTTP Basic, user `opencode`); without it, requests get 401 [X].
- SDK: **`@opencode/client`** (V2; `@opencode-ai/sdk` is V1). Calls:
  - `session.create({location:{directory}, agent, model, permissions, parentID})`
  - `session.prompt({sessionID, text, files})`
  - `session.switchAgent`
  - `session.interrupt`
  - `session.wait` (experimental)
  - `event.subscribe()` (`GET /api/event`)
  - permission reply: `POST session/{id}/permission/{req}/reply`

### Parallel sessions [S, X]
- One server runs many concurrent sessions, each with its own `location.directory` [X].
- All processes share the SQLite DB `~/.local/share/opencode/opencode.db` (WAL). `OPENCODE_DB` relocates it.
- **Risk (code-read):** a `--standalone` server resumes every "in progress" session it is not running, so concurrent standalone processes can hijack each other's sessions. Hence the factory's concurrency model in §6.

### Subagents, usage, caching
- Subagents use the `subagent` tool `{agent, description, prompt, model?, background?}`. Depth comes from `experimental.subagent_depth` (default 1). Same-step calls may run concurrently [S].
- Usage: `tokens{input, output, reasoning, cache{read,write}}` + `cost` (USD). It appears in `session.step.ended` / `session.usage.updated` events, on the session object and in `opencode stats --json` [S, X shape].
- Caching [S `packages/ai/src/cache-policy.ts`]:
  - Up to 4 cache points: last tool, first and last system part, end of conversation. Anthropic gets `cache_control: ephemeral`.
  - System order: agent prompt → Code Mode → MCP/skill info → AGENTS.md → `instructions` → date + `<env>` (contains cwd).
  - **So static content must sit in the agent body (the first system part) to share a cache prefix across worktrees.**

### Skills, commands, AGENTS.md
- Skills: `.opencode/skills/<id>/SKILL.md` (also `.claude/skills`, `.agents/skills`). Commands: `.opencode/commands/<name>.md` with `$ARGUMENTS` [X].
- AGENTS.md: global, then each AGENTS.md from cwd upward. Nested files load when reading in that area. **CLAUDE.md is no longer read.**

## 2. OpenSpec (1.10.0 and 1.14.3)

Sources: local `--help` for both versions; the installed `dist/` of 1.10.0; `docs/cli.md` @ v1.10.0 (exit codes ~L1272, env vars L1283-1293); spikes on 1.10.0 and 1.14.3 with an isolated `XDG_CONFIG_HOME`.

### Commands the factory relies on
| Purpose | Command |
|---|---|
| Install opencode files | `openspec init --tools opencode --profile core --no-animation <path> </dev/null` |
| Validate | `openspec validate <id> --strict --json` (also `--all --changes --specs`) |
| Task list / progress | `openspec instructions apply --change <id> --json` → `tasks[{id,description,done,line}]`, `progress{total,complete,remaining}` |
| Artifact status | `openspec status --change <id> --json` → `artifacts[{id,status:done\|ready\|blocked}]`, `isComplete` |
| Artifact instructions | `openspec instructions <artifact> --change <id> --json` (includes `context`, `rules`) |
| List | `openspec list --json` → `changes[{name,completedTasks,totalTasks,status}]` |
| Archive | `openspec archive <id> --yes --json` → `{archive:{archivedAs,specsUpdated,totals}}` |
| Refresh tool files | `openspec update <path> [--force]` |

- Exit codes: 0 ok, 1 any error, including validation failure [D, X]. **Quirk:** `status --json` without `--change` exits 0 with an error payload.
- Validate JSON: `{items:[{id,type,valid,issues:[{level,path,line?,message}]}],summary:{totals},version:"1.0"}` [X].
- Non-interactive: `OPEN_SPEC_INTERACTIVE=0`, `CI`, or non-TTY stdin.
- **`init` output depends on the user's global profile** (`~/.config/openspec`). The factory runs it with a private `XDG_CONFIG_HOME` and `--profile core` for reproducible output.
- `init` writes `.opencode/commands/opsx-*.md`, `.opencode/skills/openspec-*/SKILL.md`, `openspec/config.yaml` and `openspec/{specs,changes/archive}/`. A second run is byte-identical [X].
- **`init` strips `<!-- OPENSPEC:START -->…<!-- OPENSPEC:END -->` blocks from root AGENTS.md/CLAUDE.md** [S `legacy-cleanup.js`], so the factory uses its own markers.

### Layout and format [S, X]
- `openspec/changes/<id>/{.openspec.yaml, proposal.md, design.md, tasks.md, specs/<cap>/spec.md}`. Id regex: `^[a-z0-9]+(?:-[a-z0-9]+)*$`. Archive path: `openspec/changes/archive/YYYY-MM-DD-<id>/`.
- Delta specs:
  - Section headings: `## ADDED|MODIFIED|REMOVED|RENAMED Requirements`.
  - `### Requirement:` must contain SHALL/MUST; that is an error under `--strict`.
  - `#### Scenario:` with `- **WHEN**` / `- **THEN**`; at least one per requirement.
- `tasks.md`: `## N. Group` headings and `- [ ] N.M title`.
- **Per-task metadata:** indented non-checkbox lines (`  - repo: x`, `  - deps: 1.1`, `  - touches: glob`) pass `--strict` and are not counted as tasks [X 1.10.0 and 1.14.3].
  - Any line containing `[ ]` counts as a task, even inside fences.
- `config.yaml` keys: `schema`, `context` (≤ 50 KB), `rules: {<artifactId>: string[]}`, `operations.{apply,archive}.guidance`.
- **Gaps the factory must cover:**
  - `validate` never checks `proposal.md`.
  - `archive --yes` skips the incomplete-tasks check [X both versions].
- Custom schemas (`openspec/schemas/<name>/schema.yaml`) work but are marked **experimental**; the factory uses the built-in `spec-driven` schema.

### Telemetry
- PostHog (command and version) to `edge.openspec.dev`, plus an npm update check.
- The factory sets `OPENSPEC_TELEMETRY=0 DO_NOT_TRACK=1 OPENSPEC_NO_UPDATE_CHECK=1 OPENSPEC_NO_COMPLETIONS=1 OPEN_SPEC_INTERACTIVE=0 NO_COLOR=1` on every call.

## 3. Graphify (0.9.93)

Sources: installed source `graphify/{__main__,cli,detect,cache,install,serve}.py`; `graphify --help`; docs.graphify.com `/reference/configuration`, `/guides/incremental-updates`; spikes.

- **Install:** `uv tool install graphifyy==<ver>` (Python ≥ 3.10). The MCP server needs the `[mcp]` extra.
- **Mandatory env on every call:** `GRAPHIFY_NO_AUTO_REFRESH=1 GRAPHIFY_BACKEND=none`.
  - Without the first, *every* command rewrites installed skills and plugins in `$HOME` and the cwd [S `__main__.py _refresh_stale_skills`]. This happened during research; see the report.
  - The second disables all LLM steps, including a `claude -p` fallback for community labels.
- **Build or update:** `graphify update <ws>` does a full build if no graph exists, otherwise an incremental one (mtime + sha256 manifest, AST cache). It writes `graphify-out/{graph.json, GRAPH_REPORT.md, graph.html, manifest.json, cache/}`. No LLM is used for code; it works with the network denied [X].
  - `--force` lets the graph shrink after deletions.
  - The graph format version is `graph.json → graph.schema_version` (1) plus `graphify_version`.
- **Measured** (M4 Pro, wall-clock, `update`; full / no-op / 1-file change):
  - hono (92k LOC TS): 5.8 / 4.5 / 5.0 s
  - gin (25k LOC Go): 3.5 / 2.0 / 2.0 s
  - opencode (912k LOC TS): 101 / 47 / 64 s
  - The large-tree cost is dominated by clustering and the report, not parsing.
- **Query:** about 0.7 s per call. Exit codes: 0 answer, 3 ambiguous, 4 no match [X]. Output is text.
  - `graphify query "<q>" [--budget N] [--graph P]`
  - `explain "<path::Symbol>"`
  - `path A B`
  - `affected X [--depth N]`
  - `god-nodes --json`
  - **The default graph path is relative to the cwd, so agents in worktrees must pass `--graph <ws>/graphify-out/graph.json`.**
- **MCP:** `graphify-mcp <graph.json> --transport stdio`. Tools: `query_graph`, `get_node`, `get_neighbors`, `shortest_path`, … It auto-reloads on graph change [X stdio].
- **Include/exclude:**
  - Respects `.gitignore`, nested ones included.
  - Reads `.graphifyignore` (gitignore syntax, exclude-only).
  - `extract --exclude GLOB` is persisted for later updates.
  - There is no allowlist.
- **Multi-root:** run at the AI-repo root, it **indexes all submodules into one graph**, with cross-repo call/import edges resolved and each submodule's `.gitignore` honoured [X]. `graphify merge-graphs` exists as a fallback for roots outside the workspace.
- **Concurrency:** atomic JSON writes; `update` takes `graphify-out/.rebuild.lock`. 25 queries during 3 updates all succeeded [X].
- **Project install:** `graphify install --project --platform opencode` writes an AGENTS.md section, `.opencode/plugins/graphify.js` and `.opencode/skills/graphify/`. Its AGENTS.md text tells agents to run `graphify update .` themselves, which conflicts with CLI-serialised updates (see ADR-0006).
- No telemetry found [S grep, README].

## 4. Ponytail (v5.3.2)

Sources: repo at tag `v5.3.2` (commit `16352ac229eb08a9598dcae48fe9f2b342567d86`, 2026-10-17); npm `@dietrichgebert/ponytail@5.3.2` (same `gitHead`, byte-identical files, no binaries). License: MIT, "Copyright (c) 2026 DietrichGebert".

- **Vendored files (5):**
  - `AGENTS.md` (32 lines, ~680 tokens)
  - `LICENSE`
  - `skills/ponytail/SKILL.md` (only for the levels table)
  - `skills/ponytail-review/SKILL.md` (~1,290 tokens)
  - `.opencode/command/ponytail-review.md`
  - Content hash: `e7a219f6eea3af5bc5338b05838ca63b9cf4797beeb589abc120b98fdd57efb9`. The method is in `src/versions.ts`; independently reproduced.
- **Plain instructions:** `AGENTS.md` and the review skill body.
- **Needs a skill-capable host or runtime:** SKILL frontmatter, slash commands (`$ARGUMENTS`), the `/ponytail` level switch, the OpenCode plugin `ponytail.mjs` (writes `~/.config/opencode/.ponytail-active`), `hooks/*` and the Claude-Code-only statusline/band. **None of these are installed.**
- **Levels** `lite|full|ultra|off` exist only as a table in SKILL.md. The rule body is identical across levels, and the runtime just appends the active row. **So the compact form supports levels statically:** `AGENTS.md` + the one level row.
- **Conventions:**
  - `shortcut: <the limit>, <when to upgrade>` (legacy `ponytail:` also recognised).
  - Closing note: "one or two lines: what you skipped or did not check, and any risk", which maps to handoff `risks[]`.
- **Review output** (Markdown): Must/Should/Nice findings, each with What this is / Problem / Fix / If we skip it, then `Verdict:`, `Lean:`, `Not checked:`. This maps to handoff `findings[]`.
- **Conflicts with this factory**, resolved by `PRECEDENCE.md` and the handoff rules:
  1. "one small test… trivial changes need none" / "One good test, not coverage" vs. a test per scenario.
  2. "shortest diff wins", "no boilerplate/config", and the review's "No style taste" vs. repo standards and gates.
  3. "no abstraction, wrapper, type conversion" and ultra's push-back vs. contracts and compatibility shims.
  4. Markdown closing note and verdict vs. the JSON handoff.
  5. SKILL line 17 implies runtime state; it is dropped. Line 32 of AGENTS.md (a joke) is stripped.
- Not vendored but noted: Ponytail's hooks inject model-directed text offering to edit `~/.claude/settings.json`, and its band has an opt-in webhook. The factory never loads them.

## 5. git (2.54.0) — spikes

- Submodule git dir: `git -C <sub> rev-parse --git-dir` → `<ai>/.git/modules/<path>`.
- Task worktree: `git -C <sub> worktree add -b change/<id>--<task> <ws>/.factory/worktrees/<id>/<repo>/<task> change/<id>`.
  - A branch can be checked out in only one worktree, so task branches are separate.
  - `change/<id>/<task>` would collide with the ref `change/<id>`.
- Merge back: rebase the task branch onto `change/<id>` in its worktree, then `git -C <sub> merge --ff-only change/<id>--<task>`.
- Hooks: `git rev-parse --git-path hooks` → `.git/modules/<path>/hooks`, shared by all worktrees. With `core.hooksPath` (husky) it resolves to a **tracked** dir, where installing would dirty the submodule.
- **`git push --no-verify` bypasses `pre-push`.** Injecting `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=url.ai-factory-push-blocked://.pushInsteadOf GIT_CONFIG_VALUE_0=` into the agent environment makes every push fail, `--no-verify` included, while `fetch` keeps working [X].
- `repoint` after a squash merge:
  - `Change-Id` trailers are lost [X].
  - `git diff <base> change/<id> | git patch-id --stable` equals the squash commit's patch-id [X].
  - Detection order: trailer → merge commit parent → patch-id. If none or several commits match, report it.

## 6. Concurrency model (how the CLI runs opencode)

1. Per `run`/`resume`, the CLI starts **one private** `opencode serve --hostname 127.0.0.1 --port <free>` child with:
   - a random `OPENCODE_PASSWORD`
   - `OPENCODE_DB=.factory/opencode/opencode.db`, so it never touches or resumes the user's sessions
   - `AI_FACTORY_AGENT=1` and the push-block git env
2. It talks to the server through `@opencode/client` (pinned to the opencode version): one `session.create` per task, with `location.directory` set to the task worktree, `agent = implementer-<repo>`, and session-level `permissions` holding the dynamic scope rules.
3. It monitors `event.subscribe()` for idle/error/usage, applies a per-session wall-clock timeout, and uses `session.interrupt` for `abort`.
4. The scheduler semaphore (`maxAgents`) bounds concurrent sessions, and `maxGateProcesses` bounds gate child processes. A rate limiter per provider wraps prompt sends.
5. On a CLI crash, the server dies with the CLI's process group. `resume` restarts the server and re-dispatches in-flight tasks to fresh sessions in their kept worktrees.

Verified: one server with many sessions in different directories [X], server auth [X], event shapes [S]. To spike in slice 5/7 (needs a model, or the stub provider):
- whether the shell tool inherits the server's env (otherwise use the `shell.create.before` hook to inject it)
- whether `OPENCODE_DB` alone keeps provider credentials visible
- end-to-end blocking via `tool.execute.before`

## 7. Known gaps and the factory's fallback

| # | Gap | Fallback enforced by the factory |
|---|---|---|
| G1 | The V2 plugin API is young (contracts broke in 2.1.0); the SDK is new | Exact minor pin; `doctor` refuses versions outside the range; every plugin rule is duplicated by a CLI check (edit scope = post-session `git diff` scope audit; shell blocklist = git env + hooks) |
| G2 | `lsp` is accepted but nothing runs; `formatter` is off by default | Formatting and type checks are hard gates run by the CLI, never left to the runtime |
| G3 | Agent `request` (temperature, headers) is accepted but not sent | No per-role temperature in v1; models per role still work via `model` |
| G4 | `share` is a no-op; `update` auto-upgrade | Config sets `update: "disable"`; the factory pins and upgrades via `ai-factory update --tools` |
| G5 | `external_directory` is allowed by default | Every agent gets `{external_directory,"*",deny}`; the plugin also rejects absolute paths outside the session dir |
| G6 | Headless `ask` auto-rejects | No `ask` rules: every rule is allow or deny, so behaviour is deterministic |
| G7 | OpenSpec `validate` ignores `proposal.md`; `archive --yes` ignores unchecked tasks | The CLI checks proposal headings and requires every task `done` in run state before archive |
| G8 | OpenSpec `init` depends on global config and strips `OPENSPEC` markers | Private `XDG_CONFIG_HOME` + `--profile core`; factory markers are `<!-- ai-factory:start -->` |
| G9 | Graphify auto-refreshes files in `$HOME`; can shell out to `claude -p` | `GRAPHIFY_NO_AUTO_REFRESH=1 GRAPHIFY_BACKEND=none` on every call; `doctor` checks the exec wrapper sets them |
| G10 | `pre-push` is bypassable (`--no-verify`, husky `core.hooksPath`) | Env-injected `pushInsteadOf` block + blocklist + hook (installed only when hooksPath is untracked) |
| G11 | Graphify update takes 40–60 s on ~1M LOC | Updates are serialised and coalesced: merges that land during a running update are covered by the next one; tasks start only after the update that covers their deps finishes (ADR-0007) |
| G12 | Ponytail levels need its runtime | Static `AGENTS.md` + selected level row |
