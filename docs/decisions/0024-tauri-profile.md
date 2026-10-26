# ADR-0024: Tauri v2 profile

**Context.** A Tauri v2 app is a JS/TS frontend plus a Rust crate in `src-tauri/` whose build compiles in `tauri.conf.json` and the capability files (docs/research/notes/tauri.md). The Rust profile alone would run the cargo gates there. It would not, however, treat capability and config changes as changes, and it would fail in fresh worktrees where the frontend dist has never been built.

**Decision.**
- **The language.** `tauri` is a stackable language that means Tauri v2.
- **Detection.** It is detected next to `tauri.conf.json`, `tauri.conf.json5` or `Tauri.toml` when the `tauri` dependency in the Cargo.toml beside it has major version 2. When that version is inherited, a config without the v1 keys `distDir`/`devPath` counts as v2. v1 apps stay plain `rust` plus `typescript`.
- **The target.** The profile targets the config's directory and **supersedes** `rust` there (a new `Profile.supersedes`), so cargo runs once. Other Rust crates in the repo keep their `rust` targets.
- **Gates.**
  - The gates are the cargo gates: `cargo fmt --all --check`, `clippy`, `cargo check --all-targets`, `cargo test --workspace`, and `cargo test {crates}` for affected tests.
  - Its extensions include `.json`, `.json5` and `.toml`, so a capability-only change re-runs format, lint and types (where the build validates it). That change selects no crate tests.
- **`frontendDist`.**
  - Before every compiling gate, a `node -e` step creates `build.frontendDist` as an empty directory if it is a missing local path. It reads `tauri.conf.json` only.
  - Git does not track empty directories, so the gates stay check-only. This also covers the full suite in the repo checkout, where installs don't run.
- **Tests.** The tester's globs are Rust's. Frontend tests (with `@tauri-apps/api/mocks`) belong to the TypeScript profile.
- **The standard.** `templates/standards/tauri.md` covers structure, commands and state, capabilities and security, testing, and how the gates behave.

**Consequences.**
- **Cargo workspaces.** If `src-tauri` is a member of a Cargo workspace whose root also has a `rust` target, the root's cargo gates compile the app without the dist step. Such repos need `gates.overrides` or a built dist.
- **JSON5 and TOML configs** don't get the dist step.
- **Linux** needs Tauri's system packages (WebKitGTK) for the cargo gates; `doctor` only checks for `cargo` and `node`.
- **Existing workspaces** get `.opencode/standards/tauri.md` on their next `update`. `detect --apply` then adds `tauri` to the repos that have it.
