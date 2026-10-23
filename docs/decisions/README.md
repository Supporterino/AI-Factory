# Architecture decision records

Short ADRs for every choice the build prompt did not lock. Format: Context / Decision / Consequences. Status is "accepted" unless noted.

| ADR                                             | Title                                                               |
| ----------------------------------------------- | ------------------------------------------------------------------- |
| [0001](0001-opencode-concurrency-model.md)      | One private `opencode serve` per run, driven via `@opencode/client` |
| [0002](0002-task-branches-and-merge-queue.md)   | Task branches `change/<id>--<task>`, rebase + ff-only merge         |
| [0003](0003-push-blocking.md)                   | Push blocking in three layers                                       |
| [0004](0004-task-metadata-format.md)            | Task metadata as indented lines in `tasks.md`                       |
| [0005](0005-explorer-fanout-by-cli.md)          | The CLI fans out explorers, not the architect                       |
| [0006](0006-graphify-integration.md)            | Graphify: own instructions, explicit `--graph`, no Graphify plugin  |
| [0007](0007-graph-update-coalescing.md)         | Serialised, coalesced graph updates                                 |
| [0008](0008-ponytail-injection.md)              | Ponytail as static prompt text with a level row                     |
| [0009](0009-agent-runtime-and-test-stubs.md)    | `AgentRuntime` seam + stub model provider for tests                 |
| [0010](0010-prompt-assembly-for-caching.md)     | Static prompt content lives in the agent body                       |
| [0011](0011-permissions-allow-deny-only.md)     | Permission rules are allow/deny only                                |
| [0012](0012-repoint-detection.md)               | `repoint` detection order                                           |
| [0013](0013-cli-runtime-and-detection-rules.md) | CLI runtime target and detection rules                              |
