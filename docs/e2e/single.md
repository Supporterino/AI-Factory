# E2E: single repo

Recorded 2026-10-26 with `bun scripts/e2e-transcript.ts single` (ai-factory 0.2.0).

**Real:**
- the opencode server: opencode v2.1.2 with the factory's agents, permissions and guard plugin;
- git; OpenSpec 1.14.3; graphify 0.9.93;
- the gate toolchains named in the config below.

**Scripted:** the model. `test/fixtures/stub-team.ts` answers opencode's Messages API calls per role. It writes files with opencode's `write` tool, tries a forbidden `git push` to show the guard, and ends each session with a handoff. Token counts in `status` come from the stub's fixed usage numbers.

Temp paths are shown as `<tmp>`.

The workspace is a single TypeScript repo (`app`: `src/sum.ts` and a `bun test`). The change adds two helpers in parallel tasks, then a third task that depends on both.

## Install

```console
$ ai-factory init
ai-factory 0.2.0 in /private<tmp>/app
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
created: .opencode/agents/implementer-app.md
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
hook app: installed
graph: built (575 nodes, 6.7s)
committed 31ceccea38c8 chore(factory): init v0.2.0
# exit 0 · 7.9s
```

Config edits for the run: every role uses the stub model. The fixture has no installed formatter, linter or `tsc`, so those gates are `skip`; tests run for real with `bun test` (the repo's `test` script for the full suite, the test files related to each task's changes per task).

```console
$ git diff HEAD~1 -- factory.config.jsonc
diff --git a/factory.config.jsonc b/factory.config.jsonc
index 4a861bc..ce59361 100644
--- a/factory.config.jsonc
+++ b/factory.config.jsonc
@@ -12,12 +12,12 @@
 
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
@@ -25,7 +25,14 @@
     // Gate type -> script/target name looked up in package.json, Makefile, justfile, Taskfile.
     "scripts": { "format": "format:check", "lint": "lint", "types": "typecheck", "test": "test", "testAffected": "test:affected" },
     // Repo name -> gate type -> literal command; wins over scripts and profile defaults.
-    "overrides": {}
+    "overrides": {
+      "app": {
+        "format": "skip",
+        "lint": "skip",
+        "types": "skip",
+        "testAffected": "bun test {testFiles}"
+      }
+    }
   },
 
   // Proposed by detection: confirm providers and consumers.
```

Changed models re-render the agents, so `update` brings the managed files in line with the config:

```console
$ ai-factory update
update 0.2.0 → 0.2.0
config migrations: none
  update: .opencode/agents/architect.md
  update: .opencode/agents/contract-reviewer.md
  update: .opencode/agents/explorer.md
  update: .opencode/agents/implementer-app.md
  update: .opencode/agents/orchestrator.md
  update: .opencode/agents/reviewer.md
  update: .opencode/agents/tester.md
committed 281c0748d01f chore(factory): update to v0.2.0
backup: /private<tmp>/app/.factory/backups/2026-10-26T10-03-18-486Z
# exit 0 · 0.9s
```

```console
$ ai-factory graph
graph updated: 575 nodes, 724 links in 2.0s
# exit 0 · 2.1s
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
  ✓ config: schemaVersion 2, layout single
security
  ✓ sandbox: agent shells and gates run under macOS sandbox-exec
install
  ✓ managed files: 28 up to date
repos
  ✓ AI repo working tree: clean
  ✓ AI repo pre-push hook: installed
gates
  ✓ app: 1 gate command(s) resolved, toolchain present
caches
  ✓ dependency caches: 0 B
  ✓ backups: 85 KiB
models
  ✓ orchestrator: stub/claude-stub
  ✓ architect: stub/claude-stub
  ✓ reviewer: stub/claude-stub
  ✓ implementer: stub/claude-stub
  ✓ tester: stub/claude-stub
  ✓ explorer: stub/claude-stub
graph
  ✓ graph: 0 min old, no code changes since it was built (575 nodes)
changes
  ✓ active: none
gate table (full mode; per task, scoped commands and affected tests are used)
  app test    npm run --silent test  (script)
  app format  skip: gates.overrides.app.format
  app lint    skip: gates.overrides.app.lint
  app types   skip: gates.overrides.app.types
all checks passed
# exit 0 · 1.0s
```

## Run up to the spec

```console
$ ai-factory run Add a greet(name) helper and a clamp(n, min, max) helper, exported from src/index.ts
▶ intake
  change add-text-helpers
▶ explore: app
▶ design: openspec/changes/add-text-helpers
add-text-helpers: awaiting approval — review openspec/changes/add-text-helpers/ then run `ai-factory approve add-text-helpers`
# exit 0 · 2.8s
```

```console
$ ai-factory status add-text-helpers
change add-text-helpers — awaiting-approval (not active; factory 0.2.0)
  branches: . change/add-text-helpers @281c0748d01f
  usage: 17.3k tokens (1.4k cache read, 294 out) · cost n/a in 3 sessions
    by agent: architect 12.4k, orchestrator 2.5k, explorer 2.5k
    retry overhead: 0 · wasted re-reads: 0
# exit 0 · 0.0s
```

`openspec/changes/add-text-helpers/tasks.md`:

```markdown
## 1. app

- [ ] 1.1 Add the greet helper
  - repo: app
  - deps: none
  - touches: src/greet.ts
- [ ] 1.2 Add the clamp helper
  - repo: app
  - deps: none
  - touches: src/clamp.ts
- [ ] 1.3 Export the helpers from src/index.ts
  - repo: app
  - deps: 1.1, 1.2
  - touches: src/index.ts
```

## Approve: the rest runs on its own

