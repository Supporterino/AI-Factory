# ADR-0015: Gate resolution, scope and the check-only guard

**Context.** §9 fixes the resolution order (override → repo script → profile) and requires check-only gates and affected tests per task. Two problems are left open:
- Pre-existing format or lint debt in a repo would fail every task, because the task did not cause it.
- A repo with no linter configured has no command at all for that gate.

**Decision.**
- **Profiles hold ordered gate candidates** with requirements: config files (`biome.json`, eslint configs), dependencies (`vitest`, `jest`) or file content (`[tool.pyright]`). The first candidate that holds wins.
- **Targets.** Gates run per target: the top-most `package.json`, `pyproject.toml` or `Cargo.toml` dir; every `go.mod` dir; one chart set per repo. TypeScript and React share a target.
- **Per-task scope.** Task gates run only in targets the task touched. Format and lint use **file-scoped** forms (`biome lint {files}`, `gofmt -l {files}`, `golangci-lint --new-from-rev={base}`), so existing debt never fails a task. The full suite before close runs whole-repo forms, and failures there become fix tasks.
- **Affected tests.**
  - `vitest related` / `jest --findRelatedTests` / `go test {packages}` / `cargo test -p {crates}` / `helm unittest {charts}`.
  - Bun and pytest get `{testFiles}`: the changed tests plus tests named after the changed sources.
  - Nothing affected means the gate is **skipped and recorded**.
  - Repo scripts used for `testAffected` receive the changed files as arguments.
- **Missing is a failure.** A gate with no resolvable command fails with the fix in the message. The only opt-out is the explicit override value `"skip"`, which is recorded as skipped.
- **Ordering.** Format, lint and types always run, so agents see every static failure at once. Tests run only when those pass.
- **Check-only guard.**
  - Before each gate, the dirty files of the worktree are snapshotted with their content.
  - Any difference afterwards (modified, created or deleted files, or a moved HEAD) fails the gate as "gate is not check-only".
  - The worktree is then restored exactly, so a formatter in write mode never changes code silently.
- **Gate environment.** Each command runs with `sh -c` in its target dir, with `node_modules/.bin` or `.venv/bin` prepended to PATH, `CI=1` and no colour, and shared caches under `.factory/cache/`: npm, pnpm, bun, yarn, uv, `GOMODCACHE`, `GOCACHE`, golangci-lint, and `CARGO_TARGET_DIR` per repo.
- **Installs** run per marker dir from the first lockfile present. If there is no lockfile, the step is skipped and the reason recorded.
