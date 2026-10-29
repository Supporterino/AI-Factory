---
"@supporterino/ai-factory": minor
---

**Breaking:** `ai-factory run --interactive` was removed. Use `ai-factory refine "<request>"` and `ai-factory run --request <file>` for a pre-run interview.

`run` now asks the questions the intake orchestrator and architect raise in their handoffs when stdin is a terminal, sends the answers back to the same session, and records the Q&A in `openspec/changes/<id>/questions.md` and `.factory/clarifications/<id>.md`. `workflow.clarifyRounds` (default 2) caps the rounds per phase; questions beyond the cap are recorded unanswered. `--no-interactive`, or no TTY, records the questions without asking and continues.
