# ADR-0023: Doctor checks and the manual E2E method

**Context.** §5 lists what `doctor` checks, and §13 asks for one manual E2E run per layout with real opencode, with transcripts in `docs/e2e/`. Runs with a real model cost money, and their output varies from run to run.

**Decision.**
- **Doctor is read-only** and exits 4 when a check fails. Warnings (stale graph, dirty tree, out-of-date managed files, an uninitialised submodule, a stale active lock) exit 0. The only write is the optional `git submodule update --init`, which it asks for in a terminal.
- **Tool drift.** Each tool is checked three ways: the installed version against the lock's range, the lock's tested pin against this factory's pin, and the lock's factory version against this one. If the lock is newer than the running factory, that is a failure.
- **Gate toolchains.** The resolved commands are parsed with the blocklist's shell parser to find the programs they run. Keywords, builtins, variables and placeholders are skipped. Each program is looked up on `PATH` and in the target's tool dirs. For script gates (`npm run lint`), only the runner is checked.
- **Models.**
  - `opencode models --standalone` runs with the same curated env as the pipeline's server, so a model counts as available only if its provider's credentials would reach the server.
  - It uses a throwaway `OPENCODE_DB`. On a fresh install, `.factory/opencode/` does not exist yet and the standalone server failed to start (found in the E2E run).
- **Graph freshness.** Graphify keeps `built_at_commit` when nothing it indexes changed. So the graph is stale only if code changed between that commit and `HEAD`: source files of any profile, or moved submodule pointers. Factory install paths and `openspec/` don't count.
- **Guard plugin.** An edited or deleted `.opencode/plugins/factory.js` is a failure, not a "kept edit" (ADR-0018).
- **E2E method.**
  - `scripts/e2e-transcript.ts single|submodules` runs the real opencode server with the factory's agents, permissions and plugin, real git, OpenSpec and Graphify, and the real gate toolchains.
  - The model is `test/fixtures/stub-team.ts`: an Anthropic-compatible stub that answers per role. It uses opencode's real `write` and `shell` tools and ends each session with a handoff.
  - opencode gets an isolated HOME whose only provider is the stub.
  - Transcripts are regenerated, not hand-edited.
  - A run with real models is the same flow on a real workspace (README "The flow"). It is not recorded here because it costs money, and its output is not reproducible.

**Consequences.**
- The E2E runs cover opencode's own permission layer, which the scripted runtime in the test suite bypasses. The first run found two bugs: the architect and tester had no edit permission, and doctor's model check failed on fresh installs. Both are fixed, with unit tests.
- The transcripts don't measure model quality. `bench ponytail` and real use cover that.
