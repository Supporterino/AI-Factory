# Rust standard

## Summary

- `cargo fmt` formatting and `cargo clippy -- -D warnings` clean.
- `Result`-based error handling with `?`; no `unwrap`/`expect` outside tests and proven invariants.
- Ownership first: borrow instead of clone, make illegal states unrepresentable with types.
- No `unsafe` unless the task requires it, with a `// SAFETY:` comment per block.
- Unit tests in `tests.rs` submodules, integration tests in `tests/`.

## Naming and structure

- `snake_case` for functions, variables and modules; `UpperCamelCase` for types and traits; `SCREAMING_SNAKE_CASE` for constants.
- Keep the crate/workspace layout the repo already has. Keep modules small and focused.
- Minimal public API: `pub(crate)` by default, `pub` only for the crate's interface.
- Derive common traits (`Debug`, `Clone`, `PartialEq`, …) where they make sense.
- Prefer enums and newtypes over booleans and raw primitives for domain values.

## Errors

- Libraries define error enums (`thiserror` if the repo uses it); binaries may use `anyhow` with `.context(...)`.
- Propagate with `?`; add context where the error crosses a boundary.
- `unwrap()`/`expect()` only in tests or with a comment proving the invariant.
- Never `panic!` for recoverable conditions.

## Ownership and performance

- Take `&str`/`&[T]` parameters instead of `String`/`Vec<T>` when ownership is not needed.
- Avoid needless `.clone()`; restructure borrows instead.
- Use iterators and their adapters; collect only when needed.
- Avoid `Rc<RefCell<…>>` webs; prefer clear ownership or message passing.

## Concurrency and async

- Use the async runtime the repo already uses; never block inside async code (`spawn_blocking` for blocking work).
- Shared state behind `Arc<Mutex<…>>`/`RwLock` with short critical sections; never hold a lock across `.await`.

## Security

- No `unsafe` without a documented invariant; prefer safe abstractions from std or existing deps.
- Use parameterised queries; `std::process::Command` with arguments, never a shell string with untrusted input.
- Do not log secrets or personal data.

## Testing

- Unit tests: declare `#[cfg(test)] mod tests;` and put them in `tests.rs` next to the module, so tests live in their own files.
- Integration tests under `tests/` against the public API.
- One behaviour per `#[test]`, named after it; use `assert_eq!` with messages for non-obvious values.
- Every spec scenario maps to at least one test whose name mentions the scenario.

## Anti-patterns

- `unwrap()` in library code, `clone()` to silence the borrow checker.
- Stringly-typed APIs; `Box<dyn Error>` in library interfaces.
- `#[allow(clippy::…)]` without a reason.
- Large `unsafe` blocks; blocking calls in async functions.
