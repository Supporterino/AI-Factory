# Rust standard

<!-- Sources:
[api] Rust API Guidelines (checklist + chapters) — https://rust-lang.github.io/api-guidelines/checklist.html
[book-errors] The Rust Programming Language, ch. 9 Error Handling (9.2, 9.3) — https://doc.rust-lang.org/book/ch09-00-error-handling.html
[book-tests] The Rust Programming Language, ch. 11.3 Test Organization — https://doc.rust-lang.org/book/ch11-03-test-organization.html
[book-modules] The Rust Programming Language, ch. 7.5 Separating Modules into Different Files — https://doc.rust-lang.org/book/ch07-05-separating-modules-into-different-files.html
[style] The Rust Style Guide (incl. Other style advice) — https://doc.rust-lang.org/style-guide/
[clippy] Clippy lint list — https://rust-lang.github.io/rust-clippy/master/
[std-error] std::error::Error and std::error module docs — https://doc.rust-lang.org/std/error/trait.Error.html
[std-result] std::result::Result (unwrap, expect) — https://doc.rust-lang.org/std/result/enum.Result.html
[std-command] std::process::Command — https://doc.rust-lang.org/std/process/struct.Command.html
[unsafe] The Rust Reference: Unsafety — https://doc.rust-lang.org/reference/unsafety.html
[nomicon] The Rustonomicon (How Safe and Unsafe Interact, Working with Unsafe) — https://doc.rust-lang.org/nomicon/
[async] Tokio: task::spawn_blocking and task module "Blocking and Yielding" — https://docs.rs/tokio/latest/tokio/task/fn.spawn_blocking.html
-->

## Summary

- Code is `cargo fmt` formatted and passes `cargo clippy --all-targets -- -D warnings`; keep the repo's existing crate layout.
- Return `Result` for expected failures; panic only on broken invariants; no `unwrap` outside tests, `expect("… should …")` for proven invariants.
- Error types implement `Error` + `Display` with lowercase messages; never use `()` as an error type.
- Borrow parameters (`&str`, `&[T]`), take ownership only when stored, and never `clone()` just to satisfy the borrow checker.
- Follow API-guideline naming (C-CASE, `as_`/`to_`/`into_`, no `get_`), keep fields private, use newtypes for domain values.
- Every `unsafe` block has a `// SAFETY:` comment; never block an async task; pass untrusted input as `Command` args.
- Unit tests go in a sibling `tests.rs` (`#[cfg(test)] mod tests;`), integration tests in `tests/`, named after spec scenarios.

## Formatting and lints

<!-- [style] default style, other style advice; [clippy] allow_attributes_without_reason -->
- Keep the repo's existing crate/workspace layout, module style and dependencies; follow local conventions where they differ from this file. <!-- factory -->
- Format with `cargo fmt --all`; never hand-format against rustfmt. Every warning fails the gates, so code must be clippy-clean. <!-- factory -->
- Use `///` docs placed before attributes, `//!` only for module/crate docs, one combined `#[derive(...)]`, and no `#[path]`.
- Prefer expressions: `let x = if cond { a } else { b };` rather than assigning in each branch.
- Fix lints instead of silencing them; if unavoidable, scope the suppression to one item with a reason: `#[expect(clippy::lint, reason = "…")]` (Rust 1.81+; before that, `#[allow]` with a comment).

## Naming

<!-- [api] C-CASE, C-CONV, C-GETTER, C-ITER, C-CTOR; [style] advice; [clippy] wrong_self_convention, new_without_default -->
- `snake_case` for modules, functions, methods, fields, locals, macros; `UpperCamelCase` for types, traits, variants; `SCREAMING_SNAKE_CASE` for consts and statics.
- Acronyms are one word (`HttpClient`, `Uuid`, `parse_url`). Write a reserved word as `r#type` or `type_`, never a misspelling like `typ`.
- Conversions: `as_` is free (borrowed→borrowed), `to_` is costly or produces an owned value, `into_` consumes `self`.
- Getters are named after the field (`name()`, `name_mut()`), not `get_name()`. Iterator methods are `iter`/`iter_mut`/`into_iter`.
- Constructors are associated functions: `new`, `with_*` variants, `from_*` for conversions needing extra args. A public no-arg `new` needs a matching `Default`.

