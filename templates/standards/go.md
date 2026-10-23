# Go standard

## Summary

- `gofmt`/`goimports` formatting, `golangci-lint` and `go vet` clean.
- Errors are values: check every error, wrap with context (`%w`), handle once.
- Small packages named for what they provide; accept interfaces, return concrete types.
- `context.Context` is the first parameter of anything that does I/O or may block.
- Table-driven tests with the standard `testing` package, run with `-race`.

## Naming and structure

- Package names are short, lowercase, single words; no `util`, `common` or `helpers`.
- `MixedCaps`; exported names only when used outside the package. Acronyms keep their case (`ID`, `HTTP`).
- Avoid stutter (`user.User` is fine, `user.UserService` is not).
- Keep the module layout the repo already has (`cmd/`, `internal/`, …). Put non-public code in `internal/`.
- Define interfaces where they are consumed, keep them small (one to three methods).
- Constructors `NewX` return concrete types; zero values should be useful where possible.

## Errors

- Check every returned error. `_ =` for an error needs a comment.
- Wrap with context: `fmt.Errorf("load config %q: %w", path, err)`. Messages are lowercase, no trailing punctuation.
- Use `errors.Is` / `errors.As`; define sentinel errors (`var ErrNotFound = errors.New(...)`) or typed errors for callers to branch on.
- Handle an error once: either log it or return it, not both.
- No `panic` for expected failures; only for programmer errors at init.

## Concurrency

- Pass `ctx` down and respect cancellation; never store a context in a struct.
- Every goroutine has a clear owner and exit path; use `errgroup` for groups of work.
- Protect shared state with a mutex or confine it to one goroutine; the race detector must pass.
- Close channels from the sender side only. Prefer `sync.WaitGroup` or `errgroup` over ad-hoc signalling.

## HTTP and I/O

- Set timeouts on servers and clients; never use `http.DefaultClient` for outbound calls in production code.
- Always close response bodies and files (`defer f.Close()` after the error check).
- Validate request input at the handler boundary and return precise status codes.

## Security

- Use `database/sql` placeholders; never build SQL by concatenation.
- `os/exec` with an argument list, never `sh -c` with untrusted input.
- `crypto/rand` for secrets. Do not log secrets or personal data.

## Testing

- `_test.go` files next to the code; external test packages (`package foo_test`) for public behaviour.
- Table-driven tests with `t.Run(name, …)`; `t.Helper()` in helpers; `t.Parallel()` where safe.
- Use `httptest` for HTTP, `t.TempDir()` for files; no sleeps for synchronisation.
- Fixtures under `testdata/`.
- Every spec scenario maps to at least one subtest whose name mentions the scenario.

## Anti-patterns

- Ignored errors; `panic` for control flow; naked returns in long functions.
- Large interfaces declared by the producer; `interface{}`/`any` where a type is known.
- Global mutable state and `init()` with side effects.
- Goroutines without cancellation; `time.Sleep` in tests.
