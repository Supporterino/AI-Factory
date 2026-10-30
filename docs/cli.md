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
ai-factory init [--plan] [--force] [--allow-downgrade] [--no-commit] [--no-graph] [--json]
```

Installs or refreshes the factory. `--plan` prints what would be created, replaced or archived and writes nothing. It runs these steps in order:
1. Checks git, opencode, openspec and graphify against the pinned ranges. A missing or unsupported tool exits with 4 and prints its install command.
2. Detects the workspace, existing `opencode.json` instructions and generated contracts, and writes `factory.config.jsonc` if there is none.
3. On the first install, archives replaced custom agents, commands and skills under `.factory/legacy/<timestamp>/`; OpenSpec's `opsx-*`/`openspec-*` files stay.
4. Renders the managed files:
   - agents, standards and schemas;
   - the `AGENTS.md` and `.gitignore` blocks and `.graphifyignore`;
   - the OpenSpec `config.yaml`;
   - OpenSpec's opencode commands and skills, which `openspec init --tools opencode` generates in a scratch directory. Your edits to them are kept like edits to any managed file.
5. Writes `factory.lock.json`.
6. Installs `pre-push` hooks in the AI repo and every checked-out submodule.
7. Commits the result.

Running it again on an unchanged workspace changes nothing.

How it treats files that already exist:
- A file you edited is kept; `ai-factory update` merges it.
- A file you deleted is not recreated.
- A file the factory never created stops `init` before anything is written. `--force` overwrites it, or you can list it under `unmanaged`. Custom agents, commands and skills in the paths the factory takes over are archived under `.factory/legacy/<timestamp>/` on the first install instead of colliding.
- An existing `openspec/config.yaml` (a team already using OpenSpec) is kept: the first config lists it under `unmanaged`. Add the factory's workspace context to it by hand if the architect should see it.

Tool binaries can be overridden with `AI_FACTORY_<TOOL>_BIN`, e.g. `AI_FACTORY_OPENSPEC_BIN`.

### Moving to another machine

Everything needed to run the factory is in git; the runtime state is not.
1. Clone the workspace (with submodules: `git clone --recurse-submodules`, or `git submodule update --init --recursive` afterwards) and install the tools `git`, `opencode`, `openspec` and `graphify` plus the repos' own toolchains.
2. Run `ai-factory init`. On an unchanged workspace it writes nothing and makes no commit, but it re-installs the `pre-push` hooks (they live in `.git/hooks`, which a clone does not carry) and rebuilds `graphify-out/` (gitignored).
3. Run `ai-factory doctor` to check the tools, lock version, hooks and gates.

What does not travel: worktrees, run state, session context, opencode's database, caches, logs, backups and legacy archives under `.factory/`. Finish an in-flight change (`land`) or `abort` it before switching machines; there is no mid-change handoff. With `"artifacts": { "mode": "git" }`, each finished change's report, approval and usage ledger are committed under `factory-records/` and do arrive with the clone.

## adopt

```
ai-factory adopt [<change-id>... | --all] [--dry-run] [--json] [--normalize] [--preserve-progress]
```

Takes over OpenSpec changes that existed before the factory. `init` leaves `openspec/changes/` alone, so a team that was already using OpenSpec keeps its pending changes. Without ids or `--all`, `adopt` lists them.

Adoption is deliberately conservative:
- It reads the change, runs the same validation as `approve` (OpenSpec strict, `proposal.md`, `tasks.md` DAG) and writes `.factory/runs/<id>.json`.
- It writes no git state and starts no model. The run gets `origin: "openspec"`; `approve` creates the `change/<id>` branch lazily.
- A valid change becomes `awaiting-approval`. An invalid or incomplete one becomes `paused` with the issues, so `status` shows it and `resume` can repair it.
- A change whose tasks are all checked is not adopted; archive it with `openspec archive <id>`.
- A partially implemented change is refused unless `--preserve-progress` is passed. That flag trusts the checked tasks and, at approval, creates them as `merged`; commit that work on the base branch first.
- Custom OpenSpec schemas are refused: the factory supports the built-in `spec-driven` schema.

`--normalize` runs one architect session on a change that does not validate. The prompt tells it to preserve the existing intent, requirement text, task ids and checked state, and only add or repair the factory's indented `repo`, `deps` and `touches` metadata (and missing proposal sections). It requires a clean AI repo, the change files committed, the base branch and no active change, plus model credentials; it spends tokens.

`--dry-run` computes the same validation and reports the phase it would register, but writes no run state. `--json` prints the results; with `--normalize`, progress goes to stderr so stdout stays parseable.

Exit codes: 0 adopted/skipped, 4 refused (partial progress without the flag, custom schema, unknown id), 6 registered but paused.

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
  - paths in `unmanaged` are skipped;
  - a modified or deleted vendored Ponytail file stops the update; `--restore` puts the vendored copy back.
- Reinstalls the git hooks and warns when detection differs from the config.
- `--tools` regenerates OpenSpec's opencode commands and skills, merges them like other managed files, and rebuilds the graph when its format changed or it was built by another Graphify release than the installed one (a plain `update` only warns). The tool version ranges in the lock always follow the factory version: they are its requirements, not a choice.
- `--dry-run --json` lists the planned paths and actions, not the rendered contents.

It needs a clean AI repo. It refuses while a change is active, queued or paused with tasks; `--force` updates anyway, and those changes keep the agent and gate definitions they were approved with. It never commits onto a `change/<id>` branch, even with `--force`: switch the AI repo to your base branch first (`git switch main`); `resume` switches back, and the change keeps its definitions. Every file it may touch is backed up to `.factory/backups/<timestamp>/` first. A merge conflict leaves markers, commits nothing and exits 4: resolve and commit, or run `rollback`. Submodules (apart from hooks), `openspec/specs` and `openspec/changes` are never touched. See [CHANGELOG.md](../CHANGELOG.md) for what each version changes, and [fleet-update.sh](fleet-update.sh) for updating many workspaces.

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
- **Credentials:** the stored credentials of the configured providers (from `opencode auth login`) are reported without their values. They are imported into the throwaway database used by the model check, exactly as the runtime imports them into its private server.
- **Models:** every configured model must be listed by `opencode models` when it runs with the same curated environment as the pipeline's server. A model whose provider credentials are neither stored nor exported fails here.
- **Gates** also warn when a TypeScript repo's `tsconfig.json` does not turn on `strict` (the types gate checks what the project's config enforces).
- **Graph:** missing, wrong format, built by another Graphify release than the installed one, or built at another commit than `HEAD`.
- **Changes:** an active-change lock that nothing is driving; a corrupt run file, `active.lock` or `queue.json`.
- **Environment:** proxy variables (seen applied to local provider traffic), and that Graphify runs without auto-refresh or an LLM backend.

It exits 4 when any check fails. Warnings exit 0.

## completion

```
ai-factory completion [<bash|zsh|fish>] [--install] [--rc <file>]
```

Prints a completion script, or with `--install` adds a marked, idempotent block to the shell's rc file. Completion covers:
- every visible command;
- every optional flag of the selected command, skipping non-repeatable flags already used;
- values: change ids and task ids from the workspace state, repo and agent names from the config, configured model ids, bench cases and levels, shells, and file/directory paths;
- comma-list values (`--levels lite,f`, `--by change,agent`).

```bash
ai-factory completion zsh            # print it
ai-factory completion zsh --install  # add to ~/.zshrc
ai-factory completion --install      # detect from $SHELL
```

The rc file is `~/.bashrc`, `${ZDOTDIR:-$HOME}/.zshrc` or `${XDG_CONFIG_HOME:-$HOME/.config}/fish/config.fish`. `--rc` overrides it and requires `--install`. A malformed existing block stops the install instead of overwriting it; running it again is a no-op. The zsh script uses `compdef`, so load it after `compinit` (the normal zsh setup).

Completing values never writes, never calls a model and exits 0 even if the workspace is not initialised: a missing or corrupt file simply produces no candidates.

## detect

```
ai-factory detect [--apply [--no-commit] [--allow-downgrade]] [--check] [--json]
```

Re-detects the layout, repos, languages and contracts and prints the differences from the config:
- `+` marks an addition, `-` a removal, `~` a change.
- Without a config, it prints what `init` would propose.
- `--apply` writes the changes with comment-preserving edits. It then regenerates implementer agents, scopes, the OpenSpec context and hooks, and commits (`--no-commit` to skip). Agents you edited are merged three-way like on `update`, so a new language's standard reaches them; a merge conflict leaves markers, commits nothing and exits 4. A failure before the sync leaves the config unchanged.
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
- A change with a definitions snapshot (taken at `approve`) is gated with it, like the pipeline does, not with today's config.
- Gate output is redacted (tokens, credentials, env secrets) before it is printed, stored or sent to an agent.
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

## land

```
ai-factory land <change-id> [--dry-run] [--json]
```

Merges a finished (`done`) change back into its base branches and removes what it no longer needs. It never pushes.
1. Each touched submodule's `change/<id>` is merged into its tracked branch (`.gitmodules`), `defaultBranch`, or `main`.
2. If a submodule produced a merge commit, the AI repo's `change/<id>` gets a `chore(submodules): point to landed <id>` commit before it is merged.
3. The AI repo's `change/<id>` is merged into its default branch (or `main`).
4. The change branch and leftover `change/<id>--<task>` branches are deleted in every touched repo. Worktrees, drafts, context packs, paused reports, approvals and run state are removed.

Kept as the record: `.factory/reports/<id>.md`, `.factory/usage/<id>.json` and `.factory/logs/<id>/`. With `"artifacts": { "mode": "git" }`, the report, approval and usage ledger are also committed under `factory-records/` before cleanup; `--dry-run` lists that as `would record`. With the default `"local"`, a successful land ends with a hint pointing at `artifacts sync <id>` so the records are not silently left behind.

This is the local-only path. If the submodule MRs already merged upstream, use `repoint` instead; `land` merges the local change branches into the local base branches.

The command requires a `done` change, clean repo checkouts and clean change worktrees. A merge conflict aborts that repo's merge and leaves all change branches in place. A branch that cannot be deleted (for example because it is checked out) is reported and the run/approval are kept so `land` can be retried; it then exits with 4. In the submodule layout a conflict after earlier submodules merged leaves those submodules landed on their local base branches.

`--dry-run` prints the planned merges and cleanup paths without changing anything. `--json` prints the same outcome as JSON.

## status

```
ai-factory status [<change-id>] [--json] [--watch [--interval <seconds>]]
```

Shows the active change and its driver, the queue, and each change's details, including token usage (by agent and task, retry overhead, wasted re-reads) and how far the graph lags behind the merges:
- the phase
- the branches
- the task DAG with states, attempts and the last gate output
- the full-suite result per repo, the contract gate results and the provisional pointer commit
- the worktrees
- corrupt run files, `active.lock` or `queue.json`, with how to recover (other changes still show)

`--watch` reprints the same view every `--interval` seconds (default 2) until Ctrl-C. It clears the screen on a terminal and prints a separator between frames when piped, so a second terminal can watch a long run. `--watch` and `--json` exclude each other.

Without an id, `status` also prints one workspace-wide usage line and `--json` includes `workspaceUsage` (the same totals as `ai-factory usage`).

## usage

```
ai-factory usage [--since <date>] [--until <date>]
                 [--change <id>]... [--agent <id>]... [--model <id>]...
                 [--by <list>] [--json]
