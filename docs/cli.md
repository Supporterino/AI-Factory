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
