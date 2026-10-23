# TypeScript / JavaScript standard

## Summary

- Strict TypeScript: `strict`, no `any`, no non-null assertions; narrow `unknown` instead.
- Validate every external input (HTTP, files, env, JSON) at the boundary with a schema.
- Small modules with named exports; pure functions where possible; no hidden global state.
- Errors are typed and handled where they can be acted on; never swallowed.
- Tests sit next to the code (`*.test.ts`) and test behaviour, not implementation.

## Naming and structure

- `camelCase` for values and functions, `PascalCase` for types, classes and React components, `UPPER_SNAKE_CASE` only for true constants.
- One concept per module. Prefer named exports; default exports only where a framework requires them.
- Keep the module structure the repo already has. Do not introduce new layers (services, managers, utils barrels) for a single use.
- Use `import type` for type-only imports. No circular imports.
- Prefer `const`; `let` only when reassigned; never `var`.

## Types

- No `any`. Use `unknown` plus narrowing, generics, or a schema-derived type.
- Model states with discriminated unions instead of optional-field soup.
- Prefer `readonly` arrays and properties for data that is not mutated.
- Derive types from schemas (`z.infer`) or from `as const` objects; don't duplicate them by hand.
- Avoid `as` casts. A cast needs a one-line comment explaining why it is safe.
- Use `satisfies` to check object literals without widening.

## Errors

- Throw `Error` subclasses with a clear message; never throw strings or plain objects.
- Catch only where you can recover, add context, or translate the error at a boundary.
- Always handle promise rejections: `await` every promise or return it; no floating promises.
- Use `try/finally` (or `using`) to release resources.
- Do not log and rethrow the same error at every layer.

## Async and performance

- Run independent awaits concurrently with `Promise.all`; keep dependent ones sequential.
- Do not block the event loop with synchronous I/O in request paths.
- Avoid N+1 calls in loops; batch where the API allows it.

## Security

- Never build shell commands, SQL or HTML by string concatenation with untrusted input.
- Use parameterised queries and the platform's escaping.
- Never log secrets, tokens or personal data.
- Do not disable TLS verification or add `eval`/`new Function`.
- Pin dependencies through the lockfile; do not add a dependency for something the standard library or an existing dependency already does.

## Testing

- Use the repo's runner (vitest, jest or `bun test`). Match its file naming.
- One behaviour per test, named after the behaviour ("returns 404 when the user is missing").
- Arrange-act-assert; no logic (loops, conditionals) in tests.
- Mock only at process boundaries (network, clock, filesystem), never the unit under test.
- No snapshot-only tests: assert on the values that matter.
- Every spec scenario maps to at least one test whose name mentions the scenario.

## Anti-patterns

- `any`, `// @ts-ignore`, `// eslint-disable` without a reason.
- Barrel files that re-export everything; deep relative imports across packages.
- Catch-all `catch (e) {}` blocks; returning `null` and `undefined` interchangeably.
- Classes with only static methods; singletons holding mutable state.
- Reformatting untouched code in the same change.
