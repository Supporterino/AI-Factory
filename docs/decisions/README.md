# Architecture decision records

Short ADRs for every choice the build prompt did not lock. Format: Context / Decision / Consequences. Status is "accepted" unless noted.

| ADR                                             | Title                                                              |
| ----------------------------------------------- | ------------------------------------------------------------------ |
| [0001](0001-opencode-concurrency-model.md)      | One private `opencode serve` per run, driven over its REST API     |
| [0002](0002-task-branches-and-merge-queue.md)   | Task branches `change/<id>--<task>`, rebase + ff-only merge        |
| [0003](0003-push-blocking.md)                   | Push blocking in three layers                                      |
| [0004](0004-task-metadata-format.md)            | Task metadata as indented lines in `tasks.md`                      |
| [0005](0005-explorer-fanout-by-cli.md)          | The CLI fans out explorers, not the architect                      |
| [0006](0006-graphify-integration.md)            | Graphify: own instructions, explicit `--graph`, no Graphify plugin |
| [0007](0007-graph-update-coalescing.md)         | Serialised, coalesced graph updates                                |
| [0008](0008-ponytail-injection.md)              | Ponytail as static prompt text with a level row                    |
| [0009](0009-agent-runtime-and-test-stubs.md)    | `AgentRuntime` seam + stub model provider for tests                |
| [0010](0010-prompt-assembly-for-caching.md)     | Static prompt content lives in the agent body                      |
| [0011](0011-permissions-allow-deny-only.md)     | Permission rules are allow/deny only                               |
| [0012](0012-repoint-detection.md)               | `repoint` detection order                                          |
| [0013](0013-cli-runtime-and-detection-rules.md) | CLI runtime target and detection rules                             |
| [0014](0014-install-commits-and-lock-bases.md)  | Install commits and merge bases in the lock                        |
| [0015](0015-gate-resolution-and-scope.md)       | Gate resolution, scope and the check-only guard                    |
| [0016](0016-task-commits-and-merge-queue.md)    | Task commits and merge-queue mechanics                             |
| [0017](0017-scheduler-and-change-lifecycle.md)  | Scheduler semantics and the change lifecycle                       |
| [0018](0018-enforcement-layers.md)              | Enforcement layers (plugin, CLI, git)                              |
| [0019](0019-pipeline.md)                        | Pipeline decisions                                                 |
| [0020](0020-contract-gate.md)                   | Contract gate and contract review                                  |
| [0021](0021-usage-reporting.md)                 | Usage reporting                                                    |
| [0022](0022-update-migrations-rollback.md)      | Update, migrations and rollback                                    |
| [0023](0023-doctor-and-e2e.md)                  | Doctor checks and the manual E2E method                            |
| [0024](0024-tauri-profile.md)                   | Tauri v2 profile                                                   |
| [0025](0025-grounded-standards.md)              | Standards are grounded in primary sources                          |
| [0026](0026-hardening-and-sandbox.md)           | Enforcement hardening and the OS sandbox                           |
| [0027](0027-distribution.md)                    | Distribution: package name, licence, build, no downgrades          |
| [0028](0028-defaults-and-limits.md)             | Default models, time limits and the opencode config                |
| [0029](0029-ci-and-release.md)                  | CI matrix, Changesets versioning and the release workflow          |
