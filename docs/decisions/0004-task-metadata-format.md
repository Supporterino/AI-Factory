# ADR-0004: Task metadata in `tasks.md`

**Context.** The scheduler needs `repo`, `deps` and `touches` per task. OpenSpec accepts indented non-checkbox lines under a task, even with `--strict`, and does not count them as tasks (verified on 1.10.0 and 1.14.3). Any line with `[ ]` counts as a task.

**Decision.**
```markdown
## 1. Backend

- [ ] 1.1 Add health handler
  - repo: backend
  - deps: none
  - touches: internal/http/**, cmd/server/main.go
```

- The factory parses this itself with a small, strict parser and zod.
- Task ids are OpenSpec's `N.M` numbers.
- `deps` is a comma list of task ids or `none`.
- `touches` is a comma list of globs relative to the repo root.
- We stay on OpenSpec's built-in `spec-driven` schema; custom schemas are experimental.

**Consequences.** Cycles, unknown repos and missing `touches` are rejected before approval. The CLI rewrites only checkbox characters, which are normalised out of the approval hash.
