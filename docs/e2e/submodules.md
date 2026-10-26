# E2E: AI repo with submodules

Recorded 2026-10-26 with `bun scripts/e2e-transcript.ts submodules` (ai-factory 0.2.0).

**Real:**
- the opencode server: opencode v2.1.2 with the factory's agents, permissions and guard plugin;
- git; OpenSpec 1.14.3; graphify 0.9.93;
- the gate toolchains named in the config below.

**Scripted:** the model. `test/fixtures/stub-team.ts` answers opencode's Messages API calls per role. It writes files with opencode's `write` tool, tries a forbidden `git push` to show the guard, and ends each session with a handoff. Token counts in `status` come from the stub's fixed usage numbers.

Temp paths are shown as `<tmp>`.

The workspace is an AI repo with three submodules: `backend` (Go, provides `api/openapi.yaml`), `frontend` (React, consumes it) and `deploy` (Helm). The change adds `GET /version` and `GET /ready` to the backend and shows the version in the frontend: two backend tasks and one frontend task start in parallel, a third backend task waits for both.

## Install

```console
$ ai-factory init
ai-factory 0.2.0 in /private<tmp>/ai
tools: git 2.54.0, opencode 2.1.2, openspec 1.14.3, graphify 0.9.93
wrote factory.config.jsonc (review "models" and "contracts")
created: .gitignore
created: .graphifyignore
created: .opencode/addons/ponytail/.opencode/command/ponytail-review.md
created: .opencode/addons/ponytail/AGENTS.md
created: .opencode/addons/ponytail/LICENSE
created: .opencode/addons/ponytail/PRECEDENCE.md
created: .opencode/addons/ponytail/skills/ponytail-review/SKILL.md
created: .opencode/addons/ponytail/skills/ponytail/SKILL.md
created: .opencode/agents/architect.md
created: .opencode/agents/contract-reviewer.md
created: .opencode/agents/explorer.md
created: .opencode/agents/implementer-backend.md
created: .opencode/agents/implementer-deploy.md
created: .opencode/agents/implementer-frontend.md
created: .opencode/agents/orchestrator.md
created: .opencode/agents/reviewer.md
created: .opencode/agents/tester.md
created: .opencode/opencode.jsonc
created: .opencode/plugins/factory.js
created: .opencode/schemas/factory.config.schema.json
created: .opencode/schemas/handoff.schema.json
created: .opencode/standards/go.md
created: .opencode/standards/helm.md
created: .opencode/standards/python.md
created: .opencode/standards/react.md
created: .opencode/standards/rust.md
created: .opencode/standards/tauri.md
created: .opencode/standards/typescript.md
created: AGENTS.md
created: openspec/config.yaml
hook ai: installed
hook backend: installed
hook deploy: installed
hook frontend: installed
graph: built (667 nodes, 3.9s)
committed efba3dbf009d chore(factory): init v0.2.0
# exit 0 · 5.4s
```

Config edits for the run: every role uses the stub model, and the detected OpenAPI contract is confirmed with `frontend` as its consumer. The backend gates are the Go profile's (`gofmt`, `go vet`, `go test -race`); `golangci-lint` is not installed here, so lint runs `go vet`. The frontend fixture has no `node_modules`, so its gates are `skip`. `deploy` keeps `helm lint` and checks rendering with `helm template`.

