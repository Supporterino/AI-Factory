# ADR-0009: `AgentRuntime` seam and stub provider

**Context.** Integration tests must run the full pipeline without real LLMs. Plugin enforcement can only be proven against a real opencode process.

**Decision.**
- `AgentRuntime` (start a session in a dir with an agent and permissions, prompt, await a handoff, collect usage) has two implementations from day one:
  - `OpencodeRuntime` (real)
  - `ScriptedRuntime` (fake, replays scripted handoffs and file edits)
- For enforcement tests, a tiny Anthropic-compatible HTTP stub provider scripts tool calls, such as "edit `.opencode/x`" or "run `sh -c 'git push'`", against a real pinned opencode. These tests are skipped when opencode is not installed.

**Consequences.** Fast, deterministic pipeline tests, plus real proof for the security rules. `bench ponytail` is the only real-model path.
