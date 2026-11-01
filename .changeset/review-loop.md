---
"@supporterino/ai-factory": minor
---

Add `workflow.reviewRounds` (1–10, default 1). Above 1, every touched repo is re-reviewed after a fix round until a pass finds no `must`/`should` code findings or the cap is reached; the last fix round still runs and remaining findings stay in the report. The tester still runs once per repo. Fix task ids are now round-scoped so later passes cannot collide with earlier ones.