```

Reports every token and cost the factory has spent in this workspace, across all changes, quick tasks and archived runs. The source is every ledger: the live `.factory/usage/<id>.json` and, when artifacts are tracked, the committed `factory-records/usage/<id>.json` (the live ledger wins for an id). Nothing is enforced.
- `--since` / `--until` are inclusive UTC days (`YYYY-MM-DD`).
- `--change`, `--agent` and `--model` accept a repeatable flag or a comma list.
- `--by` selects the tables: `change`, `agent`, `model` and `day`. The default is `change,agent,model`; `--json` always includes every dimension.
- The human report shows the total (tokens, cache reads, output, cost), sessions, changes, the period, retry overhead and wasted re-reads.
- A corrupt ledger is listed on stderr and skipped; the rest still aggregates. Missing usage is not an error: `usage` prints `no usage recorded yet`.
- `usage` reads state only. It works without a valid config and never blocks a run.

The JSON shape is versioned (`version: 1`) with `totalTokens`, `sessions`, `changes`, `byChange`, `sessionsByChange`, `byAgent`, `byModel`, `byDay`, `retryOverhead`, `wastedReads`, `filters` and `corrupt`.

## artifacts

```
ai-factory artifacts sync <change-id>
ai-factory artifacts sync --all [--dry-run] [--json]
```

Copies a finished change's records out of the gitignored `.factory/` into the committed `factory-records/` tree, so they survive a fresh clone and another machine:
- `factory-records/reports/<id>.md` — the final close report;
- `factory-records/approvals/<id>.json` — approver, spec commit and pass count;
- `factory-records/usage/<id>.json` — the token/cost ledger, with `wastedReads` stored in it because the logs it comes from stay local.

It requires `"artifacts": { "mode": "git" }` in `factory.config.jsonc`; the default `"local"` keeps everything in `.factory/` and `sync` exits 4. `--all` backfills every id that still has local records in one commit. `--dry-run` writes and commits nothing.
- `close`, `land` and `quick` call it automatically; `land` records before its cleanup deletes the local approval.
- Content is compared first, so re-running writes nothing and makes no commit. Each changed record is committed as `docs(factory): record <id>` with a `Change-Id` trailer, in its own commit, so unrelated staged work is untouched.
- Logs, paused reports (they embed gate output), context packs, drafts, snapshots and run state are never copied.
- `doctor` reports the record count and warns when the mode is `git` but the directory is gitignored or missing.

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

## refine

```
ai-factory refine "<request>"
```

Asks a few scope, out-of-scope, verification and constraint questions, then writes a
refined request to `.factory/requests/<slug>.md`. Nothing is designed or implemented.
Feed it to `run --request`.

## quick

```
ai-factory quick "<task>" [--repo <name>] [--agent <id>] [--no-review] [--verbose|--quiet]
```

The no-OpenSpec path. Creates a `task/<slug>` branch (prefix from
`workflow.quick.branchPrefix`), implements, runs the repository gates, runs one review pass
and makes one local commit. It still applies the factory's edit scope, secret rules and
gates; only the spec and approval hash are skipped. The branch stays checked out.

## run

```
ai-factory run "<request>" [--request <file>] [--no-interactive] [--verbose|--quiet]
```

Starts a change and runs it up to spec approval. `--request` reads the request from a file
(for example one written by `refine`).
1. Intake by the orchestrator: change id, summary and likely repos.
2. `change/<id>` in the AI repo, created before design.
3. Explorers per likely repo, in parallel.
4. The architect writes `openspec/changes/<id>/`.
5. The CLI validates the change, and the architect repairs it if needed.

When the intake orchestrator or architect lists `openQuestions` in its handoff and stdin is a
terminal, the CLI asks them, sends the answers back to the same session, and lets the agent
update the request or spec. The Q&A is written to
`openspec/changes/<id>/questions.md` and `.factory/clarifications/<id>.md`.
`workflow.refine` gates asking; `workflow.clarifyRounds` (default 2) caps the rounds per
phase, and questions beyond the cap are recorded unanswered. `--no-interactive`, or no TTY,
records the questions without asking and continues. `run --interactive` was removed: use `refine` + `--request` for a pre-run interview.

When another change occupies the AI-repo checkout, the new change is drafted in `.factory/drafts/<id>`. Exit 0 means it awaits approval; exit 6 means the spec does not validate yet.

Every agent call prints when it starts (step, agent, model) and ends (outcome, duration, tokens); gates and dependency installs print when they run, and a 30-second heartbeat lists what is still running. `--verbose` adds one line per tool call and every gate start; `--quiet` keeps only phase banners, merges, failures and the summary. The same flags work on `approve`, `resume` and `quick`.

## approve

```
ai-factory approve <change-id> [--no-continue] [--verbose|--quiet]
```

Validates the change and commits the spec (`docs(spec): <id>`). Records the approval in `.factory/approvals/<id>.json`: the approver (git `user.email`), the spec commit and a content hash with task checkboxes normalised out. Then it continues automatically: activation, implementation, review and tests, contracts, full suite, close. If another change is active, this one is queued and starts when that one closes. When the pipeline finishes the change, the output ends with `next: ai-factory land <id>`.

## resume

```
ai-factory resume <change-id> [--verbose|--quiet]
```

Continues a paused, aborted, interrupted or queued change from its last consistent state. The spec is re-checked against its approval first, and any edit other than a task checkbox voids the approval. A run that reaches `done` ends with `next: ai-factory land <id>`. A change that is already done prints the same hint: `land` deletes the run state, so a `done` state means it has not been landed yet.

## graph

```
ai-factory graph [--full] [--json]
```

Builds or incrementally updates the one workspace graph (`graphify-out/`, gitignored) over the AI repo and every submodule. `--full` rebuilds from scratch. The pipeline updates it after every task merge (serialised and coalesced), so running it by hand is rarely needed. Graphify always runs with `GRAPHIFY_NO_AUTO_REFRESH=1 GRAPHIFY_BACKEND=none`.

## bench

```
ai-factory bench ponytail [--runs N] [--case ID[,ID]] [--levels lite,full,ultra] [--yes] [--json]
```

Runs each bench case (`slugify`, a new function; `paginate-fix`, a fix in existing code) N times (default 3) with and without the Ponytail add-on on your configured models. `--levels` compares several Ponytail levels against "without"; `--case` picks cases. Compares tokens, lines changed, first-attempt gate pass rate, retries, scenario test coverage and review findings as medians with min–max. Tokens count every run; the other metrics only runs that finished, and the table shows how many did. Results go to `docs/bench/ponytail-<date>.md` and `.json`, saved after every run (`"complete": false` until the end).

It makes real model calls, so it prints an estimate first and asks for confirmation; `--yes` skips the question.
