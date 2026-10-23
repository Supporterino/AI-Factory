# ADR-0005: The CLI fans out explorers

**Context.** The prompt asks for parallel `explorer` subagents per likely repo. opencode's `subagent` tool may run same-step calls concurrently, but that is LLM-driven and not bounded by `maxAgents`.

**Decision.**
1. The orchestrator's intake handoff names the likely repos.
2. The CLI starts one explorer session per repo in parallel, through the scheduler semaphore.
3. Each explorer returns a capped summary as a handoff.
4. The CLI hands the summaries to the architect session.

The architect's `subagent` permission is denied.

**Consequences.** Fan-out is deterministic, counted in usage, bounded, and testable with the fake runtime.
