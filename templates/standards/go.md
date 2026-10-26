# Go standard

<!-- Sources:
[effective-go] Effective Go — https://go.dev/doc/effective_go
[review] Go Code Review Comments — https://go.dev/wiki/CodeReviewComments
[test-comments] Go Test Comments — https://go.dev/wiki/TestComments
[doc-comments] Go Doc Comments — https://go.dev/doc/comment
[errors] Working with Errors in Go 1.13 — https://go.dev/blog/go1.13-errors
[context] Go Concurrency Patterns: Context — https://go.dev/blog/context
[layout] Organizing a Go module — https://go.dev/doc/modules/layout
[sql-injection] Avoiding SQL injection risk — https://go.dev/doc/database/sql-injection
-->

## Summary

- Follow the repo's existing layout, module structure and conventions; these defaults apply only where the repo has none.
- Code is `gofmt`-clean and passes `go vet`, the repo's linter and `go test -race`: no data races, no leaked goroutines.
- Names are short MixedCaps with uniform initialisms (`userID`, `ServeHTTP`); package names are lowercase single words, never repeated in identifiers.
- Check every error; wrap with `%w` only when callers may inspect the cause; test with `errors.Is`/`errors.As`; error strings lowercase, unpunctuated.
- `context.Context` is the first parameter, named `ctx`, never stored in a struct; every goroutine has a known exit.
- Define small interfaces where they are consumed; return concrete types; make the zero value useful.
- Tests use the standard `testing` package, table-driven where cases share logic; failure messages name the function, input, got, then want.

## Layout and packages

<!-- [layout] internal, cmd; [effective-go] Package names; [review] Package Names, Imports, Import Blank, Import Dot -->
- Keep the existing module layout, package boundaries and naming even where they differ from this file. <!-- factory -->
- New code defaults to `internal/`; executables go in `cmd/<name>/main.go` when a repo has several commands or mixes commands and libraries.
- Package names: short, lowercase, one word, no underscores or mixedCaps, equal to the directory's base name. Never `util`, `common`, `misc`, `helpers`.
- Don't repeat the package name in its identifiers: `bufio.Reader`, not `bufio.BufReader`; `ring.New`, not `ring.NewRing`.
- Rename an import only on a collision, renaming the more local one. No dot imports; blank (`_`) imports only in `main` or tests.

## Naming

<!-- [effective-go] Names, Getters, Interface names, MixedCaps; [review] Initialisms, Mixed Caps, Receiver Names, Variable Names -->
- MixedCaps or mixedCaps, never underscores; unexported constants are `maxLength`, not `MAX_LENGTH`.
- Initialisms keep one case throughout: `URL`/`url`, `HTTPClient`, `appID`; never `Url`, `Id`, `Http`.
- Getters drop `Get` (`Owner()`, `SetOwner(o)`). Single-method interfaces are method name plus `-er` (`Reader`). Use `Read`, `Write`, `String`, `Close` only with their standard signature and meaning (`String()`, not `ToString()`).
- Receiver names are one or two letters derived from the type (`c` for `Client`), identical across all methods; never `this`, `self`, `me`. Local names shrink with their scope (`i`, `buf`).

## Control flow and functions

<!-- [effective-go] Formatting, If, Multiple return values, Named result parameters, Defer; [review] Gofmt, Indent Error Flow, Line Length, Naked Returns, Named Result Parameters, In-Band Errors, Synchronous Functions -->
- `gofmt -l` must print nothing; run `goimports` if available. No hard line limit unless the repo's linter sets one; break at logical points.
- Handle the error or special case first and return; keep the success path unindented and drop `else` after a `return`. Scope values in the statement: `if err := f(); err != nil {`.
- Return `error` (or `ok bool`) as the last result instead of in-band sentinels like `-1`, `""` or `nil`.
- Name results only when they document (two results of one type) or a deferred closure must set them; bare `return` only in short functions.
- Release resources with `defer` right after the successful acquire: `defer f.Close()` follows the `err` check.

## Types, interfaces and values

<!-- [effective-go] Data, Interfaces, Interface checks, Pointers vs. Values; [review] Interfaces, Receiver Type, Copying, Pass Values, Declaring Empty Slices -->
- Declare interfaces in the package that uses them, listing only the methods it calls. Producers return concrete types (usually struct pointers). No interfaces just for mocking.
- Assert interface satisfaction at compile time when nothing else would: `var _ io.Writer = (*Buffer)(nil)`.
- Design the zero value to be usable (`sync.Mutex`, `bytes.Buffer` need no init); add `NewT` only when setup is required.
- Pointer receivers when a method mutates, the struct holds a `sync.Mutex` or is large; value receivers for small immutable types. Don't mix both on one type, don't copy such values, and don't pass `*string` or `*io.Reader` to save bytes.
- Declare empty slices as `var s []T`; use `[]T{}` only when encoding must emit `[]`. APIs must not treat nil and empty slices differently.
- Use a concrete type or type parameter instead of `any` when the type is known. No mutable package-level state; `init()` only registers. <!-- factory -->

## Errors

