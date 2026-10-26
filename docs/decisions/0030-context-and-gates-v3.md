# ADR-0030: Config v3 — project context, specialists and conditional gates

**Context.** The factory's language standards were strong, but the workspaces it targets keep
their real rules in project files: `docs/security.md`, `docs/go.md`, per-repo `AGENTS.md`, and
`.opencode/skills`. Their DoD also contains checks the five base gates cannot express:
generated bindings, CRD manifests, iOS compilation, docs builds and E2E. Replacing those
setups without losing their context would make the factory less accurate than the hand-written
coordinators it replaces.

**Decision.**
- **Config v3.** `instructions`, `skills`, `mcp`, `agents`, `routing`, `gates.extra`,
  `commits`, `workflow` and `release` are first-class. The old flat model fields remain
  required, so a v2 config keeps working; `update` migrates the version and every new field
  has a default.
- **Context before tools.** `instructions` are rendered into `.opencode/opencode.jsonc` and
  named in the architect/reviewer/tester prompts. `skills.roles` advertises the skills a role
  loads first and enables the skill tool; `mcp.roles` allows named MCP action patterns. This
  is deliberately config-driven: the factory does not try to infer a project's bars.
- **Replace, but keep a way back.** On the first install the factory archives replaced agents,
  commands and skills under `.factory/legacy/<timestamp>/`; OpenSpec's generated files stay.
  `init --plan` shows the same decisions without writing.
- **Generated gates.** `gates.extra` carries conditional, environment-aware and generated
  gates. An `outputs` gate runs a generator, restores the worktree, and fails when an output
  changed. Generated/CRD/IPC contracts use the same idea at change level.
- **Custom agents are opt-in.** A custom agent declares its phase, prompt, model, skills, edit
  globs, shell allow rules, web/MCP access and task routing. The normal scope audit and
  protected paths still apply.
- **Workflow.** `refine` / `run --interactive` are CLI-mediated Q&A before intake; `quick` is
  a branch + gates + review + one commit without a spec. The one hard gate for a normal change
  remains spec approval.
- **Commit style.** `commits.style` can add Gitmoji while keeping the Conventional prefix, so
  release-please still parses it.

**Consequences.**
- **Detection.** Existing `opencode.json` instructions and generated artifacts are proposed
  in the first config. Tauri gets an iOS compile gate and Bun/Tauri bindings + route-tree
  drift gates; kubebuilder gets a CRD generation gate; a `test:e2e`/`e2e` package script
  becomes a full-suite E2E gate; Taskfile `docs`/`kustomize`/`chart`/`verify` tasks become
  full-suite gates. The user still confirms them.
- **Safety.** Skills, web and MCP are opt-in allow rules. Untrusted content, secret paths,
  protected paths and the check-only guard are unchanged. A generated gate is the only
  intentional write path, and it restores the worktree before reporting drift.
- **Compatibility.** v2 configs remain readable; v1 requires `update`. Existing custom agents
  are archived on first install, not silently deleted.
- **Cost.** Extra gates can be expensive (E2E, a full build). They are opt-in and can be
  restricted with `phases: ["full"]` and `when.changed`.
