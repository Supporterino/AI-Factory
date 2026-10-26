# CLI reference

`ai-factory [-C <dir>] <command> [options]`. Every command takes `-h/--help`, and `-V/--version` prints the version. The npm package is `@supporterino/ai-factory` (`npx @supporterino/ai-factory@<version> <command>`). The unscoped package `ai-factory` on npm is an unrelated project.

`init`, `update` and `detect --apply` refuse to rewrite a workspace that a newer version installed, because that would downgrade it. Run the matching version, or pass `--allow-downgrade` to go back on purpose.

## Exit codes

| Code | Name          | Meaning                                                                     |
| ---- | ------------- | --------------------------------------------------------------------------- |
| 0    | Ok            | Success                                                                     |
| 1    | Failure       | Unexpected internal failure or an unhandled tool error                      |
| 2    | Usage         | Unknown command or flag, or a missing argument                              |
| 3    | ConfigInvalid | `factory.config.jsonc` is missing, unparsable or fails validation           |
| 4    | Precondition  | A precondition is not met (not initialised, dirty tree, missing tool)       |
| 5    | GateFailed    | `gate`: a gate failed, is missing, timed out or was not check-only          |
| 6    | Paused        | `run`/`approve`/`resume`: the change paused (report written) or was aborted |
| 10   | Drift         | `detect --check` found differences                                          |

The source of truth is `src/cli/exit-codes.ts`; numbers are never reused.

## init

```
ai-factory init [--force] [--allow-downgrade] [--no-commit] [--no-graph] [--json]
```

Installs or refreshes the factory. It runs these steps in order:
1. Checks git, opencode, openspec and graphify against the pinned ranges. A missing or unsupported tool exits with 4 and prints its install command.
2. Detects the workspace and writes `factory.config.jsonc` if there is none.
3. Renders the managed files:
   - agents, standards and schemas;
   - the `AGENTS.md` and `.gitignore` blocks and `.graphifyignore`;
   - the OpenSpec `config.yaml`;
   - OpenSpec's opencode commands and skills, which `openspec init --tools opencode` generates in a scratch directory. Your edits to them are kept like edits to any managed file.
4. Writes `factory.lock.json`.
5. Installs `pre-push` hooks in the AI repo and every checked-out submodule.
6. Commits the result.

Running it again on an unchanged workspace changes nothing.

How it treats files that already exist:
- A file you edited is kept; `ai-factory update` merges it.
- A file you deleted is not recreated.
- A file the factory never created stops `init` before anything is written. `--force` overwrites it, or you can list it under `unmanaged`.

Tool binaries can be overridden with `AI_FACTORY_<TOOL>_BIN`, e.g. `AI_FACTORY_OPENSPEC_BIN`.

## update

```
ai-factory update [--dry-run] [--tools] [--restore] [--force] [--allow-downgrade] [--json]
```

Upgrades an installed workspace to the factory version you run, as one local commit `chore(factory): update to vX.Y.Z`. It prints the plan first, and `--dry-run` stops there.
- Migrates `factory.config.jsonc` through each pending `schemaVersion` step, keeping comments.
- Re-renders managed files:
  - files you did not edit are replaced;
  - files you edited are merged three-way with the previous template as the base;
  - files you deleted stay deleted (`--restore` recreates them);
  - paths in `unmanaged` are skipped.
- Reinstalls the git hooks and warns when detection differs from the config.
- `--tools` regenerates OpenSpec's opencode commands and skills, merges them like other managed files, and rebuilds the graph when Graphify's format changed.

It needs a clean AI repo. It refuses while a change is active, queued or paused with tasks; `--force` updates anyway, and those changes keep the agent and gate definitions they were approved with. Every file it may touch is backed up to `.factory/backups/<timestamp>/` first. A merge conflict leaves markers, commits nothing and exits 4: resolve and commit, or run `rollback`. Submodules (apart from hooks), `openspec/specs` and `openspec/changes` are never touched. See [CHANGELOG.md](../CHANGELOG.md) for what each version changes, and [fleet-update.sh](fleet-update.sh) for updating many workspaces.

## rollback

```
ai-factory rollback
```

Restores the files of the latest update from its backup, including the previous lock and config, and commits `chore(factory): roll back update to vX.Y.Z`. It also undoes an update that stopped on conflicts.

## doctor

```
ai-factory doctor [--json]
```

A read-only health check. It looks at:
- **Tools:** the installed git, opencode, OpenSpec and Graphify against the lock's ranges and against what this factory version supports. The factory version that wrote the lock is checked too.
- **Install:** the config, the managed files (out of date, edited by you, deleted by you) and the Ponytail content hash.
- **Repos:**
  - submodule state; for uninitialised ones it offers `git submodule update --init` when run in a terminal;
  - clean working trees;
  - the `pre-push` hook in the AI repo and every submodule.
- **Gates:** the resolved command for every repo and gate type, printed as a table. It flags a missing gate and an executable that is not on `PATH` or in the repo's tool directories (`node_modules/.bin`, `.venv/bin`). For script gates (`npm run lint`), only the runner is checked.
- **Caches:** the sizes of the dependency caches, worktrees, logs and backups under `.factory/`.
- **Models:** every configured model must be listed by `opencode models` when it runs with the same curated environment as the pipeline's server. A model whose provider credentials are not exported fails here.
- **Graph:** missing, wrong format, or built at another commit than `HEAD`.
- **Changes:** an active-change lock that nothing is driving.

