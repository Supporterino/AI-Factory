---
"@supporterino/ai-factory": minor
---

Add opt-in committed change records. `"artifacts": { "mode": "git" }` snapshots a finished change's final report, approval and usage ledger into `factory-records/`, so a clone or another machine keeps them. `close`, `land` and `quick` record automatically; `ai-factory artifacts sync <id>|--all` backfills and retries. `usage` and `doctor` read both the local ledger and the committed snapshot. Config schema v4 adds the block with `"mode": "local"`, which keeps today's behaviour.