## Types and API shape

<!-- [api] C-COMMON-TRAITS, C-DEBUG, C-DEBUG-NONEMPTY, C-CONV-TRAITS, C-NEWTYPE, C-CUSTOM-TYPE, C-VALIDATE, C-STRUCT-PRIVATE, C-HIDDEN, C-BUILDER, C-DTOR-FAIL; [book-errors] 9.3 custom types for validation -->
- Derive the common traits that fit (`Debug`, `Clone`, `PartialEq`, `Eq`, `Hash`, `Default`, `Ord`, `Copy` for small values). Every public type has a non-empty `Debug`.
- Implement conversions with `From`/`TryFrom` (and `AsRef`/`AsMut`); never implement `Into`/`TryInto` directly.
- Wrap primitives with domain meaning in newtypes (`struct UserId(u64)`); use enums instead of bare `bool`/`Option` arguments.
- Validate once in the constructor of a type with private fields, then accept that type instead of re-checking raw values.
- Keep struct fields private unless the struct is passive data; expose getters. Default to private or `pub(crate)`; `pub` only for the crate's interface.
- Use a builder for many optional settings: required data in `new`, `&mut self` setters, terminal `build()`; take `self` by value only when building must take ownership.
- `Drop` must not fail or block; offer an explicit `close()` returning `Result` for teardown that can fail.

## Errors

<!-- [api] C-GOOD-ERR; [std-error] Error, source(), message style; [book-errors] 9.2 ? and From; [clippy] result_unit_err -->
- Fallible library functions return a dedicated error type implementing `Debug`, `Display` and `std::error::Error`, and `Send + Sync + 'static`. Never use `()` as the error type, even without a payload.
- `Display` messages are concise, lowercase, without trailing punctuation, and name the failing thing: `failed to read config at /etc/app.toml`.
- When wrapping a lower-level error, expose it via `source()` _or_ print it in `Display`, never both (it would be reported twice).
- Propagate with `?`; implement `From<LowerError>` so `?` converts, or `map_err` into a variant carrying context (path, id, operation).
- Use the error-helper crates the repo already uses (e.g. `thiserror`, `anyhow`); do not add new ones. <!-- factory -->

## Result, panic, unwrap

<!-- [book-errors] 9.3; [std-result] unwrap, expect; [std-error] "expect as precondition"; [clippy] unwrap_used, expect_used -->
- Return `Result` for failures that occur in normal operation (I/O, parsing input, network, missing files), so the caller decides; prefer `?`, `match`, `unwrap_or_else`, `ok_or` over panicking.
- Panic only when a contract or invariant is violated (a bug), and document it under `# Panics`.
- No `unwrap()` outside tests (where panicking fails the test). When you know more than the compiler, use `expect` with a "should" precondition: <!-- factory -->

  ```rust
  let len = u16::try_from(HEADER.len()).expect("HEADER constant should fit in a u16");
  ```

## Ownership and borrowing

<!-- [api] C-CALLER-CONTROL, C-GENERIC; [clippy] ptr_arg, needless_pass_by_value, redundant_clone, unnecessary_to_owned -->
- Take `&str`, `&[T]`, `&Path` rather than `&String`, `&Vec<T>`, `&PathBuf` (clippy `ptr_arg` fails the gate); use generics when only iterating or opening paths:

  ```rust
  fn word_count(text: &str) -> usize          // not &String or String
  fn total(items: &[Item]) -> u64             // not &Vec<Item>
  fn load(path: impl AsRef<Path>) -> io::Result<Config>
  ```
