# ADR-0007: Serialised, coalesced graph updates

**Context.** Incremental `graphify update` takes 2–5 s on 25–92k LOC repos but 47–64 s on ~900k LOC (measured). The locked decision is an incremental update after every task merge, so later tasks see merged code.

**Decision.** A single graph-update worker:
- Each merge enqueues an update.
- If merges land while an update is running, one following update covers all of them.
- A task is dispatched only when the latest finished update covers every one of its deps' merges (tracked by a merge sequence number).
- Queries during an update are safe (atomic writes, verified), but context packs are written only from a covered graph.

**Consequences.** Every merge is reflected before dependent work starts, and there are no redundant back-to-back updates. `status` shows the graph lag.

**Implemented (slice 9).**
- **`GraphUpdater`** (`src/graph/updater.ts`) runs one `graphify update <root> --force` at a time (`--force` lets the graph shrink after deletions).
  - Requests arriving while an update runs collapse into one follow-up. The merge sequence it covers is stored as `graphSeq` in the run state, and `status` shows the lag.
  - A task records its `mergeSeq` when it merges. Before an attempt, a task waits until `graphSeq` covers its dependencies' merges. Independent tasks do not wait.
  - A failed update still counts as covered: the graph is an aid, agents fall back to grep, and nothing deadlocks.
- **Builds.** `init` builds the graph after its commit (`--no-graph` skips it). `run` builds it before the explorers if it is missing. `ai-factory graph [--full]` updates it by hand.
- **Affected tests.** Gates add test files that, according to the graph, import, call or reference the changed files (`dependentFiles`). The graph's workspace paths are mapped to worktree paths through the repo path.
- **Measured** (tooling.md §3): 2–5 s per incremental update on 25–92k LOC, 47–64 s on ~900k LOC. Coalescing keeps large workspaces from queueing an update per merge.
