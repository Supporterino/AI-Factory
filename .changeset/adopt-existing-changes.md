---
"@supporterino/ai-factory": minor
---

Add `ai-factory adopt` for OpenSpec workspaces that already have pending changes when the factory is installed. It registers changes in `.factory/runs/`, validates them, and leaves all git state and model calls alone. `approve` creates the change branch lazily; `--normalize` lets the architect add the factory's per-task `repo`/`deps`/`touches` metadata without changing intent; `--preserve-progress` keeps already checked tasks merged for partially implemented changes. `init` and `doctor` point at pending changes that are not adopted yet.
