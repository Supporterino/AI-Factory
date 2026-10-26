# React standard

<!-- Sources:
[rules] Rules of React (Components and Hooks must be pure; React calls Components and Hooks; Rules of Hooks) — https://react.dev/reference/rules
[pure] Keeping Components Pure — https://react.dev/learn/keeping-components-pure
[no-effect] You Might Not Need an Effect — https://react.dev/learn/you-might-not-need-an-effect
[effects] Synchronizing with Effects — https://react.dev/learn/synchronizing-with-effects
[lifecycle] Lifecycle of Reactive Effects — https://react.dev/learn/lifecycle-of-reactive-effects
[deps] Removing Effect Dependencies — https://react.dev/learn/removing-effect-dependencies
[state] Choosing the State Structure — https://react.dev/learn/choosing-the-state-structure
[sharing] Sharing State Between Components — https://react.dev/learn/sharing-state-between-components
[reset] Preserving and Resetting State — https://react.dev/learn/preserving-and-resetting-state
[lists] Rendering Lists — https://react.dev/learn/rendering-lists
[compiler] useMemo — https://react.dev/reference/react/useMemo
[dom] Common components (dangerouslySetInnerHTML) — https://react.dev/reference/react-dom/components/common
[a11y] WAI-ARIA APG: Read Me First — https://www.w3.org/WAI/ARIA/apg/practices/read-me-first/
[a11y-names] WAI-ARIA APG: Providing Accessible Names and Descriptions — https://www.w3.org/WAI/ARIA/apg/practices/names-and-descriptions/
[a11y-keyboard] WAI-ARIA APG: Developing a Keyboard Interface — https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/
[rtl] Testing Library: Guiding Principles — https://testing-library.com/docs/guiding-principles
[queries] Testing Library: About Queries, Priority — https://testing-library.com/docs/queries/about#priority
[user-event] Testing Library: user-event Introduction — https://testing-library.com/docs/user-event/intro
-->

## Summary

- Keep rendering pure: same props, state and context give the same JSX; side effects go in event handlers, effects only as last resort.
- Never mutate props, state, hook arguments or values already used in JSX; build new objects and update through the state setter.
- Call hooks only at the top level of components and custom hooks; keep `react-hooks` lint clean and never suppress `exhaustive-deps`.
- Derive values during render; use effects only to sync with external systems, with cleanup and every reactive dependency listed.
- Keep state minimal with one owner: no redundant, duplicated or contradictory state; lift to the closest common parent; reset with `key`.
- Keep the repo's structure, state library, styling and data layer; no untrusted `dangerouslySetInnerHTML`; no secrets in client code.
- Test visible behaviour with Testing Library: `getByRole` first, `user-event` interactions, at least one test named after each spec scenario.

## Project and security

<!-- factory; [dom] dangerouslySetInnerHTML -->
- Keep the repo's existing component structure, state library, styling approach, data layer and naming; do not introduce alternatives. <!-- factory -->
- Gates: the repo's lint (eslint incl. `react-hooks`/`jsx-a11y` if configured, or biome), `tsc --noEmit`, and vitest/jest must pass. <!-- factory -->
- No `dangerouslySetInnerHTML` with untrusted content; if raw HTML is unavoidable, sanitise it with the repo's sanitiser and build `{ __html }` where it is produced. <!-- factory -->
- No secrets (API keys, tokens, credentials) in client code or public env vars; everything shipped to the browser is public. <!-- factory -->

## Purity and immutability

<!-- [rules] Components and Hooks must be pure; React calls Components and Hooks; [pure] Keeping Components Pure; [reset] Don't nest component definitions; [deps] Updater functions -->
- Rendering is idempotent and side-effect free: no `new Date()`/`Math.random()`, requests, subscriptions, `document.*` writes or writes to outer variables in the render body.
- Treat props, state, context, hook arguments/returns and values already passed to JSX as read-only; mutating objects created in the same render is fine.
- Replace state with new objects/arrays via the setter (spread, `map`, `filter`); use an updater (`setTodos((prev) => [...prev, todo])`) when the next value depends on the previous.
- Declare components at module top level (one nested in another loses state every render) and render them as JSX, never as `Article()`.
- Never pass hooks as props or wrap them in higher-order hooks. Code must behave identically under Strict Mode's double render and effect re-run.

## Rules of Hooks

<!-- [rules] Rules of Hooks; Strict Mode and linting -->
- Call hooks unconditionally at the top level of components and `use…` custom hooks, before any early `return`; a helper that needs a hook becomes a custom hook.
- Never call hooks in conditions, loops, event handlers, `try`/`catch`/`finally`, or callbacks given to `useMemo`, `useReducer` or `useEffect`.

## State structure

