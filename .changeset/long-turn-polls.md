---
"@supporterino/ai-factory": patch
---

Keep polling opencode's `/wait` in 60 s slices so an agent turn longer than 5 minutes no longer fails with "opencode server unreachable" (Node's `fetch` headers timeout), and report client-side timeouts as such instead.