```console
$ git diff HEAD~1 -- factory.config.jsonc
diff --git a/factory.config.jsonc b/factory.config.jsonc
index 46ff664..c10eccd 100644
--- a/factory.config.jsonc
+++ b/factory.config.jsonc
@@ -15,12 +15,12 @@
 
   // opencode model ids ("provider/model") per role. contractReviewer defaults to reviewer.
   "models": {
-    "orchestrator": "anthropic/claude-sonnet-5-5",
-    "architect": "anthropic/claude-opus-5-5",
-    "reviewer": "anthropic/claude-opus-5-5",
-    "implementer": "anthropic/claude-sonnet-5-5",
-    "tester": "anthropic/claude-sonnet-5-5",
-    "explorer": "anthropic/claude-haiku-5-5"
+    "orchestrator": "stub/claude-stub",
+    "architect": "stub/claude-stub",
+    "reviewer": "stub/claude-stub",
+    "implementer": "stub/claude-stub",
+    "tester": "stub/claude-stub",
+    "explorer": "stub/claude-stub"
   },
 
   "gates": {
@@ -28,13 +28,36 @@
     // Gate type -> script/target name looked up in package.json, Makefile, justfile, Taskfile.
     "scripts": { "format": "format:check", "lint": "lint", "types": "typecheck", "test": "test", "testAffected": "test:affected" },
     // Repo name -> gate type -> literal command; wins over scripts and profile defaults.
-    "overrides": {}
+    "overrides": {
+      "backend": {
+        "lint": "go vet ./..."
+      },
+      "frontend": {
+        "format": "skip",
+        "lint": "skip",
+        "types": "skip",
+        "test": "skip",
+        "testAffected": "skip"
+      },
+      "deploy": {
+        "format": "skip",
+        "types": "helm template charts/app > /dev/null",
+        "test": "skip",
+        "testAffected": "skip"
+      }
+    }
   },
 
   // Proposed by detection: confirm providers and consumers.
   "contracts": [
-    {"kind":"helm-values","provider":"deploy","path":"charts/app/values.schema.json","consumers":["backend"]},
-    {"kind":"openapi","provider":"backend","path":"api/openapi.yaml","consumers":["frontend"]}
+    {
+      "kind": "openapi",
+      "provider": "backend",
+      "path": "api/openapi.yaml",
+      "consumers": [
+        "frontend"
+      ]
+    }
   ],
 
   "parallel": { "maxAgents": 4, "maxGateProcesses": 2, "withinRepo": "worktrees" },
```

Changed models re-render the agents, so `update` brings the managed files in line with the config:

```console
$ ai-factory update
update 0.2.0 → 0.2.0
config migrations: none
  update: .opencode/agents/architect.md
  update: .opencode/agents/contract-reviewer.md
  update: .opencode/agents/explorer.md
  update: .opencode/agents/implementer-backend.md
  update: .opencode/agents/implementer-deploy.md
  update: .opencode/agents/implementer-frontend.md
  update: .opencode/agents/orchestrator.md
  update: .opencode/agents/reviewer.md
  update: .opencode/agents/tester.md
  update: openspec/config.yaml
detection differs from the config (not applied; see `ai-factory detect`):
  + contract helm-values deploy:charts/app/values.schema.json → consumers [backend]
committed 7cfac579fa5b chore(factory): update to v0.2.0
backup: /private<tmp>/ai/.factory/backups/2026-10-26T10-03-53-309Z
# exit 0 · 1.1s
```

```console
$ ai-factory graph
graph updated: 667 nodes, 815 links in 2.0s
# exit 0 · 2.2s
```