It exits 4 when any check fails. Warnings exit 0.

## detect

```
ai-factory detect [--apply [--no-commit] [--allow-downgrade]] [--check] [--json]
```

Re-detects the layout, repos, languages and contracts and prints the differences from the config:
- `+` marks an addition, `-` a removal, `~` a change.
- Without a config, it prints what `init` would propose.
- `--apply` writes the changes with comment-preserving edits. It then regenerates implementer agents, scopes, the OpenSpec context and hooks, and commits (`--no-commit` to skip).
- `--check` exits with 10 when there is drift.
- `--json` prints `{ root, hasConfig, detection, changes, applied }`.

## gate

```
ai-factory gate <change-id> [--task <id>] [--repo <name>] [--full] [--json]
```

Runs format, lint, types and tests.
- `--task` gates a task worktree (`.factory/worktrees/<change>/<repo>/<task>`) against `change/<id>`, with file-scoped format/lint and affected tests only.
- Without `--task` it gates every repo that has `change/<id>` checked out, against its default branch. `--full` runs whole-repo gates and the full suite.
- Gates resolve as `gates.overrides` → the repo's own script (`gates.scripts` names in package.json, Makefile, justfile or Taskfile) → profile defaults. A gate with no command fails; set the override to `"skip"` to opt out explicitly.
- A gate that modifies files fails as "not check-only", and the worktree is restored.
- `--json` prints `{ change, passed, reports: [{ repo, mode, base, passed, changed, results: [{ type, status, cwd, command, source, exitCode, durationMs, output }] }] }`. `output` is compacted (no ANSI codes, failures with context, capped at `tokens.gateOutputMaxLines`).

## repoint

```
ai-factory repoint <change-id> [--json]
```

Run this after the submodule MRs of a change have merged upstream.
1. Finds the provisional bump commit (`chore(submodules): bump for <id> [provisional]`).
2. Fetches each submodule and finds the merged commit: fast-forward, merge commit, `Change-Id` trailer, or the squash commit with the same patch-id.
3. Commits the real pointers in the AI repo as `chore(submodules): repoint <id>`.

Pointers whose MR has not merged stay provisional, and the command exits with 4. Run it again later. Nothing is ever pushed.

## status

```
ai-factory status [<change-id>] [--json]
```

Shows the active change and its driver, the queue, and each change's details, including token usage (by agent and task, retry overhead, wasted re-reads) and how far the graph lags behind the merges:
- the phase
- the branches
- the task DAG with states, attempts and the last gate output
- the worktrees

## retry

```
ai-factory retry <change-id> --task <id>
```

After a human fix: resets a failed task's retry budget and un-cancels the tasks that were cancelled because of it. Continue with `resume`.

## abort

```
ai-factory abort <change-id>
```

Stops the change safely: the driver finishes in-flight merges and interrupts agents. Branches and worktrees are kept, the active-change lock is released, and the change is removed from the queue. The next queued change is not started automatically.

## run

```
ai-factory run "<request>"
```

Starts a change and runs it up to spec approval:
1. Intake by the orchestrator: change id, summary and likely repos.
2. `change/<id>` in the AI repo, created before design.
3. Explorers per likely repo, in parallel.
4. The architect writes `openspec/changes/<id>/`.
5. The CLI validates the change, and the architect repairs it if needed.

When another change occupies the AI-repo checkout, the new change is drafted in `.factory/drafts/<id>`. Exit 0 means it awaits approval; exit 6 means the spec does not validate yet.

## approve

```
ai-factory approve <change-id> [--no-continue]
```

Validates the change and commits the spec (`docs(spec): <id>`). Records the approval in `.factory/approvals/<id>.json`: the approver (git `user.email`), the spec commit and a content hash with task checkboxes normalised out. Then it continues automatically: activation, implementation, review and tests, contracts, full suite, close. If another change is active, this one is queued and starts when that one closes.

## resume

```
ai-factory resume <change-id>
```

Continues a paused, aborted, interrupted or queued change from its last consistent state. The spec is re-checked against its approval first, and any edit other than a task checkbox voids the approval.

## graph

```
ai-factory graph [--full] [--json]
```

Builds or incrementally updates the one workspace graph (`graphify-out/`, gitignored) over the AI repo and every submodule. `--full` rebuilds from scratch. The pipeline updates it after every task merge (serialised and coalesced), so running it by hand is rarely needed. Graphify always runs with `GRAPHIFY_NO_AUTO_REFRESH=1 GRAPHIFY_BACKEND=none`.

## bench

```
ai-factory bench ponytail [--runs N] [--yes] [--json]
```

Runs the bench fixture change N times (default 3) with and without the Ponytail add-on on your configured models. Compares tokens, lines changed, first-attempt gate pass rate, retries, scenario test coverage and review findings as medians with min–max. Results go to `docs/bench/ponytail-<date>.md` and `.json`.

It makes real model calls, so it prints an estimate first and asks for confirmation; `--yes` skips the question.
