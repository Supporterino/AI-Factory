# React standard

Applies on top of the TypeScript standard.

## Summary

- Function components and hooks only; components are pure functions of props and state.
- Follow the Rules of Hooks; effects synchronise with external systems and nothing else.
- Accessible by default: semantic HTML, labels, keyboard support (jsx-a11y clean).
- Test with Testing Library through what the user sees; no snapshot-only tests.

## Components

- One exported component per file, named like the file, in `PascalCase`.
- Type props with an explicit `interface Props` or `type Props`; no `React.FC`.
- Keep components small. Extract a component when a piece has its own state or is reused, not to shorten a file.
- Derive values during render instead of storing them in state. State holds the minimum needed.
- Lift state only as far as needed; prefer composition (children, render props) over prop drilling through many layers.
- Lists need stable keys from the data, never the array index for reorderable lists.

## Hooks and effects

- Call hooks unconditionally at the top level of components and custom hooks.
- `useEffect` is for synchronising with something outside React (subscriptions, timers, DOM APIs). Do not use it to derive state or to react to prop changes that can be computed during render.
- Every effect that subscribes must clean up.
- Dependency arrays are complete; fix the code instead of silencing `react-hooks/exhaustive-deps`.
- Use `useMemo`/`useCallback` only for measured costs or referential stability that a child or effect needs.
- Custom hooks start with `use` and encapsulate one concern.

## Data and side effects

- Fetching goes through the repo's data layer (e.g. React Query, router loaders); do not invent a new one.
- Handle loading, error and empty states explicitly.
- Never put secrets in client code; treat everything shipped to the browser as public.
- Avoid `dangerouslySetInnerHTML`; if unavoidable, sanitise with the repo's sanitiser and explain why.

## Accessibility

- Use the right element (`button` for actions, `a` for navigation, `label` for inputs).
- Every interactive element is reachable and operable by keyboard and has an accessible name.
- Images have meaningful `alt` text or `alt=""` when decorative.
- Do not convey information by colour alone.

## Testing

- Testing Library: query by role, label or text (`getByRole` first); avoid test ids unless nothing else fits.
- Interact with `user-event`, assert on visible outcomes.
- Mock the network at the boundary (e.g. MSW), not internal hooks or components.
- No snapshot-only tests. A snapshot may complement explicit assertions, never replace them.

## Anti-patterns

- State that mirrors props; effects chained to update state from other state.
- Index keys on dynamic lists; components defined inside other components.
- Disabling `react-hooks` or `jsx-a11y` lint rules.
- Global mutable stores for local UI state.
