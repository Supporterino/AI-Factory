# OpenSpec 1.10.0 findings (research agent, 2026-10-23)
Sources: local --help 1.10.0; /opt/homebrew/lib/node_modules/@fission-ai/openspec dist/core/{project-config,profiles,legacy-cleanup,archive,id,config}.js, dist/core/validation/*, dist/core/artifact-graph/types.js, dist/utils/{interactive,task-progress}.js, dist/telemetry/*, schemas/spec-driven/schema.yaml; https://github.com/Fission-AI/OpenSpec/tree/v1.10.0 docs/cli.md (update ~L163-215, Exit codes L1272, Env L1283-1293), docs/supported-tools.md L96,L217, docs/installation.md L166-173, README Telemetry.

## Commands
--json: list (--specs --changes --sort recent|name); show (--type change|spec --deltas-only --requirements --no-scenarios -r <n> --no-interactive); validate (--all --changes --specs --archived --type --strict --concurrency --no-interactive); archive (-y/--yes --skip-specs --no-validate); status --change <id> [--schema]; instructions [artifact] --change <id> [--schema] (artifact = schema artifact id | apply | archive); new change <id> (--description --goal --schema); templates; schemas; schema which|validate|fork|init (experimental); doctor; context; config list. Most take --store.
No --json: init [path] (--tools all|none|csv --language --force --profile core|custom --no-animation --[no-]copilot-cloud); update [path] --force; view (interactive).
Deprecated: change show|list|validate. No `propose` CLI command (only generated skill/slash cmd).
Non-interactive: --no-interactive, OPEN_SPEC_INTERACTIVE=0, CI env, or non-TTY stdin (prompt fails with "rerun with --yes", no hang). JSON→stdout, spinners→stderr.
Exit codes: 0 ok, 1 any error (incl. validation failure, unknown option). Quirk: `status --json` without --change → error payload but exit 0 → check status[].severity.

## init (opencode)
`openspec init --tools opencode --no-animation . </dev/null` creates: .opencode/commands/opsx-{apply,archive,explore,propose,sync,update}.md; .opencode/skills/openspec-{apply-change,archive-change,explore,propose,sync-specs,update-change}/SKILL.md (frontmatter metadata.generatedBy "1.10.0"); openspec/config.yaml; openspec/specs/, openspec/changes/, openspec/changes/archive/.
Output depends on GLOBAL config (~/.config/openspec: profile/workflows/delivery). User's real config is `custom` with 5 workflows (no update) → differs per machine. --profile core overrides workflows not delivery. Pin XDG_CONFIG_HOME for reproducibility. When no global config: writes one ("profile migration").
Does NOT write AGENTS.md; DOES strip `<!-- OPENSPEC:START -->…<!-- OPENSPEC:END -->` blocks from root AGENTS.md/CLAUDE.md etc. even without --force → factory must never use those markers.
Second run byte-identical; existing config.yaml kept.

## config.yaml
keys: schema (required), context (string ≤50KB else ignored w/ warning — from source, untested), rules: {<artifactId>: string[]}, operations.{apply,archive}.guidance: string[], references, store, githubCopilot. .yml accepted. `instructions <artifact> --json` returns context for every artifact, rules only for that artifact (absent if none). Text mode wraps in <project_context>/<rules>.

## Layout
openspec/changes/<id>/{.openspec.yaml (schema, created, opt goal, skip_specs, retire_capabilities), proposal.md, design.md, tasks.md, specs/<cap-path>/spec.md}; README.md only with --description.
id regex ^[a-z0-9]+(?:-[a-z0-9]+)*$. Archive: openspec/changes/archive/YYYY-MM-DD-<id>/.
Proposal headings: ## Why, ## What Changes, ## Capabilities (### New Capabilities / ### Modified Capabilities), ## Impact.
Delta: ## ADDED|MODIFIED|REMOVED|RENAMED Requirements; ### Requirement: must contain SHALL/MUST (warning; error under --strict); #### Scenario: with - **WHEN** / - **THEN**, ≥1 per requirement (error). New caps should start ## Purpose ≥50 chars. ≥1 delta unless skip_specs: true. >10 deltas → "consider splitting".
tasks.md: ## N. Group, - [ ] N.M desc. id mismatch/dup → warnings (spec-driven only).
validate does NOT check proposal.md at all (deleted proposal passed) → factory must check itself.

## validate JSON
{items:[{id,type,valid,issues:[{level:ERROR|WARNING|INFO,path,line?,message}],durationMs}],summary:{totals:{items,passed,failed},byType:{...}},version:"1.0",root:{path,source}}
valid → 0; invalid → 1 (e.g. 'ADDED "Foo thing" must include at least one scenario'); warnings only → 0, but --strict → valid:false exit 1; unknown item → 1 status[{code:"unknown_item"}]; --archived errors "3 incomplete tasks (0/3 completed)".

## archive
`openspec archive <id> --yes --json`. Without --yes → exit 1 archive_tasks_incomplete / archive_confirmation_required.
success {archive:{change,archivedAs:"2026-10-23-<id>",path,specsUpdated:true,totals:{added,modified,removed,renamed}},root}; merges deltas into openspec/specs/<cap>/spec.md (new cap → "# <cap> Specification / ## Purpose / ## Requirements"); MODIFIED replaced in place.
--yes ALSO skips incomplete-tasks check → factory enforces completion. Invalid → archive_validation_failed (1); --no-validate archives anyway. --skip-specs → specsUpdated:false.

## Schemas / status / instructions
spec-driven graph: proposal → (specs, design) → tasks; apply requires tasks, tracks tasks.md. Schema YAML: name, version(int), description, artifacts[{id,generates,description,template,instruction?,requires[]}], apply{requires[],tracks,instruction}. Resolution: openspec/schemas/<name> → $XDG_DATA_HOME/openspec/schemas → package. Custom schema spike (fork spec-driven factory-flow + workplan.yaml) worked with validate/status/instructions. Schema commands experimental.
status --json: changeName, schemaName, planningHome, changeRoot, artifactPaths, isPlanningComplete, isComplete, applyRequires, nextSteps, actionContext, artifacts[{id,outputPath,status:done|ready|blocked,requires,missingDeps?}], root. isComplete ignores checkboxes.
instructions apply --json: tasks[{id:"1" sequential, description:"1.1 …", done}], progress{total,complete,remaining}, contextFiles, context.
list --json: {changes:[{name,completedTasks,totalTasks,lastModified,status}]}.
Per-task metadata: indented non-checkbox lines `  - repo: x`, `  - deps: 1.1`, `  - touches: a.ts`, and HTML comments pass normal + --strict and aren't counted. NEVER `[ ]` in metadata (any checkbox line counts as task, even indented/in fences/comments). Factory parses tasks.md itself.

## update / telemetry
`openspec update [path]` regenerates for configured tools using current global profile; --force rewrites; runs legacy cleanup; checks npm registry (disable: OPENSPEC_NO_UPDATE_CHECK, CI, OPENSPEC_TELEMETRY=0, DO_NOT_TRACK=1). Upgrade docs: npm i -g @fission-ai/openspec@latest then `openspec update` per project.
Telemetry: anon PostHog (cmd + version) to edge.openspec.dev. Off: OPENSPEC_TELEMETRY=0 | DO_NOT_TRACK=1 | CI | `openspec config set telemetry.enabled false`.
Child env for factory: OPENSPEC_TELEMETRY=0 DO_NOT_TRACK=1 OPENSPEC_NO_UPDATE_CHECK=1 OPENSPEC_NO_COMPLETIONS=1 OPENSPEC_NO_ANIMATION=1 OPEN_SPEC_INTERACTIVE=0 NO_COLOR=1 (+ pinned XDG_CONFIG_HOME).

## Gaps
REMOVED/RENAMED merges, same-day double archive, nested specs/<area>/<cap> archive, --language, stores/workset/context/doctor/view, 50KB limit untested, cross-version upgrade, other --json commands' exit-on-soft-error, schema format experimental.
