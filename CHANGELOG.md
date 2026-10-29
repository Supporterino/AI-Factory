# Changelog

All notable changes per release. `ai-factory update` applies them to an installed workspace (see [docs/cli.md](docs/cli.md#update)).

## 0.8.0

### Minor Changes

- 7b6bdef: **Breaking:** `ai-factory run --interactive` was removed. Use `ai-factory refine "<request>"` and `ai-factory run --request <file>` for a pre-run interview.

  `run` now asks the questions the intake orchestrator and architect raise in their handoffs when stdin is a terminal, sends the answers back to the same session, and records the Q&A in `openspec/changes/<id>/questions.md` and `.factory/clarifications/<id>.md`. `workflow.clarifyRounds` (default 2) caps the rounds per phase; questions beyond the cap are recorded unanswered. `--no-interactive`, or no TTY, records the questions without asking and continues.

## 0.7.0

### Minor Changes

- 23422bb: Add opt-in committed change records. `"artifacts": { "mode": "git" }` snapshots a finished change's final report, approval and usage ledger into `factory-records/`, so a clone or another machine keeps them. `close`, `land` and `quick` record automatically; `ai-factory artifacts sync <id>|--all` backfills and retries. `usage` and `doctor` read both the local ledger and the committed snapshot. Config schema v4 adds the block with `"mode": "local"`, which keeps today's behaviour.
- 23d5d6b: Print `next: ai-factory land <id>` when `approve` or `resume` finishes a change; `land` hints at `artifacts sync <id>` when the records stay local.

## 0.6.0

### Minor Changes

- 824ef91: Add `ai-factory land <change-id>`: merge a finished change into its local base branches, update submodule pointers, delete change and task branches, and remove worktrees, drafts, context, approvals and run state while keeping reports, usage and logs.

## 0.5.0

### Minor Changes

- 94f34f1: Add bash, zsh and fish shell completion for commands, optional flags and workspace values, and add `ai-factory usage` for repo-wide AI token and cost reporting across changes and quick tasks.

## 0.4.2

### Patch Changes

- e336261: Fix the factory-side issues found in the Clarion run:
  - add a `websearch` config (default `{ "provider": "random" }`) and render it into opencode, so a headless run no longer waits a minute on the interactive web search provider prompt and then reports `Web search cancelled`
  - let implementers edit the repository's test files even when a task's `touches` omits them, and tell the architect to include test files in `touches`
  - add `runtime.turnTimeoutMinutes` (default 60, up from 30) and pass it to the opencode runtime
  - allow read-only Homebrew queries such as `brew --prefix` and recursive searches over OS-managed trees (`/Applications`, `/System`, `/Library`, `/usr`, `/opt`)

## 0.4.1

### Patch Changes

- eabad62: Detect Swift projects that are not SwiftPM packages. `Package.swift`, XcodeGen's `project.yml` and any `*.xcodeproj` bundle are now detected as Swift, and their gates fall back to `xcodegen generate` plus `xcodebuild build`/`test` (the scheme defaults to the project name). `testAffected` therefore resolves for Xcode projects instead of failing as a missing gate. Workspace scans also skip `.build`.

## 0.4.0

### Minor Changes

- 82c202a: Show what the factory is doing during implementation. Every agent call now prints its task, agent, model, attempt, duration and tokens; the scheduler prints retries, merge conflicts, requeues, infrastructure errors and interrupts; gates and dependency installs print when they start and finish; and a 30-second heartbeat lists running sessions and gates with elapsed time and the current tool. `--verbose` streams every tool call and gate start, while `--quiet` keeps only phase banners, merges, failures and the summary. `ai-factory status --watch [--interval <s>]` reprints the change in a second terminal.

## 0.3.2

### Patch Changes

- 864f387: Allow read-only web search/fetch for every built-in agent except the orchestrator, so explorers, architects, implementers and testers can research external APIs and documentation. Reviewers already had it; custom agents keep the `web` opt-in.
- ac5a965: Support opencode 2.2.0. The supported range is now `>=2.1.2 <2.3.0`; 2.2.0 is tested alongside 2.1.2, and `update` refreshes the lock's tested pin.

  opencode 2.2.0 now exposes MCP/plugin tools directly when `execute` is denied (which every factory agent does). Each tool's own permission still applies, so `mcp.roles` works as documented, but a global `allow` for an MCP action can expose a tool the role did not list.

## 0.3.1

### Patch Changes

- 4ba83db: Keep polling opencode's `/wait` in 60 s slices so an agent turn longer than 5 minutes no longer fails with "opencode server unreachable" (Node's `fetch` headers timeout), and report client-side timeouts as such instead.

## 0.3.0

### Minor Changes

- 7d6bb18: Add config schema v3: project instructions, skills and MCP permissions, custom agents with path routing, per-repo and per-agent models, conditional/generated gates, generated/CRD/IPC/custom contracts, Swift, `refine`/`run --interactive`, `quick`, gitmoji commits, legacy setup archiving and release/CI detection. Existing v2 configs keep working and `update` migrates them to v3.

### Patch Changes

- c0937d5: Ship `dist/package.json` with the CLI bundle so Node 20 parses `dist/cli.js` as ESM instead of failing with `Cannot use import statement outside a module`.

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

### Distribution

- The npm package is now `@supporterino/ai-factory`. The unscoped `ai-factory` on npm is an unrelated project. Run it with `npx @supporterino/ai-factory@0.2.0 init`; the command is still `ai-factory`.
- MIT LICENSE added.
- `prepack` builds the bundle, and the package ships only the bundle, docs and licences.
- GitHub Actions CI runs the full suite on Ubuntu and macOS; releases publish from `main` with provenance and create a GitHub Release.
- `init`, `update` and `detect --apply` refuse to downgrade a workspace a newer version installed (`--allow-downgrade` to override).

### Security

- **Second hardening batch (S11, S14–S17, S19).**
  - Secret files can no longer be read through globs, `git show <rev>:.env`, recursive `grep -r`/`rg --hidden`, inline code or the grep/glob tools; on macOS agent shells cannot read workspace secrets at all (gates still can). The two secret lists agree and cover `~/.kube/*.yaml`.
  - `npm run`/`pnpm`/`yarn`/`bun run` scripts and `make` recipes are checked like the commands they run; concatenated strings in other languages are joined before scanning.
  - Implementers and testers cannot edit `openspec/`. Patches the plugin cannot read are refused.
  - Redaction covers auth headers, bearer tokens, `-u user:pass` and URL tokens, runs before JSON escaping, applies to gate output, and `logs.redact: false` no longer turns off credential redaction.
  - Untrusted text is fenced so it cannot close its fence; edit and patch contents are not logged.

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

- **Retries.** Every retry gets the full gate output; repeated failures no longer arrive as an empty note (audit P1).
- **Abort.** `abort` stops a change in every phase, interrupts running agents, frees the workspace when the driver stops, and `resume` continues the change (P2).
- **Branching.** If branching fails after intake, the next run branches first; the spec is only ever committed on `change/<id>` (P3).
- **Merges.** A task whose conflict was resolved while another task merged now catches up instead of failing (P4).
- **Server crashes.** A crashed opencode server is restarted. Server failures never spend retry budget, and the change pauses after three in a row (P5).
- **OpenSpec files.** OpenSpec's opencode commands and skills are managed files: `init` and `update --tools` no longer overwrite your edits (P19).
- **Approval.** A spec edited after approval is caught on entry to every later phase, not only at activation; the error shows how to restore the approved spec (P9).
- **Reviews.** A reviewer or contract reviewer that returns no result pauses the change instead of counting as a clean review (P13).
- **Close.** Closing records each step, so a resume after a crash finishes the close instead of failing (P6).
- **Concurrent drivers.** Every phase after approval takes the driver lock, so two `resume`s cannot run a review or close twice; `approve` re-checks the phase under the run lock (P14).
- **Corrupt state files.** A corrupt run file, `active.lock` or `queue.json` gives a clear error with a fix; `status` and `doctor` list it instead of crashing (P15). A corrupt usage ledger is set aside and a new one started; unreadable graph metadata is ignored.
- **Budget.** Ctrl-C during a merge or a conflict resolution spends nothing and keeps the branch (P7). After a crash, tasks that already passed their gates go straight to the merge (P8). A provider that stays rate-limited, and a failed dependency install, pause the change instead of spending budget; installs are retried, also in kept worktrees (P12, P16).
- **Serial mode.** Work a failed task left in the shared checkout is stashed under its name, not reverted and charged to the next task (P10).
- **Queue.** A queued change resumed by hand leaves the queue, so it is not started a second time and the next change still auto-starts (P11).
- **Snapshots.** Agent and gate definitions are fixed at `approve`, not at activation (P18). `update` never commits onto a `change/*` branch, even with `--force`, so a running change keeps its agents in every session (P17, G7). `gate <id>` uses the change's snapshot (G9).
- **Smaller gaps (P20).** Context packs and the spec in review/test prompts are capped at a whole line; one failing explorer no longer sinks the design; graph updates take a workspace lock; a submodule branches from the newer of its local and fetched base branch.
- **`init`** keeps an existing `openspec/config.yaml` and lists it as unmanaged (G2). **`detect --apply`** merges edited implementer agents and never leaves a half-applied config (G3).
- **`update --restore`** repairs tampered or deleted vendored Ponytail files (G5). `--tools` also rebuilds a graph built by another Graphify release; a plain `update` warns about it (G6). `--dry-run --json` lists paths, not file contents (G9).
- **Helm** types gate fails when `helm template` fails (G8). Monorepo packages' languages bring their standards and test globs (G9). Design validation requires consumer tasks to depend on contract changes, and rejects invalid `touches` globs (G9).
- **Handoffs.** A reply without any JSON is reported as a missing block, not a parse error.

- The architect and tester agents get edit permissions for their own paths (change and context folders, test globs). Before, opencode's permission layer denied their writes.
- Closing a change removes its agent snapshot and empty worktree folders, and `status` no longer lists the snapshot as a worktree.
- Full-suite gate results are written to the change's log.

### Changed

- `bench ponytail` has two cases (a new function and a fix in existing code), `--case` and `--levels` options, medians of quality metrics over finished runs only, and saves results after every run (G1). It has still not been run on real models.
- `status` shows full-suite results, contract results and provisional pointers; reports list usage per task and step (G4).
- `doctor` warns about a non-strict `tsconfig.json`, a graph built by another Graphify release, and proxy variables, and checks Graphify's safety env.
- ADR-0028 records the default models, time limits and rate-limit parameters.

- Implementer agents: a rule for merge-conflict tasks (change only the conflicted files, keep both intents).
- `AGENTS.md` block: query the workspace graph before reading files.

## 0.1.0

First release: `init`, `detect`, `gate`, `repoint`, `run`, `approve`, `resume`, `status`, `retry`, `abort`, `graph` and `bench`. Includes the OpenSpec workflow, the Graphify workspace graph, the opencode agents and plugin guard, the contract gate and the Ponytail add-on.