- Take a parameter by value only when the function stores or consumes it; never borrow and then clone internally.
- Do not `.clone()`, `.to_owned()` or `.to_string()` a value used once and then dropped; restructure borrows instead.

## Documentation

<!-- [api] C-CRATE-DOC, C-EXAMPLE, C-QUESTION-MARK, C-FAILURE, C-LINK; [clippy] missing_errors_doc, missing_panics_doc, missing_safety_doc -->
- Document every public item; crate docs and public functions get a runnable example that uses `?` (hide the `main` wrapper with `# ` lines); link related items as [`Config::load`].
- Add `# Errors` to public functions returning `Result`, `# Panics` when they can panic, `# Safety` to every `unsafe fn` listing all caller invariants.

## Unsafe

<!-- [unsafe] unsafe operations; [nomicon] safe/unsafe meaning, working with unsafe; [clippy] undocumented_unsafe_blocks, missing_safety_doc; [api] C-SEND-SYNC -->
- Write `unsafe` only when the task requires it; prefer safe std or existing-dependency APIs. Crates without unsafe may declare `#![forbid(unsafe_code)]`.
- Keep each `unsafe` block minimal, with a `// SAFETY:` comment directly above it explaining why every contract holds:

  ```rust
  // SAFETY: `i < self.len` was checked above and `len` never exceeds the allocation.
  let byte = unsafe { *self.ptr.add(i) };
  ```
- Encapsulate unsafe behind a safe API with invariants in private fields; no safe caller may cause UB, even via buggy `Ord`/`Hash` impls. Justify every `unsafe impl Send`/`Sync` the same way.

## Async and concurrency

<!-- [async] spawn_blocking, Blocking and Yielding; [clippy] await_holding_lock; [api] C-DTOR-BLOCK -->
- Use the async runtime the repo already uses. <!-- factory -->
- Never block an async task: no `std::thread::sleep`, blocking `std::fs`/`std::net` I/O or long CPU loops, including in `Drop` impls run there.
- Move bounded blocking work to `tokio::task::spawn_blocking` (not cancellable once started); run long-lived loops on a `std::thread`, heavy CPU work on a CPU pool.
- Never hold a `std::sync::MutexGuard` across `.await`; lock inside a short non-async method, or use message passing.

## Security

<!-- [std-command] arg/args, Windows caveats -->
- Run external programs with `Command::new(prog).arg(..)`/`.args(..)`; arguments are passed literally, no shell. Never build `sh -c` strings from input or pass untrusted input to Windows `.bat`/`.cmd` files:

  ```rust
  // don't: Command::new("sh").arg("-c").arg(format!("git log -- {user_path}"))
  Command::new("git").args(["log", "--", user_path]).output()?;
  ```
- Use parameterised queries / bind parameters for SQL; never `format!` input into a query. <!-- factory -->
- Never log secrets, tokens or personal data; give types holding them a hand-written `Debug` that redacts the value. <!-- factory -->

## Tests

<!-- [book-tests] unit tests, private functions, integration tests, tests/common/mod.rs, binary crates; [book-modules] module file paths -->
- Unit tests live in a separate `tests.rs` beside the module, declared in the module file: <!-- factory -->

  ```rust
  #[cfg(test)]
  mod tests; // src/parser.rs -> src/parser/tests.rs; src/lib.rs -> src/tests.rs
  ```
- This deliberately deviates from the Book's inline `mod tests { … }`: the tester agent may only edit `tests/*`, `*/tests/*`, `*/tests.rs`, `benches/*`. <!-- factory -->
- Start `tests.rs` with `use super::*;`; it is still a child module, so private items remain testable.
- Integration tests go in `tests/*.rs` against the public API; shared helpers in `tests/common/mod.rs`. Keep `main.rs` thin, logic in `lib.rs`.
- One behaviour per `#[test]`; every spec scenario maps to at least one test named after it (`fn rejects_expired_token()`). <!-- factory -->