<!-- [errors] Errors in Go 1.13, Whether to Wrap, Errors and package APIs; [effective-go] Errors; [review] Handle Errors, Error Strings; [test-comments] Test Error Semantics -->
- Check every returned error; never discard one with `_`. Check the `Close` error of files you wrote.
- Add context naming the operation and input; error strings are lowercase with no trailing punctuation and may carry an origin prefix (`"config: missing key"`).
- Use `%w` when callers should be able to inspect the cause; wrapping makes the cause part of your API. Use `%v` to hide implementation details such as a driver's error.
- Inspect errors with `errors.Is` (values) and `errors.As` (types), never `==`, type assertions or string matching.
- Export a sentinel (`var ErrNotFound = errors.New("store: not found")`) or error type only when callers must branch on it; document which errors a function returns.
- Handle an error once: return it or log it, not both. <!-- factory -->
```go
if errors.Is(err, fs.ErrNotExist) {
	return defaults, nil
}
if err != nil {
	return Config{}, fmt.Errorf("load config %q: %w", path, err)
}
```

## Panics

<!-- [effective-go] Panic, Recover; [review] Don't Panic -->
- Return errors for anything that can fail at runtime; never use `panic` for ordinary error handling or control flow.
- Panic only on impossible states (programmer errors) or failed initialisation, e.g. compiling a constant regexp at package level.
- A panic must not leave a package's exported API: if a package panics internally, `recover` in a deferred function at the entry point and return an `error`.

## Concurrency and context

<!-- [context] all; [review] Contexts, Goroutine Lifetimes, Synchronous Functions; [effective-go] Concurrency, Share by communicating -->
- Every function on a request path, doing I/O, or that may block takes `ctx context.Context` first: `func (c *Client) Get(ctx context.Context, id string)`.
- Never store a context in a struct or define custom context types; pass it explicitly.
- Call the `cancel` from `WithCancel`/`WithTimeout` with `defer`; when `ctx.Done()` closes, stop work and return `ctx.Err()` (wrapped). Context values: request-scoped data only, unexported key type.
- Prefer synchronous functions; let callers add concurrency. Before starting a goroutine know how it ends (context, closed channel, `WaitGroup`); a goroutine blocked forever on a channel is a leak.
- "Share memory by communicating"; otherwise guard shared state with a mutex.
- Code must be race-free under `go test -race`. Pass `context.TODO()`, never `nil`. Only senders close channels. Use `golang.org/x/sync/errgroup` only if `go.mod` already requires it. <!-- factory -->
```go
ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
defer cancel()
resp, err := c.do(ctx, req)
```

## Doc comments

<!-- [doc-comments] General rules, Package, Command, Type, Func, Syntax; [review] Doc Comments, Comment Sentences, Package Comments, Examples -->
- Every exported name, and every non-trivial unexported type or function, has a doc comment directly above it, no blank line between. Write full sentences that start with the name: `// Fetch returns ...`; boolean functions "report whether ...".
- Package comment `// Package store ...` sits directly above `package` in exactly one file; for `main` it starts with the command name.
- Type comments say what a value represents, what its zero value means if not obvious, and whether it is safe for concurrent use.
- Say what and why, not how the algorithm works. Mark replacements with a `Deprecated:` paragraph; link names as `[io.Reader]`.

## Untrusted input

<!-- [sql-injection]; [review] Crypto Rand; [effective-go] A web server (html/template) -->
- Pass values as query arguments with the driver's placeholder (`?`, `$1`); never build SQL with `fmt.Sprintf` or `+`.
- Run programs as `exec.CommandContext(ctx, "git", "log", ref)`; never pass user input through `sh -c` or any shell. <!-- factory -->
- Generate keys, tokens and nonces with `crypto/rand`, never `math/rand`. Render HTML with `html/template`, not `text/template`, so input is escaped.
- Never log secrets, tokens, passwords or credential-bearing headers or bodies. <!-- factory -->
- Validate input at the boundary (handler, flag parsing). Set timeouts on `http.Server` and `http.Client`; always close response bodies. <!-- factory -->

## Tests

<!-- [test-comments] all sections; [review] Useful Test Failures -->
- Tests live in `_test.go` files beside the code; fixtures go under `testdata/`. Match the repo's choice of `package foo` vs `package foo_test`. <!-- factory -->
- Every spec scenario maps to at least one test or subtest whose name mentions the scenario. <!-- factory -->
- Use the standard `testing` package; no assertion libraries unless the repo already uses one.
- Use a table with `t.Run` when cases share checking logic; write separate tests when the logic differs. Subtest names stay readable. New packages get a runnable `Example`.
- Failure messages name the function and input, then got before want: `Parse(%q) = %v, want %v`.
- Prefer `t.Error` so one run reports every failure; `t.Fatal` only when setup fails or the rest cannot proceed, and only on the test goroutine.
- Compare whole values. Use `cmp.Diff` with a `(-want +got)` key if `go.mod` already requires go-cmp; else `reflect.DeepEqual`, `slices.Equal`. Never add dependencies from tests. <!-- factory -->
- Check errors with `errors.Is`/`errors.As`, or just `err != nil` when the API exposes no structure; never compare error text. Decode JSON before comparing rather than matching bytes.
- Call `t.Helper()` in setup helpers, but don't build assert-style helpers. Use `t.TempDir`, `t.Cleanup`, `httptest`; `t.Parallel()` only without shared state; never `time.Sleep` to synchronise. <!-- factory -->
```go
t.Run(tc.name, func(t *testing.T) { // inside: for _, tc := range tests
	if got := Parse(tc.in); got != tc.want {
		t.Errorf("Parse(%q) = %v, want %v", tc.in, got, tc.want)
	}
})
```
