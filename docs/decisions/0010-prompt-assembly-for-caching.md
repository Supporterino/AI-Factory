# ADR-0010: Static prompt content in the agent body

**Context.** opencode places cache points on the first and last system parts. The system prompt order is agent body → … → AGENTS.md → instructions → date/env (cwd differs per worktree).

**Decision.**
- Each rendered `.opencode/agents/<id>.md` body contains, in order: role instructions, the stacked standards, add-ons, then the graph and handoff rules.
- Task-specific content (the context pack) is sent as the first user message.
- AGENTS.md stays short and generic.

**Consequences.** All tasks of one repo share a byte-identical cached prefix. The profile and agent size caps (≤ 150 lines) keep that prefix small.