```console
$ ai-factory doctor
tools
  ✓ git: 2.54.0 (lock >= 2.31.0, tested 2.54.0)
  ✓ opencode: 2.1.2 (lock >= 2.1.2 < 2.2.0, tested 2.1.2)
  ✓ openspec: 1.14.3 (lock >= 1.10.0 < 2.0.0, tested 1.14.3)
  ✓ graphify: 0.9.93 (lock >= 0.9.93 < 0.10.0, tested 0.9.93)
  ✓ factory: 0.2.0
install
  ✓ config: schemaVersion 2, layout submodules
security
  ✓ sandbox: agent shells and gates run under macOS sandbox-exec
install
  ✓ managed files: 30 up to date
repos
  ✓ AI repo working tree: clean
  ✓ AI repo pre-push hook: installed
  ✓ backend working tree: clean
  ✓ backend pre-push hook: installed
  ✓ deploy working tree: clean
  ✓ deploy pre-push hook: installed
  ✓ frontend working tree: clean
  ✓ frontend pre-push hook: installed
gates
  ✓ backend: 4 gate command(s) resolved, toolchain present
  ✓ deploy: 2 gate command(s) resolved, toolchain present
  ✓ frontend: 0 gate command(s) resolved, toolchain present
caches
  ✓ dependency caches: 0 B
  ✓ backups: 140 KiB
models
  ✓ orchestrator: stub/claude-stub
  ✓ architect: stub/claude-stub
  ✓ reviewer: stub/claude-stub
  ✓ implementer: stub/claude-stub
  ✓ tester: stub/claude-stub
  ✓ explorer: stub/claude-stub
graph
  ✓ graph: 0 min old, no code changes since it was built (667 nodes)
changes
  ✓ active: none
gate table (full mode; per task, scoped commands and affected tests are used)
  backend format   out="$(gofmt -l .)"; [ -z "$out" ] || { echo "needs gofmt:"; echo "$out"; exit 1; }  (profile)
  backend lint     go vet ./...  (override)
  backend types    go vet ./...  (profile)
  backend test     go test -race ./...  (profile)
  deploy lint      helm lint charts/app  (profile)
  deploy types     helm template charts/app > /dev/null  (override)
  deploy format    skip: gates.overrides.deploy.format
  deploy test      skip: gates.overrides.deploy.test
  frontend format  skip: gates.overrides.frontend.format
  frontend lint    skip: gates.overrides.frontend.lint
  frontend types   skip: gates.overrides.frontend.types
  frontend test    skip: gates.overrides.frontend.test
all checks passed
# exit 0 · 1.2s
```

## Run up to the spec

```console
$ ai-factory run Add GET /version (with the OpenAPI contract) and GET /ready to the backend, and show the backend version in the frontend
▶ intake
  change add-version-endpoint
▶ explore: backend, frontend
▶ design: openspec/changes/add-version-endpoint
add-version-endpoint: awaiting approval — review openspec/changes/add-version-endpoint/ then run `ai-factory approve add-version-endpoint`
# exit 0 · 4.1s
```

```console
$ ai-factory status add-version-endpoint
change add-version-endpoint — awaiting-approval (not active; factory 0.2.0)
  branches: . change/add-version-endpoint @7cfac579fa5b
  usage: 19.8k tokens (1.6k cache read, 336 out) · cost n/a in 4 sessions
    by agent: architect 12.4k, explorer 5.0k, orchestrator 2.5k
    retry overhead: 0 · wasted re-reads: 0
# exit 0 · 0.0s
```

`openspec/changes/add-version-endpoint/tasks.md`:

```markdown
## 1. backend

- [ ] 1.1 Add GET /version to the backend and its OpenAPI contract
  - repo: backend
  - deps: none
  - touches: version.go, main.go, api/openapi.yaml
- [ ] 1.2 Add the readiness handler
  - repo: backend
  - deps: none
  - touches: ready.go
- [ ] 1.3 Register GET /ready
  - repo: backend
  - deps: 1.1, 1.2
  - touches: main.go

## 2. frontend

- [ ] 2.1 Show the backend version in the frontend
  - repo: frontend
  - deps: none
  - touches: src/Version.tsx
```

## Approve: the rest runs on its own

```console
$ ai-factory approve add-version-endpoint
✓ approved add-version-endpoint by fixture@example.com (spec 92d2828dc845, 4 tasks)
▶ context packs (4)
▶ implement: 4 tasks (max 4 agents)
  ✓ 2.1 merged (frontend)
  ✓ 1.2 merged (backend)
  ✓ 1.1 merged (backend)
  ✓ 1.3 merged (backend)
▶ review + tests: backend, frontend
▶ implement: 2 tasks (max 4 agents)
  ✓ test-frontend merged (frontend)
  ✓ test-backend merged (backend)
▶ contract gate: 1 contract
  ✓ openapi:backend:api/openapi.yaml
▶ contract review
▶ full suite: backend, frontend
▶ close
✓ add-version-endpoint done — report: /private<tmp>/ai/.factory/reports/add-version-endpoint.md
add-version-endpoint: done
# exit 0 · 58.9s
```

