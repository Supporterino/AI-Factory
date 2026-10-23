# ADR-0007: Serialised, coalesced graph updates

**Context.** Incremental `graphify update` takes 2–5 s on 25–92k LOC repos but 47–64 s on ~900k LOC (measured). The locked decision is an incremental update after every task merge, so later tasks see merged code.

**Decision.** A single graph-update worker:
- Each merge enqueues an update.
- If merges land while an update is running, one following update covers all of them.
- A task is dispatched only when the latest finished update covers every one of its deps' merges (tracked by a merge sequence number).
- Queries during an update are safe (atomic writes, verified), but context packs are written only from a covered graph.

**Consequences.** Every merge is reflected before dependent work starts, and there are no redundant back-to-back updates. `status` shows the graph lag.
