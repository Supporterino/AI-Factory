# ADR-0013: CLI runtime target and detection rules

**Context.** The CLI must run via `bunx` and `npx`. Detection only proposes values, and the user confirms them in the config.

**Decision.**
- **Runtime.** The source uses Node APIs only (`node:child_process`, `node:fs`, `node:util.parseArgs`). `bun build --target=node` bundles it into `dist/cli.js`, the package `bin`. Bun is used for tests and builds.
  - `jsonc-parser` is imported from its ESM build, because the UMD build breaks bundling.
- **Language ids.** `typescript` is the TS/JS profile: `package.json` alone maps to it, and a `tsconfig.json` is not required.
- **Sub-paths.**
  - Every directory with a marker is a candidate.
  - A sub-path is recorded only when its languages differ from its nearest recorded ancestor, or from the root.
  - Kubernetes manifests are grouped by their top-level directory.
  - Chart `templates/` are never parsed as manifests.
- **Repo identity.** Repos are matched by **path**, not name, so renaming a repo in the config is not drift. Contracts are matched by `kind + provider + path`.
- **Contract consumers** are heuristics for the user to confirm:
  - OpenAPI and JSON Schema: another repo mentions the provider-relative spec path.
  - Proto: another repo mentions one of the proto packages.
  - Helm values: the chart's `values.yaml` mentions a repo name.
  - Test, testdata, fixture and example directories are never proposed as contracts.
- **Uninitialised submodules** keep their config values. Detection reports a note with the `git submodule update --init` command and never guesses languages.
- **`detect --apply`** edits only the changed JSONC values, validates the result and writes atomically. Regenerating agents, scopes and hooks after `--apply` hooks in with slice 2.
