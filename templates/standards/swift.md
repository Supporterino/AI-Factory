# Swift standard

<!-- Sources:
[api] Swift API Design Guidelines — https://www.swift.org/documentation/api-design-guidelines/
[style] Swift.org: Swift Style Guide — https://www.swift.org/documentation/api-design-guidelines/#fundamentals
[format] SwiftFormat rules — https://github.com/nicklockwood/SwiftFormat/blob/master/Rules.md
[lint] SwiftLint rules — https://realm.github.io/SwiftLint/rule-directory.html
[testing] Swift Testing — https://developer.apple.com/documentation/testing
[xcode] Xcode Build Settings Reference — https://developer.apple.com/documentation/xcode/build-settings-reference
-->

## Summary

- Keep the package/plugin layout and deployment target the repository already declares.
- `swiftformat --lint` and `swiftlint` are gates; never suppress a rule without a reason.
- Names read as prose at the call site; types are nouns, methods are verbs, booleans are assertions.
- Prefer values and `let`; use `var` only when mutation is part of the design.
- Handle errors with `throws`/`Result`; do not trap or force-unwrap outside tests and proven invariants.
- Public APIs have documentation comments and explicit access control; implementation stays internal.
- Test behaviour with Swift Testing (or the repo's XCTest suite); one test per spec scenario.

## Layout and access

<!-- [api] Fundamentals; [xcode] Packaging -->
- Keep the repository's existing package and plugin directories; don't introduce a second source root. <!-- factory -->
- One primary type per file, file named after the type; extensions that add protocol conformance live beside it.
- Default to `internal`. Add `public` only for the module's real surface; mark implementation details `private` or `fileprivate`.
- Keep platform code behind `#if os(iOS)` / `#if os(macOS)` and shared code platform-neutral. <!-- factory -->

## Naming and API shape

<!-- [api] Naming; [style] Naming -->
- Types and protocols are `UpperCamelCase`; functions, properties and cases are `lowerCamelCase`.
- Methods read as a sentence at the call site: `move(from:to:)`, not `moveFromTo(_:_:)`.
- Booleans assert a fact: `isEnabled`, `hasPermission`, `canRetry`.
- Omit needless words; the argument label carries the role (`add(_ element:)`, `remove(at:)`).
- Acronyms keep a single case (`URLSession`, `userID`); don't abbreviate domain words.

## Values, optionals and errors

<!-- [api] Fundamentals; [testing] Error Handling -->
- Prefer `let`; use `var` only where mutation is required and scoped.
- Avoid force unwrap (`!`), `try!` and `as!` outside tests; use `guard let`, `if let`, or throw.
- Use `throws` for recoverable failure and typed errors for cases callers branch on; never discard an error.
- `fatalError` only for a broken invariant at startup, with a message naming the invariant. <!-- factory -->

## Concurrency

<!-- [api] Concurrency; [lint] Concurrency rules -->
- Keep UI work on the main actor; mark views and view models `@MainActor` where the framework expects it.
- Use structured concurrency (`async let`, task groups); do not detach a task without an owner and cancellation path.
- Shared mutable state is an actor or guarded by a lock; document the isolation boundary.
- Never block the main actor with file, network or database I/O. <!-- factory -->

## Tauri plugins and iOS/macOS glue

<!-- [xcode] Frameworks; [api] Documentation -->
- A Tauri plugin exposes a typed Rust API; Swift stays behind that boundary and never becomes the public contract.
- Request permission strings and entitlements from the security owner; do not edit capability files here. <!-- factory -->
- Verify the host build and the iOS target compile; report which SDK/target you used. <!-- factory -->

## Testing

<!-- [testing] Test declarations; [lint] Test rules -->
- Use Swift Testing (`@Test`, `#expect`) in new code; keep the repo's XCTest suite where it already exists.
- Test behaviour through the public API; avoid snapshot-only tests and sleeps.
- Name tests after the scenario they cover; one scenario can have several focused tests.
- Keep tests deterministic: inject clocks, file systems and network clients at the boundary. <!-- factory -->

## Formatting and verification

<!-- [format] Rules; [lint] Configuration -->
- `swiftformat --lint` must pass; do not reformat code outside the task.
- `swiftlint lint` must pass with the repository's config; fix the cause instead of adding `// swiftlint:disable`.
- `swift build` (and the iOS target build where relevant) must pass before the task is done. <!-- factory -->
