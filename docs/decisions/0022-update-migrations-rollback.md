# ADR-0022: Update, migrations and rollback

**Context.** §10 asks for an `update` that keeps user edits, migrates the config, refreshes tools, ends as one commit and can be undone. It must not disturb a running change or touch submodules and specs.

**Decision.**
- **Merge base.** The lock records each managed file's sha256 and git blob id (ADR-0014). On update:
  - Unchanged files (hash matches the lock) are overwritten.
  - Edited files are merged with `git merge-file`: yours, the previous template (the blob from the lock) and the new template. Block-managed files (`AGENTS.md`, `.gitignore`) merge only the ai-factory block.
  - Deleted files stay deleted unless `--restore`. `unmanaged` paths are never written.
  - After a merge the lock records the new render, so the next update merges against it.
- **Conflicts.** A conflicted merge writes markers (`yours` / `previous template` / `new template`), lists the files, commits nothing and exits 4. You resolve and commit by hand, or run `rollback`.
- **Migrations.**
  - Each migration is `src/migrations/NNN-<name>.ts` with `{from, to, name, migrate(text)}`. It is pure text to text and uses jsonc-parser edits, so comments and formatting survive. Each has a test.
  - They run in order from the config's `schemaVersion`. A gap, or a version newer than the factory, is an error.
  - Other commands refuse an older config and point to `update`; nothing migrates silently.
  - A migration changes defaults only where the user kept the old default.
- **Preconditions.**
  - `update` refuses while a change is active, queued, or paused with tasks, unless `--force`. It also needs a clean AI repo.
  - It prints the plan, and `--dry-run` stops there.
- **Snapshots.** `approve` (again at activation if missing) copies `.opencode/agents` into the change's integration worktree. opencode picks the nearest `.opencode/agents` for a session directory (verified on 2.1.2 and 2.2.0). It also writes the gate configuration and the profile gate tables to `.factory/runs/<id>/snapshot/gates.json`, and gates for that change, `ai-factory gate <id>` included, resolve from it (audit P18, G9).
- **The change branch is never updated (audit P17, G7).** `update` refuses to commit onto a `change/*` branch, even with `--force`: you switch the AI repo to the base branch, update there, and `resume` switches back. So every session of a change, architect and reviewer included, reads its agents from the change's own branch, which still has the definitions it was approved with. (Before, a forced update committed onto `change/<id>`; in the single-repo layout new task worktrees then carried the new agents.)
- **Vendored files (audit G5).** A modified or deleted Ponytail file is a hash mismatch, never a user edit or deletion: `update` stops, and `update --restore` puts the vendored copy back.
- **Tool pins and the graph (audit G6).** The lock's tool ranges always follow the factory version (they are its requirements). `--tools` rebuilds the graph when its format changed or another Graphify release built it; a plain `update` only warns, and `doctor` reports it.
- **Backup and rollback.**
  - Every path the update may write is copied to `.factory/backups/<timestamp>/` first, with a manifest of the files that existed and the ones that will be created. A no-op update deletes its backup.
  - `rollback` restores the newest unrestored backup (including the previous lock and config), deletes created files, marks the backup restored and commits `chore(factory): roll back update to vX`. It works on committed and on uncommitted (conflicted) updates.
  - `git revert` of the update commit is equivalent.
- **Scope.**
  - The update commit contains only install paths (ADR-0014).
  - Submodules are touched only for hook reinstalls, which are not versioned files.
  - `openspec/specs` and `openspec/changes` are never written, apart from the `.gitkeep` placeholders.
- **`--tools`.** Regenerates OpenSpec's opencode commands and skills (in a scratch directory) and merges them like other managed files, and runs a full graph rebuild after the commit when the lock's graph `schemaVersion` differs from the pinned Graphify's.
- **Fleet.** No fleet mode in the CLI. `docs/fleet-update.sh` loops over workspaces with a dry run and then the update, and reports what it skipped. It never pushes.
- **Fixture snapshots.** `test/fixtures/make-install-snapshot.ts` stores each release's install (`install-<version>.json`). The upgrade test starts from the previous one.

**Consequences.**
- User edits to agents and standards survive upgrades, and conflicts are visible as ordinary markers.
- Every template change needs a CHANGELOG entry. Every config schema change needs a migration, a test and a new install fixture.
- A forced update while a change runs needs one `git switch` by hand; in exchange no session of that change can see newer agent text.