<!-- [state] Choosing the State Structure; [sharing] Sharing State Between Components; [reset] Resetting state with a key; [no-effect] Updating state based on props or state; Resetting all state when a prop changes; Adjusting some state when a prop changes -->
- Compute anything derivable from props or state during render, never store or sync it by effect; don't copy props into state unless named `initialX`/`defaultX`.
- Replace flags that can contradict (`isSending` + `isSent`) with one status union; merge variables that always change together.
- Store selected IDs, not copies of objects, and look them up during render; flatten deeply nested state into ID-keyed maps.
- Give each piece of state one owner; to coordinate siblings, lift it to the closest common parent and pass value plus handler down.
- Reset a subtree's state when its identity changes by rendering it with `key={id}`, not with an effect.
```tsx
const fullName = `${first} ${last}`; // ✅ not useState + useEffect
const selected = items.find((i) => i.id === selectedId); // ✅ ID in state, object derived
<Profile key={userId} userId={userId} />; // ✅ resets state on user change
```

## Effects and data fetching

<!-- [effects] Synchronizing with Effects; Fetching data; [lifecycle] Lifecycle of Reactive Effects; [deps] Removing Effect Dependencies; [no-effect] Sending a POST request; Chains of computations; Notifying parent components; Subscribing to an external store; Fetching data -->
- Use an effect only to synchronise with something outside React (network, browser APIs, timers, non-React widgets); one effect per synchronisation process.
- Code that runs because the user acted (submit, buy, notify parent) goes in the event handler; effects are for "because it was displayed".
- Do not chain effects that set state from other state; compute in render and set all next state in one handler. Use `useSyncExternalStore` for external stores.
- Return a cleanup that undoes the setup (disconnect, unsubscribe, `clearInterval`, `removeEventListener`); never use a ref to make an effect "run once".
- List every reactive value the effect reads (props, state, component-body values); setters and own refs may be omitted; `ref.current` and mutable globals cannot be dependencies.
- Never suppress `react-hooks/exhaustive-deps`. To drop a dependency, make it non-reactive: move constants outside the component or objects/functions into the effect, depend on primitives, use updaters or `useEffectEvent` (only where the repo's React version provides it).
- Fetch through the repo's existing data layer (e.g. TanStack Query, SWR, router loaders); render loading, error and empty states explicitly. <!-- factory -->
- When fetching in an effect, ignore stale responses in cleanup so an older request cannot overwrite a newer one; extract it into a custom hook.
```tsx
useEffect(() => {
  let ignore = false;
  fetchResults(query).then((r) => {
    if (!ignore) setResults(r);
  });
  return () => {
    ignore = true;
  };
}, [query]);
```

## Lists and keys

<!-- [lists] Rendering Lists; [reset] Preserving and Resetting State -->
- Every element returned from `map()` gets a `key` unique among siblings: a database ID, or one generated when the item is created (`crypto.randomUUID()`).
- Never key by `Math.random()` or values made during render; index keys only for static lists. Use `<Fragment key={id}>` for multi-node items; `key` isn't a prop.

## Memoisation

<!-- [compiler] useMemo: Should you add useMemo everywhere?; [no-effect] Caching expensive calculations -->
- `useMemo`/`useCallback`/`memo` are optimisations only; memoise only when a calculation is measured slow (about 1 ms+ via `console.time`, production build) with rarely changing inputs, the value goes to a `memo` child, or another hook depends on it.
- First remove the cause instead: pass JSX as `children`, keep state local, drop unnecessary effects and dependencies. If the repo uses React Compiler, rely on it.

## Accessibility

<!-- [a11y] No ARIA is better than bad ARIA; [a11y-names] Cardinal rules of naming; [a11y-keyboard] Keyboard interface -->
- Prefer native elements (`button`, `a href`, `input` with `label`) over `div` plus ARIA; a `role` obliges you to implement its keyboard behaviour.
- Every interactive element, dialog and table has a concise accessible name; prefer visible text and `<label htmlFor>`, never `placeholder` or `title` alone.
- Everything usable by pointer works by keyboard; keep a visible focus indicator; no positive `tabIndex`; when a dialog closes or a focused item is removed, move focus to its trigger or the next item.

## Testing

<!-- [rtl] Guiding Principles; [queries] Priority, types of queries, screen; [user-event] Introduction; [rules] Don't dynamically use Hooks (mock the server, not components) -->
- Tests live in `*.test.tsx`, `*.spec.tsx` or `__tests__/` (tester edits only these); every spec scenario has at least one test named after it; no snapshot-only tests. <!-- factory -->
- Test through the rendered DOM as a user would; never assert on component instances, internal state or hook calls.
- Query via `screen`: `getByRole` with `name`, then `getByLabelText`, `getByText`; `getByTestId` only when nothing else fits. If `getByRole` fails, suspect an a11y bug. Use `queryBy*` for absence, `await findBy*` for async content.
- Create `userEvent.setup()` inside the test before rendering and `await` each action; use `fireEvent` only when user-event cannot express it.
- Mock the network with canned server responses (the repo's setup, e.g. MSW), not components or hooks.
```tsx
const user = userEvent.setup();
render(<LoginForm />);
await user.click(screen.getByRole("button", { name: /sign in/i }));
expect(await screen.findByRole("alert")).toHaveTextContent(/email is required/i);
```