```console
$ ai-factory status add-version-endpoint
change add-version-endpoint — done (not active; factory 0.2.0)
  branches: . change/add-version-endpoint @7cfac579fa5b · backend change/add-version-endpoint @dcc0e6a2ee97 · frontend change/add-version-endpoint @a9de5531d2a4
  graph: covers 6 of 6 merges
  tasks: 6/6 merged (merge seq 6)
    ✓ 1.1           backend  Add GET /version to the backend and its OpenAPI contract — merged 2516a206256c · 12.4k tok
    ✓ 1.2           backend  Add the readiness handler — merged 9895410c1b66 · 5.0k tok
    ✓ 1.3           backend  Register GET /ready — merged 7f50e5e78c2e · 5.0k tok
    ✓ 2.1           frontend Show the backend version in the frontend — merged 790f7146a39c · 5.0k tok
    ✓ test-frontend frontend Ensure every scenario of frontend has a test — merged 971913d4923b · 5.0k tok
    ✓ test-backend  backend  Ensure every scenario of backend has a test — merged ab6a7f654873 · 5.0k tok
  usage: 76.8k tokens (6.2k cache read, 1.3k out) · cost n/a in 14 sessions
    by agent: architect 24.8k, implementer-backend 22.3k, tester 9.9k, explorer 5.0k, implementer-frontend 5.0k, reviewer 5.0k, orchestrator 2.5k, contract-reviewer 2.5k
    retry overhead: 0 · wasted re-reads: 0
# exit 0 · 0.0s
```

## Result

```console
$ git log --format='%h %s' main..change/add-version-endpoint
f572392 chore(spec): archive add-version-endpoint
fc8e62e chore(submodules): bump for add-version-endpoint [provisional]
92d2828 docs(spec): add-version-endpoint
```

```console
$ git -C repos/backend log --format='%h %s  [%(trailers:key=Task,valueonly,separator=)]' main..change/add-version-endpoint
ab6a7f6 test: ensure every scenario of backend has a test  [test-backend]
7f50e5e feat: register GET /ready  [1.3]
2516a20 feat: add GET /version to the backend and its OpenAPI contract  [1.1]
9895410 feat: add the readiness handler  [1.2]
```

```console
$ git -C repos/frontend log --format='%h %s  [%(trailers:key=Task,valueonly,separator=)]' main..change/add-version-endpoint
971913d test: ensure every scenario of frontend has a test  [test-frontend]
790f714 feat: show the backend version in the frontend  [2.1]
```

```console
$ git show --stat change/add-version-endpoint~1
fc8e62e chore(submodules): bump for add-version-endpoint [provisional]

Change-Id: add-version-endpoint


 repos/backend  | 2 +-
 repos/frontend | 2 +-
 2 files changed, 2 insertions(+), 2 deletions(-)
```

```console
$ git branch --list '*change*'
* change/add-version-endpoint
```

```console
$ git -C repos/backend branch --list '*change*'
* change/add-version-endpoint
```

```console
$ git -C repos/frontend branch --list '*change*'
* change/add-version-endpoint
```

```console
$ git worktree list
/private<tmp>/ai f572392 [change/add-version-endpoint]
```

### Gate runs

Each task's gates, as logged (per task in its worktree, then again after the rebase in the merge queue; `full:<repo>` is the full suite at the end):

