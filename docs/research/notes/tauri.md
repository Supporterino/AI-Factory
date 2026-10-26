# Tauri v2 (researched 2026-10-26)

Checked against the docs and the npm registry. There is no Rust toolchain on this machine, so nothing was compiled here.

- **Versions:** `@tauri-apps/cli` 2.12.4 (latest; `next` is 3.0.0-alpha.5), `@tauri-apps/api` 2.12.4.
- **Layout** [v2.tauri.app/start/project-structure]: `src-tauri/` holds
  - `Cargo.toml` and `build.rs` (calls `tauri_build::build()`);
  - `tauri.conf.json`, which also marks the folder for the CLI;
  - `capabilities/` (`default.json`) and `icons/`;
  - `src/lib.rs` (`run()` and `#[cfg_attr(mobile, tauri::mobile_entry_point)]`) and `src/main.rs` (calls `<lib>::run()`).
- **Config files** [develop/configuration-files]:
  - JSON by default; JSON5 or TOML (`Tauri.toml`) need the `config-json5` / `config-toml` features on `tauri` and `tauri-build`.
  - Platform files (`tauri.linux.conf.json`, `Tauri.linux.toml`, …) are merged as a JSON Merge Patch; arrays are replaced.
  - v1 used `build.distDir`/`devPath`; v2 uses `build.frontendDist`/`devUrl`.
- **Capabilities** [security/capabilities]:
  - JSON or TOML files in `src-tauri/capabilities/`, or inline in the config.
  - All of them are active until `app.security.capabilities` lists some.
  - Fields: `identifier`, `description`, `windows`, `permissions`, `platforms`, `remote.urls`.
  - Permission ids look like `core:window:allow-set-title`, `fs:default`, or local ones.
  - Window labels are the boundary; a window in several capabilities gets the union of their permissions.
  - Remote access is risky: on Linux and Android an iframe can't be told apart from its window.
- **Compile-time checks:**
  - A capability that names an unknown permission fails the `tauri-build` build script ("Permission … not found", community reports and tauri-apps/tauri#9502).
  - `generate_context!` panics when the configured frontend dist path does not exist ("… is set to "../dist" but this path doesn't exist").
  - So `cargo check` in `src-tauri` validates config and capabilities. It needs the dist dir to exist.
- **CLI** [reference/cli]: `init dev build bundle android ios migrate info add remove plugin icon signer completions permission capability inspect`. None of them validates the config without building.
- **Tests:**
  - Rust: `tauri::test` (feature `test`, unstable) provides `mock_builder`, `mock_context`, `noop_assets`, `mock_app`, `get_ipc_response` and `assert_ipc_response` [docs.rs/tauri/latest/tauri/test].
  - Frontend: `@tauri-apps/api/mocks` provides `mockIPC` (event mocking with `shouldMockEvents` since 2.7.0), `mockWindows` and `clearMocks` [develop/tests/mocking].
- **Not verified:** whether a `dev`-cfg `cargo check` with `devUrl` set still requires the dist dir. The profile creates it either way, which is harmless.
