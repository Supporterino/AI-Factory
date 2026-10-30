# ADR-0038: Adopting existing OpenSpec changes

**Context.** Teams adopting the factory often already use OpenSpec and have pending changes in `openspec/changes/`. `init` deliberately never touches that tree, and the factory only knows a change once `.factory/runs/<id>.json` exists. Without a bridge, `approve` on such a change fails with `no run state`, `status` does not list it and the only safe advice is to finish it outside the factory.

**Decision.**
- **A separate `adopt` command.** `init` stays install-only and idempotent. On a first install it prints a one-line note when pending changes exist; `doctor` warns only when there is no factory run yet, so established workspaces are not nagged.
- **Conservative registration by default.** `adopt` scans `openspec/changes/*`, skips `archive` and ids that already have run state, and validates with the existing `checkDesign`. It writes no git state, commits nothing and starts no runtime. Valid changes get `phase: "awaiting-approval"`; invalid or incomplete ones get `phase: "paused"` with the issues, which `status` and `resume` already handle.
- **Lazy branching.** An adopted change has no `change/<id>` branch yet. `approve` calls the existing `ensureDesignBranch` (including the draft-worktree path when another change is active), then validates and commits the spec like any other change. A clean AI repo and a committed change are preconditions, as they already are for design.
- **Metadata is not guessed.** Vanilla OpenSpec tasks lack the factory's indented `repo`, `deps` and `touches` lines. Inferring `touches` without reading the code would weaken the edit-scope guard, so `--normalize` is opt-in: one architect session with an adopt-specific prompt that preserves intent, requirement text, task ids and checked state. It only repairs metadata and missing proposal sections, and it starts from the base branch with no active change. `init` already requires opencode; deterministic adoption still makes no model calls, and only `--normalize` spends tokens.
- **Progress is explicit.** A change with checked tasks is refused unless `--preserve-progress` is passed. That flag trusts the checkboxes and, at approval, creates those tasks as `merged` instead of restarting them. The work must already be committed on the base branch; the factory cannot import uncommitted or branch-local code safely.
- **Complete changes stay outside.** Every task checked means the change is done by OpenSpec's definition: `adopt` skips it and suggests `openspec archive <id>`. The factory does not re-implement or silently archive it.
- **State carries provenance.** `RunState` gains `origin: "factory" | "openspec"`, `adoptedAt?`, and `preserveProgress`. `origin` also selects the adopt prompt if a paused adopted change is resumed.

**Consequences.**
- `adopt` does not require model credentials, and `init` still works in a workspace with hundreds of pending changes.
- The practical path for a vanilla change is `adopt --normalize` (or hand-editing the task metadata), because `touches` cannot be inferred safely.
- A partially implemented change is never silently redone. `--preserve-progress` is the explicit opt-in, and its correctness depends on the work being committed on the base branch.
- Custom OpenSpec schemas, registered stores and importing uncommitted code remain out of scope.
