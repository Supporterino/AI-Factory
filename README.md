# ai-factory

A repo-local AI software factory. You describe a change; the factory writes an [OpenSpec](https://github.com/Fission-AI/OpenSpec) spec, waits for your approval, then has [opencode](https://opencode.ai) agents implement, test and review it across your repos, guided by one [Graphify](https://pypi.org/project/graphifyy/) knowledge graph of the workspace.
- **One human gate:** the spec approval. Everything after it runs on its own, and pauses with a report when it cannot finish.
- **Local commits only.** Nothing is pushed and no merge request is opened. You review the `change/<id>` branches and push them yourself.
- **Two layouts:** a single repo, or an "AI repo" that holds your code repos as git submodules.
- **Language profiles** (stackable per repo): TypeScript/JavaScript, React, Python, Go, Rust, Helm, Tauri v2.

How it works inside: [ARCHITECTURE.md](ARCHITECTURE.md). Every command: [docs/cli.md](docs/cli.md). Design decisions: [docs/decisions/](docs/decisions/). Changes per version: [CHANGELOG.md](CHANGELOG.md).

## Install

Requirements: macOS or Linux, Node ≥ 20 or Bun ≥ 1.3, and these tools on `PATH`:

| Tool     | Version          | Install                                            |
| -------- | ---------------- | -------------------------------------------------- |
| git      | ≥ 2.31           | Xcode CLT or your package manager                  |
| opencode | 2.1.x (≥ 2.1.2)  | `npm install --global @opencode/cli@2.1.2`         |
| OpenSpec | 1.x (≥ 1.10)     | `npm install --global @fission-ai/openspec@1.14.3` |
| Graphify | 0.9.x (≥ 0.9.93) | `uv tool install graphifyy==0.9.93`                |

Plus credentials for the model providers you configure, either exported (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …) or stored with `opencode auth login`.

Run the CLI without installing it:

```bash
bunx ai-factory@0.2.0 init
```

`npx ai-factory@0.2.0 init` works too. To run it from a checkout of this repository instead, build it with `bun install && bun run build`, then run `node dist/cli.js` (or `npm link` it).

`init` is idempotent. It detects the layout, languages and contracts, and writes `factory.config.jsonc` from what it found, so edit that file afterwards. It also renders the agents, plugin and standards into `.opencode/`, runs `openspec init`, installs the `pre-push` hooks, builds the graph, writes `factory.lock.json`, and commits it all as `chore(factory): init vX.Y.Z`. Then check the setup:

```bash
ai-factory doctor
```

`doctor` prints the resolved gate command per repo and flags anything a run would trip over: a missing toolchain, a model your credentials can't reach, a missing hook, an uninitialised submodule.

## Layouts

**Single repo.** The factory lives in the repo itself (`repos: [{ "path": "." }]`). Agents may never edit the factory's own files (`.opencode/`, `.factory/`, `openspec/specs/`, the config, the lock, `AGENTS.md`), even though they sit in the same tree.

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
3. **Implement.** Tasks run in parallel in their own worktrees, at most `maxAgents` at a time. Tasks in one repo whose `touches` overlap run one after the other. Each task gets an affected-test gate. Merges go through a per-repo queue: rebase, gates again, fast-forward. A failing task gets three retries, then the change pauses with a report.
4. **Review, contracts, full suite.** Each touched repo gets one reviewer and one tester pass. Then come the contract gate and contract review, and finally every touched repo's full suite. Findings and failures become fix tasks.
5. **Close.** The CLI mirrors the checkboxes, bumps the pointers, archives the spec and writes the report to `.factory/reports/<id>.md`. It makes local commits only.

While it runs, or after it stops:

| Situation                                                                                             | Command                                                      |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| See what is happening: phase, task DAG, worktrees, gate results, token usage                          | `ai-factory status [<id>] [--json]`                          |
| It paused because a task failed three times: fix it in the task's worktree (path in the report), then | `ai-factory retry <id> --task <n>`                           |
| It paused, was aborted, or the process died: continue from the last consistent state                  | `ai-factory resume <id>`                                     |
| Stop it safely (branches and worktrees stay, the lock is released)                                    | `ai-factory abort <id>`                                      |
| Run the gates by hand                                                                                 | `ai-factory gate <id> [--task <n>] [--repo <name>] [--full]` |
| Your submodule MRs were merged upstream: replace the provisional pointers                             | `ai-factory repoint <id>`                                    |

Exit codes: 0 ok, 3 config invalid, 4 precondition, 5 gate failed, 6 paused/aborted, 10 detection drift ([full table](docs/cli.md#exit-codes)).

## Configuration reference

`factory.config.jsonc` (JSONC, validated on every command; the editor schema is `.opencode/schemas/factory.config.schema.json`):

| Key                                                                                            | Default                                                                                                  | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `schemaVersion`                                                                                | `2`                                                                                                      | Config format. `ai-factory update` migrates older ones.                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `layout`                                                                                       | detected                                                                                                 | `"single"` or `"submodules"`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `repos[]`                                                                                      | detected                                                                                                 | `{ name, path, role: "code" \| "orchestration", languages[], defaultBranch?, subPaths?[] }`.`languages` stacks profiles (`typescript`, `react`, `python`, `go`, `rust`, `helm`, `tauri`). A Tauri v2 app is detected as `typescript` (plus `react`) for the frontend and `rust` + `tauri` for `src-tauri/`, where the `tauri` profile runs the cargo gates. `subPaths` overrides languages for monorepo packages. In the submodule layout, the AI repo is the one `orchestration` repo at `"."`. |
| `models.{orchestrator, architect, reviewer, contractReviewer?, implementer, tester, explorer}` | Opus for architect/reviewer, Sonnet for orchestrator/implementer/tester, Haiku for explorer              | opencode ids `"provider/model[#variant]"`.`contractReviewer` falls back to `reviewer`.                                                                                                                                                                                                                                                                                                                                                                                                           |
| `gates.maxRetries`                                                                             | `3`                                                                                                      | Retries per task after the first attempt.                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `gates.scripts`                                                                                | `format:check`, `lint`, `typecheck`, `test`, `test:affected`                                             | Script or target names looked up in `package.json`, `Makefile`, `justfile` and `Taskfile.yml`.                                                                                                                                                                                                                                                                                                                                                                                                   |
| `gates.overrides.<repo>.<gate>`                                                                | `{}`                                                                                                     | A literal command, which wins over scripts and profile defaults. `"skip"` turns that gate off. Placeholders: `{files}`, `{testFiles}`, `{packages}`, `{crates}`, `{charts}`, `{base}`.                                                                                                                                                                                                                                                                                                           |
| `contracts[]`                                                                                  | detected                                                                                                 | `{ kind: openapi \| proto \| json-schema \| helm-values, provider, path, consumers[], allowBreaking?, validate?{<consumer>: cmd} }`. You confirm the detected ones.                                                                                                                                                                                                                                                                                                                              |
| `parallel.maxAgents`                                                                           | `4`                                                                                                      | Concurrent agent sessions.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `parallel.maxGateProcesses`                                                                    | `2`                                                                                                      | Concurrent gate processes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `parallel.withinRepo`                                                                          | `"worktrees"`                                                                                            | `"serial"` runs one task per repo at a time.                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `tokens.contextPackMaxTokens`                                                                  | `8000`                                                                                                   | Cap on each task's context pack.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `tokens.gateOutputMaxLines`                                                                    | `80`                                                                                                     | Compacted gate output fed back to agents.                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `tokens.mode`                                                                                  | `"report"`                                                                                               | Usage is reported, never enforced.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `addons.ponytail.{enabled, ref, roles, level, shortcutComments}`                               | `true`, pinned ref, `["implementer","reviewer"]`, `"full"`, `"report"`                                   | See [Ponytail](#ponytail).                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `logs.retentionDays`                                                                           | `14`                                                                                                     | How long logs are kept.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `logs.redact`                                                                                  | `true`                                                                                                   | Redacts secrets from the logs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `graph.exclude`                                                                                | node_modules, vendor, target, dist, build, coverage, .next, `__pycache__`, .venv, .factory, graphify-out | Paths the graph skips.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `unmanaged[]`                                                                                  | `[]`                                                                                                     | Managed files you want to own completely: `update` never touches them.                                                                                                                                                                                                                                                                                                                                                                                                                           |

You can edit the agents in `.opencode/agents/` and the standards in `.opencode/standards/`. `update` merges your edits with new templates. `detect` shows drift between the workspace and the config, and `detect --apply` adds new repos' implementers, scopes and hooks.

## Updating

```bash
bunx ai-factory@<new> update --dry-run   # print the plan
bunx ai-factory@<new> update             # one commit: chore(factory): update to vX.Y.Z
bunx ai-factory@<new> rollback           # undo it
```

`update` migrates the config while keeping your comments. It replaces managed files you didn't touch, merges three-way the ones you edited (a conflict leaves markers and commits nothing), and keeps deleted files deleted unless `--restore`. `--tools` also refreshes OpenSpec's files and rebuilds the graph if its format changed. It refuses while a change is in progress unless `--force`; a running change keeps the agent and gate definitions it was approved with. For many workspaces, see [docs/fleet-update.sh](docs/fleet-update.sh).

## Ponytail

[Ponytail](https://github.com/DietrichGebert/ponytail) (minimal-code guidance) is vendored at `v5.3.2@16352ac2`, verified by content hash, and injected only into implementer and reviewer prompts. The factory's rules and your standards take precedence over it. `shortcutComments: "report"` collects `shortcut:` comments into the report, and `"forbid"` fails the gate on them.

**Default.** `enabled: true` is provisional. `ai-factory bench ponytail` compares runs with and without it on your models: tokens, diff size, first-attempt pass rate, retries, coverage and review findings. It writes the result to `docs/bench/`. The bench makes real model calls, so it prints a cost estimate and asks first. It has not been run for this release yet, and the default will be set from its result.

## Troubleshooting

| Symptom                                                                    | Fix                                                                                                                                                                          |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `uses config schemaVersion 1; this factory needs 2`                        | `ai-factory update` (it migrates the config).                                                                                                                                |
| `doctor`: `model … is not available to opencode`                           | The server only sees the credentials of providers named in `models`. Export the provider's key (e.g. `ANTHROPIC_API_KEY`) or run `opencode auth login`, or change the model. |
| `doctor` / `gate`: `no format gate` or `not found: golangci-lint`          | Install the tool, add a script under the name in `gates.scripts`, or set `gates.overrides.<repo>.<gate>` (`"skip"` to turn it off).                                          |
| `gate is not check-only`                                                   | Your format or lint script writes files. Point the gate at the check variant (e.g. `prettier --check`, `biome check`).                                                       |
| The change paused                                                          | Read `.factory/reports/<id>.md`. Fix the code in the named worktree, then run `retry <id> --task <n>`; or run `resume <id>` after a transient failure.                       |
| `the spec changed after approval`                                          | Something other than a checkbox changed in `openspec/changes/<id>/`. Review it, then run `approve <id>` again.                                                               |
| `<id> is the active change` after a crash                                  | `ai-factory resume <id>` takes over the stale lock (or `abort <id>`). `doctor` shows locks that nothing is driving.                                                          |
| `update` stopped with conflicts                                            | Resolve the `<<<<<<< yours` markers in the listed files and commit, or `ai-factory rollback`.                                                                                |
| `Ponytail add-on files were modified`                                      | `ai-factory update --restore`, or set `addons.ponytail.enabled` to `false`.                                                                                                  |
| A push is rejected by the `ai-factory` pre-push hook                       | It blocks pushes from agents while a change is active. Push from your own shell, where `AI_FACTORY_AGENT` is not set.                                                        |
| Tauri: `cargo check` fails on a permission "not found"                     | A capability in `src-tauri/capabilities/` names a permission the app doesn't have. Add the plugin (`tauri add <plugin>`) or fix the identifier.                              |
| Tauri gates fail on Linux with missing `webkit2gtk`/`pkg-config` libraries | Install Tauri's Linux prerequisites on the machine that runs the gates.                                                                                                      |
| A submodule is missing or empty                                            | `ai-factory doctor` offers `git submodule update --init`.                                                                                                                    |
| Commits fail with a signing error                                          | The factory commits with your git config. Unlock your signing agent (e.g. 1Password) and run `resume`, or rerun the command.                                                 |
| Agents re-read the same files a lot                                        | `status` shows wasted re-reads. Build the graph (`ai-factory graph`) so agents can query it instead.                                                                         |

Logs: `.factory/logs/<id>/` (redacted tool calls and gate results). Run state: `.factory/runs/<id>.json`.

## Adding a language profile

A profile is the language's prose standard plus a machine-readable part: test globs, markers, gate commands and install steps.
1. Add the id to `LANGUAGES` in `src/config/schema.ts`. Enum additions need no config migration, and the editor JSON schema is generated from it.
2. Add detection in `src/detect/languages.ts`: the manifest or marker files that imply it.
3. Write `templates/standards/<id>.md`, with a `## Summary` section of bullet lines; agents get the summary inline.
4. Add the profile to `PROFILES` in `src/profiles/index.ts`:
   - `testGlobs`: what the tester may edit;
   - `markers` and `targets`: where gates run;
   - `extensions` and `binDirs`;
   - `gates`: per gate type, candidates in preference order, with optional `when` requirements and `scoped` per-task variants;
   - `install`: lockfile → command;
   - `supersedes` (optional): profiles whose target in the same directory this one replaces. The Tauri profile replaces Rust in `src-tauri/`, for example.
5. If its package manager has a cache, add it to `cacheEnv` in `src/gates/install.ts`.
6. Add tests: detection (`test/detect-units.test.ts`) and gate resolution (`test/gates-resolve.test.ts`).
7. Add a CHANGELOG entry. Workspaces pick up the new standard and their regenerated implementers with `ai-factory update`, then `ai-factory detect --apply` adds the language to the repos that use it.

## Development

```bash
bun install
bun run check          # biome + tsc + bun test
bun run build          # dist/cli.js and the bundled plugin
AI_FACTORY_E2E=1 bun test test/opencode-runtime.e2e.test.ts   # real opencode, stub model server
bun scripts/e2e-transcript.ts single        # re-record docs/e2e/single.md (also: submodules)
```

The test suite builds fixture workspaces in temp dirs: a single TS repo, and an AI repo with Go, React and Helm submodules. It stubs the LLM with scripted handoffs. The manual end-to-end runs in [docs/e2e/](docs/e2e/) drive the real opencode server, git, OpenSpec, Graphify and gate toolchains, with a scripted role-aware model, so they cost nothing and can be reproduced. See ADR-0023 for what they cover and what they don't.
