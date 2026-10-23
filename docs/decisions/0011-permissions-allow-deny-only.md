# ADR-0011: Permission rules are allow/deny only

**Context.** In headless mode, `ask` is auto-rejected by `opencode run`, and on the server it waits for a reply. The last matching rule wins, and `*` matches `/`.

**Decision.**
- Every generated rule set starts with `{*,*,deny}`, then adds explicit allows, then explicit denies for the always-excluded paths. The final denies win.
- `external_directory` is always denied.
- The CLI auto-rejects any permission request event it sees, and logs it as a scope violation.

**Consequences.** Behaviour is deterministic and testable as a pure function (rules × call → effect), which we unit-test against our own matcher that mirrors opencode's.