```console
$ ai-factory approve add-text-helpers
✓ approved add-text-helpers by fixture@example.com (spec 841915a3ad1d, 3 tasks)
▶ context packs (3)
▶ implement: 3 tasks (max 4 agents)
  ✓ 1.2 merged (app)
  ✓ 1.1 merged (app)
  ✓ 1.3 merged (app)
▶ review + tests: app
▶ implement: 1 task (max 4 agents)
  ✓ test-app merged (app)
▶ contracts: none touched
▶ full suite: app
▶ close
✓ add-text-helpers done — report: /private<tmp>/app/.factory/reports/add-text-helpers.md
add-text-helpers: done
# exit 0 · 16.0s
```

```console
$ ai-factory status add-text-helpers
change add-text-helpers — done (not active; factory 0.2.0)
  branches: . change/add-text-helpers @281c0748d01f · app change/add-text-helpers @281c0748d01f
  graph: covers 4 of 4 merges
  tasks: 4/4 merged (merge seq 4)
    ✓ 1.1      app Add the greet helper — merged ab4c6f793c8a · 9.9k tok
    ✓ 1.2      app Add the clamp helper — merged a7fbe4d2ef07 · 5.0k tok
    ✓ 1.3      app Export the helpers from src/index.ts — merged 7cb1923bd1eb · 5.0k tok
    ✓ test-app app Ensure every scenario of app has a test — merged b7c38562fc92 · 7.4k tok
  usage: 56.9k tokens (4.6k cache read, 966 out) · cost n/a in 9 sessions
    by agent: architect 22.3k, implementer-app 19.8k, tester 7.4k, orchestrator 2.5k, explorer 2.5k, reviewer 2.5k
    retry overhead: 0 · wasted re-reads: 0
# exit 0 · 0.0s
```

## Result

```console
$ git log --format='%h %s' main..change/add-text-helpers
4ad7691 chore(spec): archive add-text-helpers
b7c3856 test: ensure every scenario of app has a test
7cb1923 feat: export the helpers from src/index.ts
ab4c6f7 feat: add the greet helper
a7fbe4d feat: add the clamp helper
841915a docs(spec): add-text-helpers
```

```console
$ git branch --list '*change*'
* change/add-text-helpers
```

```console
$ git worktree list
/private<tmp>/app 4ad7691 [change/add-text-helpers]
```

### Gate runs

Each task's gates, as logged (per task in its worktree, then again after the rebase in the merge queue; `full:<repo>` is the full suite at the end):

```text
1.2            format skipped · lint skipped · types skipped · testAffected skipped
1.1            format skipped · lint skipped · types skipped · testAffected skipped
1.2            format skipped · lint skipped · types skipped · testAffected skipped
1.1            format skipped · lint skipped · types skipped · testAffected skipped
1.3            format skipped · lint skipped · types skipped · testAffected skipped
1.3            format skipped · lint skipped · types skipped · testAffected skipped
test-app       format skipped · lint skipped · types skipped · testAffected pass (bun test src/clamp.test.ts src/greet.test.ts)
test-app       format skipped · lint skipped · types skipped · testAffected pass (bun test src/clamp.test.ts src/greet.test.ts)
full:app       format skipped · lint skipped · types skipped · test pass (npm run --silent test)
```

### Guard log

Every tool call the agents made is logged (redacted). These are the calls the plugin blocked:

```json
{"at":"2026-10-26T10:03:27.132Z","kind":"blocked","session":"ses_e8855c6dcffeKSTyuDZuebpys8","agent":"implementer-app","tool":"shell","input":{"command":"git push origin HEAD"},"reason":"ai-factory blocked this call: git push is not allowed: the factory never pushes"}
{"at":"2026-10-26T10:03:27.210Z","kind":"blocked","session":"ses_e8855c6dcffeKSTyuDZuebpys8","agent":"implementer-app","tool":"shell","input":{"command":"sh -c 'git push --force origin main'"},"reason":"ai-factory blocked this call: git push is not allowed: the factory never pushes"}
```

### Final report

```markdown
# add-text-helpers: done

Add greet and clamp helpers, exported from the package entry point

## Branches (local only; nothing was pushed)

- app: `change/add-text-helpers` at 4ad769114757 (6 commits)
- AI repo: `change/add-text-helpers` (archive commit 4ad769114757)

## Tasks

- [x] 1.1 (app, task): Add the greet helper
- [x] 1.2 (app, task): Add the clamp helper
- [x] 1.3 (app, task): Export the helpers from src/index.ts
- [x] test-app (app, test): Ensure every scenario of app has a test

## Spec

Archived as `openspec/changes/archive/2026-10-26-add-text-helpers`.

## Review findings

- review:app: [nice] src/clamp.ts:1 With min > max the result is always max, which hides a caller bug.

## Usage

Total: 56.9k tokens (4.6k cache read, 966 out) · cost n/a over 9 sessions.

| Agent           | Tokens | Share | Cost     |
| --------------- | ------ | ----- | -------- |
| architect       | 22.3k  | 39%   | cost n/a |
| implementer-app | 19.8k  | 35%   | cost n/a |
| tester          | 7.4k   | 13%   | cost n/a |
| orchestrator    | 2.5k   | 4%    | cost n/a |
| explorer        | 2.5k   | 4%    | cost n/a |
| reviewer        | 2.5k   | 4%    | cost n/a |

Top consumers: design (12.4k), context-packs (9.9k), 1.1 (9.9k), test-app (7.4k), 1.2 (5.0k).
Retry overhead: 0 tokens (0%).
Wasted re-reads of unchanged files: 0.
```

Total wall time: 32s. Model requests served by the stub: 23.
