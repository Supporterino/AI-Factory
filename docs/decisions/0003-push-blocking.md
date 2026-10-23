# ADR-0003: Push blocking in three layers

**Context.** `git push --no-verify` skips `pre-push`. Repos with `core.hooksPath` (husky) keep hooks in a tracked dir, and installing there would dirty the submodule.

**Decision.**
1. **Agent environment** (primary): the opencode server is started with `GIT_CONFIG_COUNT/KEY/VALUE` setting `url.ai-factory-push-blocked://.pushInsteadOf=""`. Every push fails, even with `--no-verify`; fetch still works. Verified with git 2.54.
2. **Shell blocklist** in the plugin: blocks `git push`, attempts to clear `GIT_CONFIG_*`, and `--no-verify`.
3. **`pre-push` hook:** installed in `git rev-parse --git-path hooks` only when that path is inside `.git/` (untracked). It rejects pushes while `.factory/active.lock` exists and `AI_FACTORY_AGENT` is set. For husky repos, `doctor` reports "hook not installable, layers 1+2 active".

**Consequences.** Manual pushes by the user are unaffected, because they don't have the env marker.
