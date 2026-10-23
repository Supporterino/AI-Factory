# Git spikes (git 2.54.0, macOS)

1. Submodule git dir: `git -C repos/backend rev-parse --git-dir` → `<ai>/.git/modules/repos/backend` (core.worktree set to ../../../../repos/backend).
2. Task worktree from submodule: `git -C repos/backend worktree add -b change/<id>--<task> <abs>/.factory/worktrees/<id>/<repo>/<task> change/<id>` works. `worktree list` shows the main worktree as the modules gitdir path (quirk, harmless).
3. A branch can only be checked out in one worktree → task branches must be distinct: `change/<id>--<task>` (NOT `change/<id>/<task>`, which collides with ref file `change/<id>`). Temporary, deleted after merge.
4. Merge-back: rebase task branch onto change/<id> in task worktree, re-run gates, then `git -C repos/<repo> merge --ff-only change/<id>--<task>` in the repo's main checkout (which has change/<id> checked out). Then `worktree remove` + `branch -d`.
5. AI repo then shows ` M repos/backend` (pointer moved) — `.factory/` must be gitignored (worktrees live under it).
6. Hooks: `git rev-parse --git-path hooks` → `.git/modules/<path>/hooks`; shared by all worktrees of that repo. With `core.hooksPath` set (husky) it returns the relative `.husky` → installing there would dirty the submodule's tracked tree.
7. pre-push hook with env marker `AI_FACTORY_AGENT` blocks agent pushes (exit 1). `--no-verify` bypasses hooks.
8. Strong backstop: inject into agent process env `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=url.ai-factory-push-blocked://.pushInsteadOf GIT_CONFIG_VALUE_0=` → every push fails (even --no-verify) with "remote helper 'ai-factory-push-blocked' aborted", fetch unaffected. No on-disk config change.
9. Detached HEAD in submodule (normal after `submodule update`): `git switch -c change/<id> <defaultBranch or origin/<defaultBranch>>` works.
10. repoint after squash-merge: `Change-Id` trailers are LOST with a plain squash (GitLab default squash msg = MR title). Detection order: (a) `git log --grep='^Change-Id: <id>$' origin/<default>`; (b) merge commit with the change tip as a parent (`git log --merges --ancestry-path`); (c) patch-id match: `git diff $(merge-base) change/<id> | git patch-id --stable` == `git show <c> | git patch-id --stable` for commits on origin/<default> after the base. Verified (c) matches on a squash. Ambiguous/no match → report, don't guess.
