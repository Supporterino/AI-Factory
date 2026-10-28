# ADR-0032: Shell completion

**Context.** Every command is parsed with `node:util parseArgs`, but flags were declared inline in each `run` and help text was hand-written. Adding completion as a second flag list would drift from parsing: a new flag would work but not complete, or complete but fail. Completion also needs current workspace values (change ids, task ids, repos, agents, models), which change between tab presses and cannot be baked into a static script.

**Decision.**
- **One declaration per command.** `Command` carries `options`, `positionals`, `subcommands` and `hidden`. `options` is the same object passed to `parseCommandArgs`, extended with `description`, `complete` and `choices`; Node's parser ignores the extra keys. `parseCommandArgs` keeps the per-key types.
- **Hidden endpoint.** The generated scripts call `ai-factory __complete <shell> <words...>`. It prints `value<TAB>description` candidates, or a single `:files`/`:dirs` line to ask the shell for native path completion. It never writes, never calls a model, and returns 0 on any error so a broken workspace produces no candidates instead of shell noise.
- **Thin, generated scripts.** `completion <bash|zsh|fish>` prints a small script; it is not a template file and ships in the bundle. The scripts pass all words up to the cursor (including the current word) and handle descriptions and path fallbacks in the shell's own idiom.
- **Values from state.** Providers read the workspace lazily: change ids from active/queue, run files and `openspec/changes`, task ids from the change's run state, repos and models from `factory.config.jsonc`, agents from `.opencode/agents` plus custom agents, and bench values from `BENCH_CASES`. Each provider catches errors and returns nothing.
- **Optional flags and values.** Candidates cover commands, every flag, `--flag=value`, used boolean flags, comma lists (the last segment), `-C`, and file/directory fallbacks.
- **Install is explicit.** `--install` writes one marked block to the shell rc (`--rc` overrides it), replacing an older block and stopping on a malformed one. Printing is the default; no command edits rc files unless asked. Bash, zsh and fish are supported.

**Consequences.**
- Adding or changing a flag is one edit, and a test checks that every declared flag appears in that command's help.
- Completion correctness is tested without real shells: the engine is a pure async function over words and a workspace. Bash and zsh scripts are syntax-checked when those shells exist.
- Dynamic values are limited to local state and config. Model ids come from the config, not `opencode models`, so completion stays fast and offline.
- Value completion is advisory. If a provider cannot read a corrupt state file, the user gets fewer suggestions; nothing in the CLI depends on it.
