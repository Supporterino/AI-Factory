---
"@supporterino/ai-factory": minor
---

Reviewers and contract reviewers are now told to set `file` to the change's spec path when the correct fix is a wording change, instead of the code file where the mismatch shows. If a `review-fix` task still blocks with a reason naming `openspec`, the factory moves its finding into `specFindings`, drops the impossible task and pauses with the `reword`/`reapprove` reason instead of failing the change. Findings are kept on the fix task so the fallback moves the exact finding, not just the blocked task's free-text reason.
