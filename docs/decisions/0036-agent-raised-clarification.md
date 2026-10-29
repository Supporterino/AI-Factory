# ADR-0036: Agent-raised clarification during intake and design

**Context.** Agents cannot ask the user directly: the runtime is a private headless
`opencode serve`, every agent denies the `question` permission, and `OpencodeRuntime` rejects
permission prompts. The only clarification was the fixed pre-intake questionnaire behind
`run --interactive` / `refine`. It asks five generic questions before any repo or request
context exists, and the agents' own `openQuestions` were only harvested into the close report.

**Decision.**
- The CLI asks the questions an agent lists in the handoff `openQuestions`, after the intake
  orchestrator and after the architect. The answers are sent back as a follow-up prompt in the
  same agent session, so the agent updates the request or spec with its context intact.
- `run` asks by default when stdin is a terminal and `workflow.refine` is true.
  `--no-interactive` records the questions and continues. Without a TTY, nothing is asked and
  nothing blocks; the questions are recorded unanswered.
- `workflow.clarifyRounds` (default 2, range 1–10) caps the rounds per phase. Questions raised
  after the cap are recorded unanswered and the phase proceeds.
- The Q&A is written to `openspec/changes/<id>/questions.md` (committed with the spec, so the
  approver sees it) and `.factory/clarifications/<id>.md` (gitignored, for resume and reports).
  The change file uses a marked block so an architect-authored file is preserved.
- Run state records every question with `answered`, `skipped` or `unanswered`, which makes
  resume idempotent: answered and skipped questions are not asked again.
- `run --interactive` is removed. Use `ai-factory refine "<request>"` and
  `run --request <file>` for a pre-run interview; the standalone `refine` command stays
  available. This supersedes the `run --interactive` part of ADR-0030.

**Consequences.**
- A clarification round costs one extra model turn per round, only when an agent actually asks.
- Agents must put human-only questions in `openQuestions`; safe assumptions belong in `risks`
  so a run with no terminal still makes progress.
- Answers in `questions.md` are part of the change and the approval hash. Do not put secrets in
  them; `.factory/clarifications/` stays local.
- Mid-implementation, review and test blockers keep the existing pause/retry behaviour; only
  intake and design ask.
