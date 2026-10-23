# ADR-0011: Permission rules are allow/deny only

**Context.** In headless mode, `ask` is auto-rejected by `opencode run`, and on the server it waits for a reply. The last matching rule wins, and `*` matches `/`.

**Decision.**
- Every generated rule set starts with `{*,*,deny}`, then adds explicit allows, then explicit denies for the always-excluded paths. The final denies win.
- `external_directory` is always denied.
- Edit allowances are static path rules, relative to the session directory: implementers `*`, the architect `openspec/changes/*` plus `.factory/context/*` (re-allowed after the protected denies, with secrets denied again after it), and the tester the test globs of the workspace's languages. The plugin narrows them to the active change, the task worktree and the repo's own globs. (Until slice 13 the architect and tester had no edit rule at all; the scripted runtime hid this, and the first real-opencode E2E run exposed it.)
- The CLI auto-rejects any permission request event it sees, and logs it as a scope violation.

**Consequences.** Behaviour is deterministic and testable as a pure function (rules × call → effect), which we unit-test against our own matcher that mirrors opencode's (`ruleEffect` in `src/policy/permissions.ts`).
