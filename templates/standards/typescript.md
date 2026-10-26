# TypeScript / JavaScript standard

<!-- Sources:
[dos-donts] TypeScript Handbook: Do's and Don'ts — https://www.typescriptlang.org/docs/handbook/declaration-files/do-s-and-don-ts.html
[handbook] TypeScript Handbook (Everyday Types, Narrowing, More on Functions, Object Types, Enums) — https://www.typescriptlang.org/docs/handbook/2/everyday-types.html
[tsconfig] TSConfig Reference — https://www.typescriptlang.org/tsconfig
[ts49] TypeScript 4.9 release notes: The satisfies Operator — https://www.typescriptlang.org/docs/handbook/release-notes/typescript-4-9.html
[ts-js] Type Checking JavaScript Files — https://www.typescriptlang.org/docs/handbook/intro-to-js-ts.html
[google-ts] Google TypeScript Style Guide — https://google.github.io/styleguide/tsguide.html
[ts-eslint] typescript-eslint rules — https://typescript-eslint.io/rules/
[node-errors] Node.js Errors — https://nodejs.org/api/errors.html
-->

## Summary

- Keep the repo's layout, module system, tsconfig, formatter and linter config; never loosen them or add suppressions to pass a gate.
- Code must pass strict `tsc --noEmit`: no `any`, no `@ts-ignore`; take `unknown` and narrow it before use.
- Avoid `as` casts and non-null `!`; narrow with checks, `?.`, `??`, discriminated unions and exhaustive `never` switches.
- Named exports, ES modules, `import type` for type-only imports; no `namespace`, no `export let`, no `const enum`.
- Throw only `Error` subclasses with `cause`; catch as `unknown`; never leave a promise floating or unawaited in `try`.
- Validate untrusted input at the boundary with the repo's schema library; never build shell or SQL from strings; never log secrets.
- Tests go only in test files; every spec scenario has a test whose name mentions that scenario.

## Working in the repo

<!-- [google-ts] Consistency -->
- Work only on the assigned task in its worktree; do not touch unrelated files or reformat code you did not change. <!-- factory -->
- Where the repo differs from this file (ESM vs CommonJS, naming, enums, layout), follow the repo: first the file, then its directory. <!-- factory -->
- Do not edit `tsconfig*.json`, biome, eslint or prettier config, or `package.json` scripts to make a gate pass. <!-- factory -->

## Compiler strictness

<!-- [tsconfig] strict, noImplicitAny, strictNullChecks, useUnknownInCatchVariables, noUncheckedIndexedAccess, exactOptionalPropertyTypes; [google-ts] @ts-ignore; [ts-eslint] ban-ts-comment -->
- Code must pass `tsc --noEmit` under the full `strict` family: no implicit `any`, explicit `null`/`undefined` handling, `unknown` catch variables. <!-- factory -->
- If `noUncheckedIndexedAccess` is on, check indexed reads for `undefined` instead of using `!`; if `exactOptionalPropertyTypes` is on, omit optional keys rather than assigning `undefined`.
- Never use `@ts-ignore` or `@ts-nocheck`; `@ts-expect-error` only in tests, with a comment naming the expected error.

## Types

<!-- [dos-donts] General Types; [handbook] Everyday Types, More on Functions: object/unknown/Function, Guidelines for Writing Good Generic Functions; Object Types: readonly; [google-ts] any Type, Wrapper types, Do not use {}, Type inference, Prefer interfaces, Prefer optional over |undefined, Generics, Use readonly; [ts-eslint] no-explicit-any, no-wrapper-object-types, no-unsafe-function-type, no-empty-object-type -->
- Use `string`, `number`, `boolean`, `symbol`, `bigint`, `object`; never `String`, `Number`, `Boolean`, `Symbol`, `Object`, `{}` or `Function` as types.
- Use `unknown` for values of unknown shape (parsed JSON, `catch`, external data) and narrow before use; `any` is not allowed.
- Let inference type locals; annotate parameters and the return types of exported functions.
- Use `interface` for object shapes; use `type` for unions, tuples, mapped and conditional types.
- Write optional fields and params as `name?: T`, not `name: T | undefined`; add `| null` at the use site, not inside a shared alias.
- Every type parameter must relate two or more positions; drop parameters used once and avoid generics that appear only in the return type.
- Mark properties never reassigned after construction `readonly` and take non-mutated arrays as `readonly T[]`; `readonly` is shallow.

## Functions, callbacks, overloads

<!-- [dos-donts] Callback Types, Function Overloads; [handbook] More on Functions: Optional Parameters in Callbacks, Writing Good Overloads, Function; [google-ts] Function declarations, Optional vs default params -->
- Type callbacks whose result is ignored as returning `void`, not `any`; write function types as signatures, e.g. `(e: Event) => void`.
- Make callback parameters required (`(data: Data, ms: number) => void`); callers may still pass a callback taking fewer arguments.
- Prefer one signature with a union or optional trailing params over overloads; overload only when return types differ.
- If overloads are needed, list the most specific first; write one with the maximum callback arity, not one per arity.
- Use function declarations for named functions and arrows for callbacks; pass an options object instead of several optional params.

## Narrowing and unions

