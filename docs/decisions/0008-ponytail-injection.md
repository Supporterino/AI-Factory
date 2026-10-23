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
