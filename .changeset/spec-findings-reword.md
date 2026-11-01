---
"@supporterino/ai-factory": minor
---

Spec findings no longer dead-end at the implementer. Review findings that point at `openspec/changes/<id>/` are recorded and pause the change; `ai-factory reword <id>` lets the architect apply them (wording and clarity only, task DAG unchanged) and `ai-factory reapprove <id>` accepts a hand edit. Both commit `docs(spec): reword <id>` and re-stamp the approval hash without reloading task progress, and a failed attempt restores the spec.