<!-- [handbook] Narrowing: typeof type guards, Truthiness narrowing, Using type predicates, Discriminated unions, Exhaustiveness checking; [google-ts] Switch statements; [ts-eslint] switch-exhaustiveness-check -->
- Model variants as discriminated unions with a literal tag (`kind: "ok" | "error"`), not one type with many optional fields.
- Narrow with `typeof`, `instanceof`, `in`, tag checks or `x is T` predicates; `typeof null` is `"object"`, and truthiness drops valid `0` and `""`.
- Every `switch` over a union handles each member and ends with a `default` that assigns to `never`:
```ts
switch (shape.kind) {
  case "circle": return Math.PI * shape.radius ** 2;
  case "square": return shape.side ** 2;
  default: { const unhandled: never = shape; throw new Error(`unhandled shape: ${String(unhandled)}`); }
}
```

## Assertions, literals, enums

<!-- [handbook] Everyday Types: Type Assertions, Non-null Assertion Operator, Literal Inference; Enums: Objects vs Enums, Const enum pitfalls; [google-ts] Type and non-nullability assertions, Type assertions and object literals, Const enums, Type coercion; [ts-eslint] no-non-null-assertion; [ts49] satisfies -->
- Do not use `as T` or postfix `!`; neither is checked at runtime. Narrow, use `?.`/`??`, or validate instead.
- If an assertion is unavoidable, add a one-line comment proving it safe; never write `as unknown as T` without one.
- Type object literals with an annotation (`const cfg: Config = {...}`) or `satisfies`, never `{...} as Config`.
- Use `satisfies` to check a literal yet keep its narrow type: `const routes = {...} satisfies Record<RouteName, string>`.
- In new code prefer an `as const` object plus derived union to `enum`; keep existing enums. Never `const enum`; never coerce enums to boolean.
```ts
export const Status = { Active: "active", Closed: "closed" } as const;
export type Status = (typeof Status)[keyof typeof Status];
```

## Modules

<!-- [google-ts] Exports, Import type, Mutable exports, Export visibility, Use modules not namespaces; [tsconfig] verbatimModuleSyntax; [ts-eslint] no-namespace -->
- Use ES `import`/`export`; no `namespace`, `/// <reference>` or `require` in TypeScript unless the repo is CommonJS.
- Use named exports; add a default export only where a framework requires one. <!-- factory -->
- Import type-only symbols with `import type` (or inline `type`); `verbatimModuleSyntax` requires it.
- Export only what other modules use; never `export let`, expose mutable state through a getter function.

## Values, equality, operators

<!-- [google-ts] Equality checks, Use const and let, Type coercion, Iterating objects, Disallowed features; [ts-eslint] prefer-nullish-coalescing, prefer-optional-chain -->
- Use `===`/`!==`; the only exception is `== null` to match both `null` and `undefined`.
- Use `??` (and `??=`) for defaults, not `||`, which also replaces `0`, `""` and `false`. Use `?.` for optional access.
- Use `const` by default and `let` only when reassigned; never `var`, `eval`, `new Function(string)`, `with` or `debugger`.
- Parse numbers with `Number(x)` and check `Number.isNaN`; no unary `+`, no `parseInt` for base 10.
- Iterate with `for...of` over arrays or `Object.entries()`; no `for...in` on arrays.

## Errors

<!-- [google-ts] Exception handling, Only throw errors, Catching and rethrowing, Empty catch blocks; [tsconfig] useUnknownInCatchVariables; [ts-eslint] only-throw-error, prefer-promise-reject-errors; [node-errors] new Error(message[, options]), error.code -->
- Throw only `new Error(...)` or a subclass; never throw or reject with strings, plain objects or `undefined`.
- Define `Error` subclasses for failures callers must tell apart; pass the original as `{ cause }` when wrapping.
- Treat caught values as `unknown`; narrow with `instanceof` and branch on class or `code`, never on message text.
- Catch only to recover, add context or translate at a boundary; an empty `catch` needs a comment explaining why.
```ts
try {
  await repo.save(order);
} catch (err: unknown) {
  throw new OrderSaveError(`saving order ${order.id} failed`, { cause: err });
}
```

## Async

<!-- [ts-eslint] no-floating-promises, no-misused-promises, return-await, await-thenable; [node-errors] Error propagation and interception -->
- Handle every promise: `await` it, `return` it, or attach `.catch`; `void promise` does not handle a rejection.
- Never pass an `async` function where a `void` callback is expected (`forEach`, event handlers), use a promise as a condition, or spread one.
- Inside `try`, write `return await p` so the `catch`/`finally` sees the rejection.
- Run independent work with `Promise.all`/`Promise.allSettled`; keep dependent awaits sequential in `for...of`.

## Untrusted input and secrets

<!-- [handbook] More on Functions: unknown -->
- Type raw input (HTTP bodies, env, files, `JSON.parse`) as `unknown` and validate it at the boundary with the repo's schema library; derive types from the schema. <!-- factory -->
- Never build shell commands or SQL by string concatenation; pass argument arrays (`execFile`) and parameterised queries. <!-- factory -->
- Never log or put into error messages secrets, tokens, credentials or personal data. <!-- factory -->

## Plain JavaScript repos

<!-- [ts-js] Type-checking JavaScript files; [google-ts] JSDoc type annotations -->
- All rules above apply; where the repo uses `// @ts-check` or `checkJs`, type with JSDoc (`@type`, `@param`, `@returns`, `@typedef`). <!-- factory -->
- In `.ts` files, do not repeat types in JSDoc; the signature carries them.

## Tests

<!-- factory -->
- Put tests only in the repo's test files; the tester agent may edit nothing else. <!-- factory -->
- Every spec scenario maps to at least one test whose name mentions the scenario. <!-- factory -->
- Use the repo's runner and file naming; one behaviour per test; mock only process boundaries (network, clock, filesystem). <!-- factory -->
