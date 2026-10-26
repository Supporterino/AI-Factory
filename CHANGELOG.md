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
- Tauri v2 language profile (`tauri`). It is detected from `tauri.conf.json`/`Tauri.toml` next to a `tauri` 2.x dependency. It runs the cargo gates in `src-tauri/` instead of the Rust profile (which also validates capabilities and the config), creates a missing `frontendDist` directory before compiling, and comes with its own standard. Existing workspaces get `.opencode/standards/tauri.md` on `update`; run `detect --apply` to add `tauri` to a repo.
- `ai-factory doctor`: checks tool versions and lock drift, the install, submodules, clean trees, hooks, the resolved gate table with toolchain lookup, cache sizes, model availability, graph freshness and stale locks.
- `README.md`, `ARCHITECTURE.md`, and E2E transcripts per layout in `docs/e2e/`, recorded with real opencode and a scripted model (`scripts/e2e-transcript.ts`).

### Security

- **Shell-policy and git hardening.** Fixes all enforcement bypasses from the 2026-10-26 audit (S1–S10, S12):
  - shell keywords and `cd` are parsed and tracked;
  - xargs, interpreter, awk/sed and runner evasions are closed;
  - git env, `-c` keys and exec options are restricted; `fetch` refspecs and agent commits are blocked;
  - writes are judged on real paths (symlinks), more writers are covered, and protected paths match case-insensitively.
- **Every shell spawn is guarded.** opencode's `shell create.before` hook only spawns approved commands and scrubs the server password, model keys and forge tokens. Non-factory agents and opencode's REST shell are refused.
- **OS sandbox (macOS `sandbox-exec`).**
  - Covers agent shells and gates.
  - Writes are limited to the session's own directories; run state, factory files and `.git` stay read-only.
  - Credential files and git credential helpers are off-limits, and ssh (port 22) is blocked.
  - New config key `security.sandbox` (`"auto"` | `"off"`).
- **Gates and installs.** Both run without credentials and with pushes blocked. A task may not change the scripts or targets its gates run.

### Changed: language standards

- Every standard (TypeScript, React, Python, Go, Rust, Helm, Tauri) is rewritten from its primary docs, e.g. Effective Go and Go Code Review Comments, the TypeScript Handbook's Do's and Don'ts, react.dev's Rules of React, PEP 8/257 and the typing best practices, the Rust API Guidelines, Helm's chart best practices and the Pod Security Standards, and the v2.tauri.app security and IPC guides.
- Each standard lists its sources in an HTML comment, cites them per section, and marks factory-specific rules (such as Rust unit tests in a sibling `tests.rs`, which keeps them within the tester's edit scope). Comments are stripped from agent prompts.
- Corrections: Tauri app commands need no capability unless they are listed in `AppManifest::commands`; Tauri state uses `std::sync::Mutex` by default, with no `Arc`.

### Fixed

- The architect and tester agents get edit permissions for their own paths (change and context folders, test globs). Before, opencode's permission layer denied their writes.
- Closing a change removes its agent snapshot and empty worktree folders, and `status` no longer lists the snapshot as a worktree.
- Full-suite gate results are written to the change's log.

### Changed

- Implementer agents: a rule for merge-conflict tasks (change only the conflicted files, keep both intents).
- `AGENTS.md` block: query the workspace graph before reading files.

## 0.1.0

First release: `init`, `detect`, `gate`, `repoint`, `run`, `approve`, `resume`, `status`, `retry`, `abort`, `graph` and `bench`. Includes the OpenSpec workflow, the Graphify workspace graph, the opencode agents and plugin guard, the contract gate and the Ponytail add-on.
