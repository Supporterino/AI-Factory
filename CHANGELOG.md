# Changelog

All notable changes per release. `ai-factory update` applies them to an installed workspace (see [docs/cli.md](docs/cli.md#update)).

## 0.2.0

### Breaking (handled by `update`)

- Config `schemaVersion` 2. Migration `001-graph-exclude-defaults` replaces the default `graph.exclude` list with the wider v2 default (adds `vendor`, `build`, `coverage`, `.next`, `__pycache__`). A customised list is kept as is. Commands refuse a v1 config until you run `ai-factory update`.

### Added

- `ai-factory update [--dry-run] [--tools] [--restore] [--force]`: config migrations, three-way merge of edited managed files, a backup per update and one `chore(factory): update to vX.Y.Z` commit.
- `ai-factory rollback`: restores the latest update backup, including the previous lock.
- Approving a change snapshots its agent definitions and gate tables, so a forced update never changes a running change.
- `docs/fleet-update.sh`: an example for updating many workspaces.
- `ai-factory doctor`: checks tool versions and lock drift, the install, submodules, clean trees, hooks, the resolved gate table with toolchain lookup, cache sizes, model availability, graph freshness and stale locks.
- `README.md`, `ARCHITECTURE.md`, and E2E transcripts per layout in `docs/e2e/`, recorded with real opencode and a scripted model (`scripts/e2e-transcript.ts`).

### Fixed

- The architect and tester agents get edit permissions for their own paths (change and context folders, test globs). Before, opencode's permission layer denied their writes.
- Closing a change removes its agent snapshot and empty worktree folders, and `status` no longer lists the snapshot as a worktree.
- Full-suite gate results are written to the change's log.

### Changed

- Implementer agents: a rule for merge-conflict tasks (change only the conflicted files, keep both intents).
- `AGENTS.md` block: query the workspace graph before reading files.

## 0.1.0

First release: `init`, `detect`, `gate`, `repoint`, `run`, `approve`, `resume`, `status`, `retry`, `abort`, `graph` and `bench`. Includes the OpenSpec workflow, the Graphify workspace graph, the opencode agents and plugin guard, the contract gate and the Ponytail add-on.