```text
2.1            format skipped · lint skipped · types skipped · testAffected skipped
2.1            format skipped · lint skipped · types skipped · testAffected skipped
1.2            format pass (out="$(gofmt -l ready.go)"; [ -z "$out" ] || { echo "need...) · lint pass (go vet ./...) · types pass (go vet .) · testAffected pass (go test -race .)
1.1            format pass (out="$(gofmt -l main.go version.go)"; [ -z "$out" ] || { ...) · lint pass (go vet ./...) · types pass (go vet .) · testAffected pass (go test -race .)
1.2            format pass (out="$(gofmt -l ready.go)"; [ -z "$out" ] || { echo "need...) · lint pass (go vet ./...) · types pass (go vet .) · testAffected pass (go test -race .)
1.1            format pass (out="$(gofmt -l main.go version.go)"; [ -z "$out" ] || { ...) · lint pass (go vet ./...) · types pass (go vet .) · testAffected pass (go test -race .)
1.3            format pass (out="$(gofmt -l main.go)"; [ -z "$out" ] || { echo "needs...) · lint pass (go vet ./...) · types pass (go vet .) · testAffected pass (go test -race .)
1.3            format pass (out="$(gofmt -l main.go)"; [ -z "$out" ] || { echo "needs...) · lint pass (go vet ./...) · types pass (go vet .) · testAffected pass (go test -race .)
test-frontend  format skipped · lint skipped · types skipped · testAffected skipped
test-frontend  format skipped · lint skipped · types skipped · testAffected skipped
test-backend   format pass (out="$(gofmt -l handlers_test.go)"; [ -z "$out" ] || { ec...) · lint pass (go vet ./...) · types pass (go vet .) · testAffected pass (go test -race .)
test-backend   format pass (out="$(gofmt -l handlers_test.go)"; [ -z "$out" ] || { ec...) · lint pass (go vet ./...) · types pass (go vet .) · testAffected pass (go test -race .)
full:frontend  format skipped · lint skipped · types skipped · test skipped
full:backend   format pass (out="$(gofmt -l .)"; [ -z "$out" ] || { echo "needs gofmt...) · lint pass (go vet ./...) · types pass (go vet ./...) · test pass (go test -race ./...)
```

### Guard log

Every tool call the agents made is logged (redacted). These are the calls the plugin blocked:

```json
{
  "at": "2026-10-26T10:04:04.243Z",
  "kind": "blocked",
  "session": "ses_e885535caffdKtSYi2gP076NJP",
  "agent": "implementer-backend",
  "tool": "shell",
  "input": { "command": "git push origin HEAD" },
  "reason": "ai-factory blocked this call: git push is not allowed: the factory never pushes"
}
```

### Final report

```markdown
# add-version-endpoint: done

Add GET /version and GET /ready to the backend; show the version in the frontend

## Branches (local only; nothing was pushed)

- backend: `change/add-version-endpoint` at ab6a7f654873 (4 commits)
- frontend: `change/add-version-endpoint` at 971913d4923b (2 commits)
- AI repo: `change/add-version-endpoint` (archive commit f5723925afaa)

## Tasks

- [x] 1.1 (backend, task): Add GET /version to the backend and its OpenAPI contract
- [x] 1.2 (backend, task): Add the readiness handler
- [x] 1.3 (backend, task): Register GET /ready
- [x] 2.1 (frontend, task): Show the backend version in the frontend
- [x] test-frontend (frontend, test): Ensure every scenario of frontend has a test
- [x] test-backend (backend, test): Ensure every scenario of backend has a test

## Submodule pointers (provisional)

- repos/backend: dcc0e6a2ee97 → ab6a7f654873
- repos/frontend: a9de5531d2a4 → 971913d4923b

Push each `change/add-version-endpoint` branch and open your MRs. After they merge, run `ai-factory repoint add-version-endpoint` to replace these pointers with the merged commits.

## Spec

Archived as `openspec/changes/archive/2026-10-26-add-version-endpoint`.

## Usage

Total: 76.8k tokens (6.2k cache read, 1.3k out) · cost n/a over 14 sessions.

| Agent                | Tokens | Share | Cost     |
| -------------------- | ------ | ----- | -------- |
| architect            | 24.8k  | 32%   | cost n/a |
| implementer-backend  | 22.3k  | 29%   | cost n/a |
| tester               | 9.9k   | 13%   | cost n/a |
| explorer             | 5.0k   | 6%    | cost n/a |
| implementer-frontend | 5.0k   | 6%    | cost n/a |
| reviewer             | 5.0k   | 6%    | cost n/a |
| orchestrator         | 2.5k   | 3%    | cost n/a |
| contract-reviewer    | 2.5k   | 3%    | cost n/a |

Top consumers: design (12.4k), context-packs (12.4k), 1.1 (12.4k), 1.2 (5.0k), 2.1 (5.0k).
Retry overhead: 0 tokens (0%).
Wasted re-reads of unchanged files: 0.
```

Total wall time: 73s. Model requests served by the stub: 31.
