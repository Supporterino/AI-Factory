# CLI reference

`ai-factory [-C <dir>] <command> [options]`. Every command takes `-h/--help`.

## Exit codes

| Code | Name          | Meaning                                                               |
| ---- | ------------- | --------------------------------------------------------------------- |
| 0    | Ok            | Success                                                               |
| 1    | Failure       | Unexpected internal failure or an unhandled tool error                |
| 2    | Usage         | Unknown command or flag, or a missing argument                        |
| 3    | ConfigInvalid | `factory.config.jsonc` is missing, unparsable or fails validation     |
| 4    | Precondition  | A precondition is not met (not initialised, dirty tree, missing tool) |
| 5    | GateFailed    | `gate`: a gate failed, is missing, timed out or was not check-only    |
| 10   | Drift         | `detect --check` found differences                                    |

The source of truth is `src/cli/exit-codes.ts`; numbers are never reused.

## init

```
ai-factory init [--force] [--no-commit] [--json]
```

Installs or refreshes the factory. It runs these steps in order:
1. Checks git, opencode, openspec and graphify against the pinned ranges. A missing or unsupported tool exits with 4 and prints its install command.
2. Detects the workspace and writes `factory.config.jsonc` if there is none.
3. Runs `openspec init --tools opencode` with a private config dir.
4. Renders the managed files: agents, standards, schemas, `AGENTS.md` and `.gitignore` blocks, `.graphifyignore` and the OpenSpec `config.yaml`.
5. Writes `factory.lock.json`.
6. Installs `pre-push` hooks in the AI repo and every checked-out submodule.
7. Commits the result.

Running it again on an unchanged workspace changes nothing.

How it treats files that already exist:
- A file you edited is kept; `ai-factory update` merges it.
- A file you deleted is not recreated.
- A file the factory never created stops `init` before anything is written. `--force` overwrites it, or you can list it under `unmanaged`.

Tool binaries can be overridden with `AI_FACTORY_<TOOL>_BIN`, e.g. `AI_FACTORY_OPENSPEC_BIN`.

## detect

```
ai-factory detect [--apply] [--check] [--json]
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

Shows the active change and its driver, the queue, and each change's details:
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
