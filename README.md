# ai-factory

[![CI](https://github.com/supporterino/ai-factory/actions/workflows/ci.yml/badge.svg)](https://github.com/supporterino/ai-factory/actions/workflows/ci.yml)

A repo-local AI software factory. You describe a change; the factory writes an [OpenSpec](https://github.com/Fission-AI/OpenSpec) spec, waits for your approval, then has [opencode](https://opencode.ai) agents implement, test and review it across your repos, guided by one [Graphify](https://pypi.org/project/graphifyy/) knowledge graph of the workspace.
- **One human gate:** the spec approval. Everything after it runs on its own, and pauses with a report when it cannot finish.
- **Local commits only.** Nothing is pushed and no merge request is opened. You review the `change/<id>` branches and push them yourself. When a change is done, `ai-factory land <id>` merges it into the local base branches and cleans up.
- **Two layouts:** a single repo, or an "AI repo" that holds your code repos as git submodules.
- **Language profiles** (stackable per repo): TypeScript/JavaScript, React, Python, Go, Rust, Swift, Helm, Tauri v2.

How it works inside: [ARCHITECTURE.md](ARCHITECTURE.md). Every command: [docs/cli.md](docs/cli.md). Design decisions: [docs/decisions/](docs/decisions/). Changes per version: [CHANGELOG.md](CHANGELOG.md).

## Install

Requirements: macOS or Linux, Node ≥ 20 or Bun ≥ 1.3, and these tools on `PATH`:

| Tool     | Version                             | Install                                            |
| -------- | ----------------------------------- | -------------------------------------------------- |
| git      | ≥ 2.31                              | Xcode CLT or your package manager                  |
| opencode | 2.1.x–2.2.x (≥ 2.1.2; tested 2.2.0) | `npm install --global @opencode/cli@2.2.0`         |
| OpenSpec | 1.x (≥ 1.10)                        | `npm install --global @fission-ai/openspec@1.14.3` |
| Graphify | 0.9.x (≥ 0.9.93)                    | `uv tool install graphifyy==0.9.93`                |

Plus credentials for the model providers you configure, either exported (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …) or stored with `opencode auth login`. The factory copies the configured providers' stored credentials into its private runtime database at startup, so they never enter your config or git.

Run the CLI without installing it:

```bash
bunx @supporterino/ai-factory@0.3.0 init
```

`npx @supporterino/ai-factory@0.3.0 init` works too. The package is `@supporterino/ai-factory`; its command is `ai-factory`, so after `npm install --global @supporterino/ai-factory` you run `ai-factory init`. Note: the unscoped npm package `ai-factory` is an unrelated project. To run it from a checkout of this repository instead, build it with `bun install && bun run build`, then run `node dist/cli.js` (or `npm link` it).

`init` is idempotent. It detects the layout, languages, contracts and existing `opencode.json` instructions, and writes `factory.config.jsonc` from what it found, so edit that file afterwards. It also renders the agents, plugin, standards, skills and OpenSpec's commands into `.opencode/`, installs the `pre-push` hooks, builds the graph, writes `factory.lock.json`, and commits it all as `chore(factory): init vX.Y.Z`. On a first install it archives replaced custom agents, commands and skills under `.factory/legacy/<timestamp>/`; `init --plan` shows that plan without writing. Then check the setup:

```bash
ai-factory doctor
```

`doctor` prints the resolved gate command per repo and flags anything a run would trip over: a missing toolchain, a model your credentials can't reach, a missing hook, an uninitialised submodule.

### Shell completion

`ai-factory` completes commands, flags and values (change and task ids, repos, agents, models, files and bench levels) in bash, zsh and fish:

```bash
ai-factory completion zsh            # print the script
ai-factory completion zsh --install  # add an idempotent block to ~/.zshrc
ai-factory completion --install      # detect the shell from $SHELL
```

## Layouts

**Single repo.** The factory lives in the repo itself (`repos: [{ "path": "." }]`). Agents may never edit the factory's own files (`.opencode/`, `.factory/`, `factory-records/`, `openspec/specs/`, the config, the lock, `AGENTS.md`), even though they sit in the same tree.

**AI repo with submodules.** A repo that holds the factory and your code repos as submodules:

```
ai-repo/
├── factory.config.jsonc, factory.lock.json, AGENTS.md
├── .opencode/            agents (one implementer per repo), plugin, standards
├── openspec/             specs and changes
└── repos/
    ├── backend/          submodule (go, OpenAPI provider)
    ├── frontend/         submodule (typescript + react, consumer)
    └── deploy/           submodule (helm)
```

The same `change/<id>` branch is created in the AI repo and in every submodule the change touches. Task worktrees are created from each submodule's own git dir. At close, the AI repo gets a provisional pointer bump; `repoint` replaces it once your merge requests are merged upstream. Contracts between repos (OpenAPI, JSON Schema, Helm `values.schema.json`, proto) are checked by a deterministic gate plus one cross-repo review.

## The flow

```bash
ai-factory run "Add full-text search to the product list"
```

1. **Intake and design.** The orchestrator names the change. Explorers map the affected repos using the graph. The architect writes `openspec/changes/<id>/` (proposal, design, specs and `tasks.md`, with per-task `repo`/`deps`/`touches`). The CLI validates it and has the architect repair problems. `run` stops here.
2. **Approve.** Read the spec, edit it if you like, then:

   ```bash
   ai-factory approve <id>
   ```

   This commits the spec (`docs(spec): <id>`) and records its hash. Any later edit to the spec, other than a task checkbox, voids the approval. If another change is active, this one queues and starts automatically when the other one closes. Use `--no-continue` to only record the approval.
3. **Implement.** Tasks run in parallel in their own worktrees, at most `maxAgents` at a time. Tasks in one repo whose `touches` overlap run one after the other. Each task gets an affected-test gate. Merges go through a per-repo queue: rebase, gates again, fast-forward. A failing task gets three retries, then the change pauses with a report. The terminal shows each task starting (title, agent, model, attempt), its gates, retries and merges, plus a 30-second heartbeat with the elapsed time and current tool while agents and gates run. `--verbose` streams every tool call; `--quiet` keeps only merges, failures and the summary.
4. **Review, contracts, full suite.** Each touched repo gets one reviewer and one tester pass. Then come the contract gate and contract review, and finally every touched repo's full suite. Findings and failures become fix tasks.
5. **Close.** The CLI mirrors the checkboxes, bumps the pointers, archives the spec and writes the report to `.factory/reports/<id>.md`. It makes local commits only.

While it runs, or after it stops:

| Situation                                                                                             | Command                                                      |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| See what is happening: phase, task DAG, worktrees, gate results, token usage                          | `ai-factory status [<id>] [--json]`                          |
| See AI usage across every change and quick task in the workspace                                      | `ai-factory usage [--json]`                                  |
| Watch it from a second terminal (refreshes every 2 s until Ctrl-C)                                    | `ai-factory status <id> --watch`                             |
| It paused because a task failed three times: fix it in the task's worktree (path in the report), then | `ai-factory retry <id> --task <n>`                           |
| It paused, was aborted, or the process died: continue from the last consistent state                  | `ai-factory resume <id>`                                     |
| Stop it safely (branches and worktrees stay, the lock is released)                                    | `ai-factory abort <id>`                                      |
| Run the gates by hand                                                                                 | `ai-factory gate <id> [--task <n>] [--repo <name>] [--full]` |
| Your submodule MRs were merged upstream: replace the provisional pointers                             | `ai-factory repoint <id>`                                    |
| The change is reviewed: merge it locally into the base branches and clean up                          | `ai-factory land <id> [--dry-run]`                           |
| Commit a change's report, approval and usage (`artifacts.mode: "git"`), or backfill past changes      | `ai-factory artifacts sync <id>` / `--all`                   |

Exit codes: 0 ok, 3 config invalid, 4 precondition, 5 gate failed, 6 paused/aborted, 10 detection drift ([full table](docs/cli.md#exit-codes)).

### Refinement and quick tasks

```bash
ai-factory refine "make the imports faster"   # ask scope/verification questions, write .factory/requests/<slug>.md
ai-factory run --request .factory/requests/make-the-imports-faster.md
ai-factory run "make the imports faster"      # agents may ask questions during intake/design
ai-factory quick "fix the login typo" --repo frontend   # add --agent <id> for a custom implementer
```

`refine` asks a few questions before any model work starts. During `run`, the intake orchestrator and architect may raise questions; the CLI asks them in the terminal and records the Q&A in the change. Pass `--no-interactive` to record without asking. Spec approval is still the only hard gate. `quick` is the no-OpenSpec path: it creates a `task/<slug>` branch, implements, runs the gates, runs one review pass, and makes one local commit. It never pushes.

## Configuration reference

`factory.config.jsonc` (JSONC, validated on every command; the editor schema is `.opencode/schemas/factory.config.schema.json`):

| Key                                                                                            | Default                                                                                                                   | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `$schema`                                                                                      | `./.opencode/schemas/factory.config.schema.json`                                                                          | JSON Schema for editor completion and checks; the factory keeps it current.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `schemaVersion`                                                                                | `4`                                                                                                                       | Config format. `ai-factory update` migrates older ones; v2/v3 stay readable until you update.                                                                                                                                                                                                                                                                                                                                                                                                             |
| `layout`                                                                                       | detected                                                                                                                  | `"single"` or `"submodules"`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `repos[]`                                                                                      | detected                                                                                                                  | `{ name, path, role: "code" \| "orchestration", languages[], defaultBranch?, subPaths?[] }`.`languages` stacks profiles (`typescript`, `react`, `python`, `go`, `rust`, `swift`, `helm`, `tauri`). A Tauri v2 app is detected as `typescript` (plus `react`) for the frontend and `rust` + `tauri` for `src-tauri/`, where the `tauri` profile runs the cargo gates. `subPaths` overrides languages for monorepo packages. In the submodule layout, the AI repo is the one `orchestration` repo at `"."`. |
| `models.{orchestrator, architect, reviewer, contractReviewer?, implementer, tester, explorer}` | Opus for architect/reviewer, Sonnet for orchestrator/implementer/tester, Haiku for explorer                               | opencode ids `"provider/model[#variant]"`.`contractReviewer` falls back to `reviewer`.`models.roles`, `models.repos.<repo>` and `models.agents.<id>` override the flat entries; `fallback[]` lists alternates.                                                                                                                                                                                                                                                                                            |
| `instructions.{workspace, repos.<repo>}`                                                       | `[]`, `{}`                                                                                                                | Project docs (security bars, language bars, API contracts) injected into opencode sessions. The reviewer/tester prompts also name them.                                                                                                                                                                                                                                                                                                                                                                   |
| `skills.{sources, roles, repos}`                                                               | `[".opencode/skills"]`, `{}`, `{}`                                                                                        | Skill ids each role loads first; the skill tool is enabled for those roles. `sources` is where `doctor` looks for `SKILL.md`.                                                                                                                                                                                                                                                                                                                                                                             |
| `mcp.roles.<role>`                                                                             | `{}`                                                                                                                      | MCP tool action patterns a role may call (e.g. `["mantine_*"]`). Without an entry MCP tools stay on `ask`, which headless runs reject.                                                                                                                                                                                                                                                                                                                                                                    |
| `agents[]`, `routing[]`                                                                        | `[]`, `[]`                                                                                                                | Optional specialist agents (`id`, `phase`, `prompt` or `promptFile`, `model`, `skills`, `edits`, `shell`, `web`, `mcp`) and path-to-agent routing for implementation tasks.                                                                                                                                                                                                                                                                                                                               |
| `gates.maxRetries`                                                                             | `3`                                                                                                                       | Retries per task after the first attempt.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `gates.scripts`                                                                                | `format:check`, `lint`, `typecheck`, `test`, `test:affected`                                                              | Script or target names looked up in `package.json`, `Makefile`, `justfile` and `Taskfile.yml`.                                                                                                                                                                                                                                                                                                                                                                                                            |
| `gates.overrides.<repo>.<gate>`                                                                | `{}`                                                                                                                      | A literal command, which wins over scripts and profile defaults. `"skip"` turns that gate off. Placeholders: `{files}`, `{testFiles}`, `{packages}`, `{crates}`, `{charts}`, `{base}`.                                                                                                                                                                                                                                                                                                                    |
| `gates.extra[]`                                                                                | `[]`                                                                                                                      | Conditional gates: `name`, `type`, `phases`, `when.changed`, `command`, `env`, `setup`, `outputs`, `checkOnly`, `timeoutMs`.`outputs` makes it a generated-artifact drift gate.                                                                                                                                                                                                                                                                                                                           |
| `contracts[]`                                                                                  | detected                                                                                                                  | `{ kind: openapi \| proto \| json-schema \| helm-values \| generated \| crd \| ipc \| custom, provider, path, consumers[], command?, outputs?, allowBreaking?, validate?{<consumer>: cmd} }`.`generated`/`crd`/`ipc` contracts run their command and fail on output drift. In `validate` commands, `{contract}` is the absolute path of the provider's new contract.                                                                                                                                      |
| `commits.{style, scopes}`                                                                      | `"conventional"`, `false`                                                                                                 | `"gitmoji"` keeps the Conventional prefix and adds the emoji; `scopes` adds the repo name to task commits.                                                                                                                                                                                                                                                                                                                                                                                                |
| `workflow.{refine, quick}`                                                                     | `true`, `{enabled: true, branchPrefix: "task/"}`                                                                          | Enables `workflow.refine` and `workflow.clarifyRounds`; `quick` enables `ai-factory quick`.                                                                                                                                                                                                                                                                                                                                                                                                               |
| `release.detect`                                                                               | `true`                                                                                                                    | Detects release-please, goreleaser, changesets and forge CI, and reports them in `doctor`; no workflow is edited.                                                                                                                                                                                                                                                                                                                                                                                         |
| `parallel.maxAgents`                                                                           | `4`                                                                                                                       | Concurrent agent sessions.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `parallel.maxGateProcesses`                                                                    | `2`                                                                                                                       | Concurrent gate processes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `parallel.withinRepo`                                                                          | `"worktrees"`                                                                                                             | `"serial"` runs one task per repo at a time.                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `runtime.turnTimeoutMinutes`                                                                   | `60`                                                                                                                      | Per agent turn wall-clock limit. A timed-out turn is interrupted and retried; raise this for very long builds or slow models.                                                                                                                                                                                                                                                                                                                                                                             |
| `tokens.contextPackMaxTokens`                                                                  | `8000`                                                                                                                    | Cap on each task's context pack.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `tokens.gateOutputMaxLines`                                                                    | `80`                                                                                                                      | Compacted gate output fed back to agents.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `tokens.mode`                                                                                  | `"report"`                                                                                                                | Usage is reported, never enforced.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `addons.ponytail.{enabled, ref, roles, level, shortcutComments}`                               | `true`, pinned ref, `["implementer","reviewer"]`, `"full"`, `"report"`                                                    | See [Ponytail](#ponytail).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `logs.retentionDays`                                                                           | `14`                                                                                                                      | How long logs are kept.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `logs.redact`                                                                                  | `true`                                                                                                                    | Redacts secrets from the logs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `artifacts.{mode, reports, approvals, usage}`                                                  | `"local"`, `true`, `true`, `true`                                                                                         | `"git"` commits each finished change's final report, approval and usage ledger under `factory-records/` (see [ADR-0035](docs/decisions/0035-tracked-artifacts.md)). Logs, paused reports and run state always stay local.                                                                                                                                                                                                                                                                                 |
| `graph.exclude`                                                                                | node_modules, vendor, target, dist, build, coverage, .next, `__pycache__`, .venv, .factory, factory-records, graphify-out | Paths the graph skips.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `security.sandbox`                                                                             | `"auto"`                                                                                                                  | Run agent shells and gates in an OS sandbox: macOS `sandbox-exec` when present. It blocks writes outside the session's worktree, edits to rc and git files, reads of credential files, git credential helpers and ssh. `"off"` disables it. Other platforms have no sandbox yet; `doctor` warns.                                                                                                                                                                                                          |
| `websearch`                                                                                    | `{"provider":"random"}`                                                                                                   | opencode's web search provider for agents: a provider id, `"random"` to reuse an available provider until it is rate limited, or `false` to remove the tool. A provider must be selected; otherwise opencode asks interactively and a headless run cancels the search after a minute.                                                                                                                                                                                                                     |
| `unmanaged[]`                                                                                  | `[]`                                                                                                                      | Managed files you want to own completely: `update` never touches them.                                                                                                                                                                                                                                                                                                                                                                                                                                    |

`workflow.refine` enables the agent-raised questions described under [Refinement and quick tasks](#refinement-and-quick-tasks); `workflow.clarifyRounds` (default 2) caps the rounds per phase. `run --interactive` was removed in favour of `refine` + `run --request`.

You can edit the agents in `.opencode/agents/` and the standards in `.opencode/standards/`. `update` merges your edits with new templates. `detect` shows drift between the workspace and the config, and `detect --apply` adds new repos' implementers, scopes and hooks. Built-in agents other than the orchestrator may use read-only web search/fetch; custom agents need `web: true`.

## Updating

```bash
bunx @supporterino/ai-factory@<new> update --dry-run   # print the plan
bunx @supporterino/ai-factory@<new> update             # one commit: chore(factory): update to vX.Y.Z
bunx @supporterino/ai-factory@<new> rollback           # undo it
```

`update` migrates the config while keeping your comments. It replaces managed files you didn't touch, merges three-way the ones you edited (a conflict leaves markers and commits nothing), and keeps deleted files deleted unless `--restore`. `--tools` also refreshes OpenSpec's files and rebuilds the graph if its format changed. It refuses while a change is in progress unless `--force`; a running change keeps the agent and gate definitions it was approved with. For many workspaces, see [docs/fleet-update.sh](docs/fleet-update.sh).

## Ponytail

[Ponytail](https://github.com/DietrichGebert/ponytail) (minimal-code guidance) is vendored at `v5.3.2@16352ac2`, verified by content hash, and injected only into implementer and reviewer prompts. The factory's rules and your standards take precedence over it. `shortcutComments: "report"` collects `shortcut:` comments into the report, and `"forbid"` fails the gate on them.

**Default.** `enabled: true` is provisional. `ai-factory bench ponytail` compares runs with and without it on your models: tokens, diff size, first-attempt pass rate, retries, coverage and review findings. It writes the result to `docs/bench/`. The bench makes real model calls, so it prints a cost estimate and asks first. It has not been run for this release yet, and the default will be set from its result.

## Troubleshooting

| Symptom                                                                    | Fix                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `uses config schemaVersion 1; this factory needs 4`                        | `ai-factory update` (it migrates v1 → v4 and keeps comments).                                                                                                                                                                         |
| `doctor`: `model … is not available to opencode`                           | Run `opencode auth login <provider>` (imported on the next run) or export the key (e.g. `ANTHROPIC_API_KEY`), or change the model. `doctor` lists the stored credentials without their values.                                        |
| `doctor` / `gate`: `no format gate` or `not found: golangci-lint`          | Install the tool, add a script under the name in `gates.scripts`, or set `gates.overrides.<repo>.<gate>` (`"skip"` to turn it off).                                                                                                   |
| `gate is not check-only`                                                   | Your format or lint script writes files. Point the gate at the check variant (e.g. `prettier --check`, `biome check`).                                                                                                                |
| The change paused                                                          | Read `.factory/reports/<id>.md`. Fix the code in the named worktree, then run `retry <id> --task <n>`; or run `resume <id>` after a transient failure.                                                                                |
| `the spec changed after approval`                                          | Something other than a checkbox changed in `openspec/changes/<id>/`. Review it, then run `approve <id>` again.                                                                                                                        |
| `<id> is the active change` after a crash                                  | `ai-factory resume <id>` takes over the stale lock (or `abort <id>`). `doctor` shows locks that nothing is driving.                                                                                                                   |
| `update` stopped with conflicts                                            | Resolve the `<<<<<<< yours` markers in the listed files and commit, or `ai-factory rollback`.                                                                                                                                         |
| `Ponytail add-on files were modified`                                      | `ai-factory update --restore`, or set `addons.ponytail.enabled` to `false`.                                                                                                                                                           |
| A push is rejected by the `ai-factory` pre-push hook                       | It blocks pushes from agents while a change is active. Push from your own shell, where `AI_FACTORY_AGENT` is not set.                                                                                                                 |
| Tauri: `cargo check` fails on a permission "not found"                     | A capability in `src-tauri/capabilities/` names a permission the app doesn't have. Add the plugin (`tauri add <plugin>`) or fix the identifier.                                                                                       |
| Tauri gates fail on Linux with missing `webkit2gtk`/`pkg-config` libraries | Install Tauri's Linux prerequisites on the machine that runs the gates.                                                                                                                                                               |
| An agent's command fails with `Operation not permitted`                    | The macOS sandbox stopped a write outside the session's worktree, or a read of a credential file. Agents work inside their worktree. If a repo truly needs more, set `security.sandbox` to `"off"` (weaker guarantees; see ADR-0026). |
| A task fails with "you changed how your work is checked"                   | It edited a script or target the gates run (e.g. `scripts.lint` in package.json). Change gate definitions yourself, outside a factory change.                                                                                         |
| A submodule is missing or empty                                            | `ai-factory doctor` offers `git submodule update --init`.                                                                                                                                                                             |
| Commits fail with a signing error                                          | The factory commits with your git config. Unlock your signing agent (e.g. 1Password) and run `resume`, or rerun the command.                                                                                                          |
| Agents re-read the same files a lot                                        | `status` shows wasted re-reads. Build the graph (`ai-factory graph`) so agents can query it instead.                                                                                                                                  |

Logs: `.factory/logs/<id>/` (redacted tool calls and gate results). Run state: `.factory/runs/<id>.json`.

## Adding a language profile

A profile is the language's prose standard plus a machine-readable part: test globs, markers, gate commands and install steps.
1. Add the id to `LANGUAGES` in `src/config/schema.ts`. Enum additions need no config migration, and the editor JSON schema is generated from it.
2. Add detection in `src/detect/languages.ts`: the manifest or marker files that imply it.
3. Write `templates/standards/<id>.md` from the language's primary docs:
   - a `<!-- Sources: [key] Title — URL -->` block under the title;
   - a `## Summary` of standalone bullets (they go into `AGENTS.md`);
   - under each section, a `<!-- [key] … -->` comment naming what grounds it, and `<!-- factory -->` after rules that come from the factory rather than a source.

   A test enforces the citations. The comments are stripped from agent prompts.
4. Add the profile to `PROFILES` in `src/profiles/index.ts`:
   - `testGlobs`: what the tester may edit;
   - `markers` and `targets`: where gates run;
   - `extensions` and `binDirs`;
   - `gates`: per gate type, candidates in preference order, with optional `when` requirements and `scoped` per-task variants;
   - `install`: lockfile → command;
   - `supersedes` (optional): profiles whose target in the same directory this one replaces. The Tauri profile replaces Rust in `src-tauri/`, for example.
5. If its package manager has a cache, add it to `cacheEnv` in `src/gates/install.ts`.
6. Add tests: detection (`test/detect-units.test.ts`) and gate resolution (`test/gates-resolve.test.ts`).
7. Add a changeset with `bun run changeset` (a user-facing change needs a release note). Workspaces pick up the new standard and their regenerated implementers with `ai-factory update`, then `ai-factory detect --apply` adds the language to the repos that use it.

## Development

```bash
bun install
bun run check          # biome + tsc + bun test
bun run build          # dist/cli.js and the bundled plugin
bun run changeset      # record a release note for this PR
AI_FACTORY_E2E=1 bun test test/opencode-runtime.e2e.test.ts   # real opencode, stub model server
bun scripts/e2e-transcript.ts single        # re-record docs/e2e/single.md (also: submodules)
```

The test suite builds fixture workspaces in temp dirs: a single TS repo, and an AI repo with Go, React and Helm submodules. It stubs the LLM with scripted handoffs. The manual end-to-end runs in [docs/e2e/](docs/e2e/) drive the real opencode server, git, OpenSpec, Graphify and gate toolchains, with a scripted role-aware model, so they cost nothing and can be reproduced. See ADR-0023 for what they cover and what they don't.

CI runs the full suite on Ubuntu and macOS, then smoke-tests the npm tarball and the built bundle on Node 20.3, 22 and 24. The manual `E2E` workflow runs the real-opencode runtime test against each supported opencode version (2.1.2 and 2.2.0).

### Releasing

Changesets owns the version and the changelog. Release tooling runs on Node 24; the published CLI still supports Node >=20.3.
1. Create `release/vX.Y.Z` from `main`.
2. Run `bun run release:version`. It applies the pending changesets, writes `CHANGELOG.md`, syncs `src/version.ts` and regenerates the install snapshot.
3. Review the changelog and the version files, then run `bun run check`.
4. Commit, push and open a normal PR. CI runs on it.
5. Merge the PR. The release workflow re-runs the checks, publishes the new version to npm with provenance, and creates the `X.Y.Z` GitHub Release and tag with the tarball attached.

The `npm` environment should require a reviewer. Merging a version PR is the release action; branch protection and tag protection are part of the process. Publishing is disabled until the repository variable `RELEASE_ENABLED` is `true`. The first publish is manual because npm trusted publishing requires an existing package; set the variable after publishing 0.2.0 and configuring the trusted publisher. On npm, configure workflow `release.yml`, environment `npm`, and allow direct `npm publish` (not stage-only). `package.json`'s `repository.url` must match the GitHub repository exactly. See ADR-0029.
