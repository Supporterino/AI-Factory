# ai-factory v1 build plan

Status: approved 2026-10-23. Slices 1–4 done. Inputs: [research/tooling.md](research/tooling.md), [decisions/](decisions/).

## Modules (`src/`)

| Module                   | Responsibility                                                                                                              |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `cli/`                   | Command parsing (one file per command), `--json`, exit codes                                                                |
| `exec.ts`                | The single shell-out wrapper: timeout, captured output, env presets (OpenSpec/Graphify quiet env, agent git env)            |
| `config/`                | zod schema, JSONC read and comment-preserving edit (`jsonc-parser`), `migrations/NNN-*.ts`                                  |
| `detect/`                | Layout, languages per repo/sub-path, contract proposals, diff against config                                                |
| `templates/` + `render/` | Agents, plugin, standards, AGENTS.md block, hooks, OpenSpec config, handoff schema; deterministic rendering                 |
| `lock/` + `managed/`     | `factory.lock.json`, managed-file hashes, 3-way merge (`git merge-file`), backups, rollback                                 |
| `git/`                   | Branching (incl. detached HEAD), worktrees, merge queue, commits with `Change-Id`, pointer bumps, `repoint`                 |
| `openspec/`              | Typed wrappers over `openspec … --json`, `tasks.md` parser + checkbox mirror, approval hash                                 |
| `dag/` + `scheduler/`    | DAG validation, `touches` overlap serialisation, semaphores, atomic run state, active lock and queue                        |
| `gates/`                 | Resolution (override → repo script → profile), check-only guard, affected selection, output compaction, installs and caches |
| `runtime/`               | `AgentRuntime`: `OpencodeRuntime` (private `opencode serve` + `@opencode/client`) and `ScriptedRuntime`; rate limiter       |
| `pipeline/`              | The phase state machine from intake to close; context packs; handoff validation and repair                                  |
| `policy/`                | Pure edit-scope rules, shell parser and blocklist (incl. evasions), secret redaction; shared by the plugin and the CLI      |
| `contracts/`             | OpenAPI / JSON-Schema / proto breaking-change diff + consumer validation                                                    |
| `graph/`                 | Build, coalesced update worker, query helpers for packs                                                                     |
| `usage/`                 | Event capture, aggregation, report section, waste detection                                                                 |
| `addons/ponytail/`       | Fetch, verify, vendor, render, `shortcut:` harvest, bench                                                                   |
| `doctor/`                | All checks, with the resolved gate table                                                                                    |

The plugin (`templates/opencode/plugins/factory.ts`) imports nothing at runtime except the bundled `policy/` code, rendered into the workspace at init.

## Milestones (vertical slices, each green and committed)

| #   | Slice                                      | Done when                                                                                                    |
| --- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| 1   | Config + detect                            | zod schema, JSONC edit, detection on both fixtures, `detect` diff                                            |
| 2   | Init + templates + lock + hooks            | `init` twice gives no diff; lock records hashes; hooks and agent env                                         |
| 3   | Gates                                      | Resolution order, check-only guard, affected tests, worktree installs and caches                             |
| 4   | Git                                        | Branch AI repo + submodules (detached HEAD), worktrees, merge queue, pointer bump, `repoint` (squash)        |
| 5   | DAG + scheduler + lock/queue + resume      | maxAgents respected, overlap serialised, failure isolation, crash → resume                                   |
| 6   | Plugin guards + blocklist                  | Unit tests on `policy/`; stub-provider tests against real opencode 2.1.2                                     |
| 7   | Pipeline `run`/`approve` + packs + handoff | Full pipeline on both fixtures with `ScriptedRuntime`; approval hash survives checkbox edits                 |
| 8   | Contract gate + contract review            | Breaking OpenAPI change fails, compatible one passes                                                         |
| 9   | Graph + per-merge update                   | Coalesced worker, covered-graph dispatch rule                                                                |
| 10  | Usage reporting                            | `status` and the report show usage per agent, task and change, plus retry overhead                           |
| 11  | Ponytail + bench                           | Pinned vendoring, role injection, `forbid`/`report`, bench with cost prompt                                  |
| 12  | Update / migrations / rollback             | v(N-1) fixture upgrade keeps edits, one commit, `rollback` exact                                             |
| 13  | Doctor + docs                              | README, ARCHITECTURE (diagram, state machine, enforcement matrix, worktree commands), manual E2E transcripts |

## Risks

| Risk                                               | Mitigation                                                                                                                                                 |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| opencode V2 SDK/plugin churn (2.1.3 shipped today) | Exact minor pin, `doctor` range check, stub-provider contract tests in CI-like `bun test`                                                                  |
| Plugin-level enforcement unproven end to end       | Every rule is also enforced by the CLI (post-session scope audit of `git diff`, env push block)                                                            |
| Graph update latency on very large workspaces      | Coalescing (ADR-0007), `status` shows lag                                                                                                                  |
| OpenSpec format drift (schemas are experimental)   | Built-in `spec-driven` only; our metadata is plain indented lines; tested against 1.10 and 1.14                                                            |
| Contract diffing across OpenAPI/proto/JSON Schema  | Pure-TS diff for OpenAPI 3 + JSON Schema in v1; proto via `buf breaking` when installed, otherwise `doctor` reports it as missing (never skipped silently) |
| Real E2E and `bench` cost money                    | Both are opt-in, print an estimate and ask first                                                                                                           |
| No Rust toolchain on this machine                  | The Rust profile is unit-tested for resolution only; `doctor` reports the missing toolchain                                                                |
