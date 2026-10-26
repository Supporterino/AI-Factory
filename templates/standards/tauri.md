# Tauri v2 standard

## Summary

- The Rust side lives in `src-tauri/`: `src/lib.rs` holds `run()` and the mobile entry point, `src/main.rs` only calls it. The frontend reaches Rust only through commands, events and channels.
- Least privilege: every command and plugin permission the frontend uses is granted in a capability under `src-tauri/capabilities/`, for the windows that need it, with scopes where the permission takes them.
- Commands validate their input in Rust and return `Result<T, E>` with a serializable error. They never panic on bad input.
- The frontend calls commands through one typed module around `invoke` from `@tauri-apps/api/core`. Its tests mock the backend with `mockIPC` from `@tauri-apps/api/mocks`.
- This stacks with the Rust standard for `src-tauri/` and the TypeScript/React standards for the frontend.

## Structure

- `src-tauri/` holds:
  - `Cargo.toml` and `build.rs` (which calls `tauri_build::build()`);
  - `tauri.conf.json` and `capabilities/`;
  - `icons/` (output of `tauri icon`);
  - `src/lib.rs` and `src/main.rs`.
- Put code in `lib.rs` and its modules. Group commands in modules (e.g. `commands/`) and register them in one `tauri::generate_handler![…]`.
- Platform overrides go in `tauri.<platform>.conf.json` (`linux`, `windows`, `macos`, `android`, `ios`). They are merged as a JSON Merge Patch, so arrays replace, they don't append.
- `src-tauri/gen/` is generated (permission schemas, mobile projects). Don't edit `gen/schemas` by hand.
- Add plugins with `tauri add <plugin>`, so the Rust crate, the npm package and the default capability change together. Keep the crate and package versions aligned.

## Commands, state and events

- `#[tauri::command]` functions take typed (serde) arguments. The frontend sends them as an object with camelCase keys for the snake_case Rust parameters.
- Return `Result<T, Error>`, where `Error` implements `serde::Serialize`, e.g. a `thiserror` enum with a manual `Serialize` impl that sends the message.
- Use `async fn` for I/O and slow work. Commands without `async` run on the main thread and block the UI.
- Shared state is registered with `app.manage(…)` and read through `State<'_, T>`. Wrap mutable state in a `Mutex`/`RwLock`, and use the async runtime's lock when it is held across `.await`.
- Use commands for request/response, events (`emit`/`listen`) for notifications from Rust, and `tauri::ipc::Channel` for streams.

## Security

- One capability file per purpose, each with an `identifier`, a `description`, `windows` and `permissions` (plus `platforms` where it differs).
  - Prefer specific permissions (`core:window:allow-set-title`, `fs:allow-read-text-file` with a scope) over broad sets.
  - Do not use `"windows": ["*"]` without a stated reason.
- Window labels are the security boundary, not titles. A window that appears in several capabilities gets all of their permissions. Only privileged windows may create windows.
- Use `remote.urls` in a capability only for origins you control. On Linux and Android, Tauri cannot tell an embedded iframe from its window.
- Keep `app.security.csp` strict. Don't use `dangerous…` options, and leave `app.withGlobalTauri` off unless the app needs it.
- Capabilities do not make command code safe. Every command checks the paths, URLs and ids it receives, and never passes user input through a shell.
- No secrets in `tauri.conf.json` or the frontend bundle; updater signing keys stay out of the repo.

## Testing

- Rust:
  - Test command logic as plain functions in `tests.rs` modules (see the Rust standard).
  - For IPC-level tests, use `tauri::test` (`mock_builder`, `mock_context`, `noop_assets`, `get_ipc_response`) through the `tauri` crate's `test` feature. The module is marked unstable.
- Frontend: use `mockIPC` and `mockWindows` from `@tauri-apps/api/mocks`, with `clearMocks()` after each test. Test the typed command module rather than raw `invoke` calls.
- Use end-to-end tests through WebDriver only where the repo already has them.
- Every spec scenario maps to a test, including commands' error results.

## Gates in this factory

- Gates run in `src-tauri/`: `cargo fmt --all --check`, `cargo clippy --all-targets -- -D warnings`, `cargo check --all-targets` and `cargo test`.
- `tauri-build` and `generate_context!` compile the config and the capabilities in, so an unknown permission or a broken `tauri.conf.json` fails the build.
- `generate_context!` also needs `build.frontendDist` to exist. If it points to an unbuilt directory, the gates create it empty first (JSON config only).
- The frontend's own gates come from its TypeScript/React profile.
- On Linux the cargo gates need Tauri's system prerequisites (WebKitGTK and friends).

## Anti-patterns

- Logic in `main.rs`; `unwrap()`/`expect()` in commands.
- `fs`/`shell`/`http` permissions without scopes; capabilities for every window by default.
- `invoke("name")` string calls scattered through components.
- Blocking work in non-async commands.
- Hand-edited `gen/` files; disabling the CSP to make something work.
