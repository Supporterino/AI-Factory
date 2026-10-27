---
"@supporterino/ai-factory": minor
---

Show what the factory is doing during implementation. Every agent call now prints its task, agent, model, attempt, duration and tokens; the scheduler prints retries, merge conflicts, requeues, infrastructure errors and interrupts; gates and dependency installs print when they start and finish; and a 30-second heartbeat lists running sessions and gates with elapsed time and the current tool. `--verbose` streams every tool call and gate start, while `--quiet` keeps only phase banners, merges, failures and the summary. `ai-factory status --watch [--interval <s>]` reprints the change in a second terminal.
