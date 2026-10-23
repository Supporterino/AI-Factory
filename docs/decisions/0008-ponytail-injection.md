# ADR-0008: Ponytail as static prompt text

**Context.** Ponytail's levels and its OpenCode integration rely on a runtime plugin that writes state under `~/.config`. The compact `AGENTS.md` equals the SKILL body minus the levels table. Its review skill is plain text. opencode v2 supports skills and commands, but the factory dispatches the reviewer itself and wants a stable, cacheable prompt.

**Decision.**
- Vendor the five pinned files (v5.3.2, hash-verified) into `.opencode/addons/ponytail/` with `LICENSE`.
- Render into `implementer-*` and `reviewer` bodies, in this order:
  1. `AGENTS.md`, minus its last joke line
  2. the level row from the SKILL.md table (`lite|full|ultra`)
  3. `PRECEDENCE.md`
- The reviewer additionally gets the `ponytail-review` skill body, instead of invoking the command.
- `shortcut:` comments are harvested from diffs.
- The closing note maps to `risks[]`, and review findings map to `findings[]`. A handoff override in `PRECEDENCE.md` replaces the Markdown verdict format.
- The plugin, hooks, statusline and band are never installed.

**Consequences.** There is no runtime fetch and no writes to `$HOME`. The add-on text is part of the static cache prefix. `enabled:false` simply stops rendering it.

**Implemented (slice 11).**
- **Vendoring.** `bun run vendor:ponytail` clones `github.com/DietrichGebert/ponytail` at the pinned tag, checks that the tag resolves to the pinned commit, refuses non-text files, and verifies the content hash before writing `templates/addons/ponytail/`. Biome ignores that folder, so formatting can never change the hashed bytes.
  - The files ship inside the factory package. Nothing is fetched at runtime, and `init` works offline.
- **Verification.**
  - Every render re-checks the shipped copy against the pin (`verifyVendored`) and the configured `addons.ponytail.ref`. A mismatch is a precondition error.
  - A workspace copy that differs from its lock hash blocks `init`/`update`; it is not treated as a user edit to merge.
  - The lock records `addons.ponytail {ref, contentSha256, files}`.
- **Injection.**
  - `implementer-*` get, after their standards: `AGENTS.md` (without its closing aside about the Ponytail repo itself), then the configured level row from the SKILL.md table, then `PRECEDENCE.md`.
  - The `reviewer` additionally gets the review skill body and a mapping of Ponytail's Markdown verdict into handoff `findings`, `risks` and `decisions`.
  - No other role gets anything. `roles` can narrow this to one of the two.
- **Levels.** The rule body is the same at every level; only the row differs. `lite`'s "let the user pick" is overridden by precedence rule 5: there is no user in the loop, so smaller options go under `risks`.
- **`shortcut:` comments** (and the older `ponytail:`).
  - In `report` mode, the final report lists the ones the change added, per repo, file and line.
  - In `forbid` mode, a lint-stage check fails on any new one, committed or not.
- **Disabling.** `enabled: false` stops rendering the files and the prompt sections. The managed-file sync removes the unedited vendored copy, and the lock entry disappears.
- **`bench ponytail`.**
  - Builds a fresh single-repo fixture per run with the user's models, and runs it with and without the add-on.
  - Reports medians with min–max for tokens, lines changed (outside `openspec/`), first-attempt pass rate, retries, scenario coverage and review findings.
  - Writes `docs/bench/ponytail-<date>.{md,json}`. It prints a session and token estimate (cost depends on the provider) and needs `--yes` or an interactive yes.
  - **The default `enabled: true` stays provisional until the bench has run on real models.**
