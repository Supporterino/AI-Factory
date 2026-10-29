import type { Detection } from "../detect/workspace.ts";
import { toRepoConfig } from "../detect/workspace.ts";
import { PONYTAIL } from "../versions.ts";
import { CONFIG_SCHEMA_VERSION, DEFAULT_GRAPH_EXCLUDE } from "./schema.ts";

/** Default model per role: strong models plan and review, fast ones do the volume (§11). */
export const DEFAULT_MODELS = {
  orchestrator: "anthropic/claude-sonnet-5-5",
  architect: "anthropic/claude-opus-5-5",
  reviewer: "anthropic/claude-opus-5-5",
  implementer: "anthropic/claude-sonnet-5-5",
  tester: "anthropic/claude-sonnet-5-5",
  explorer: "anthropic/claude-haiku-5-5",
} as const;

const json = (value: unknown): string => JSON.stringify(value);

/** Gates the detector can propose from the stack, without guessing an app's own scripts. */
function suggestedExtraGates(detection: Detection): unknown[] {
  const out: unknown[] = [];
  for (const repo of detection.repos) {
    if (repo.languages.includes("tauri")) {
      out.push({
        name: "ios-compile",
        type: "types",
        phases: ["task", "full"],
        when: { changed: ["src-tauri/**"] },
        command: "cargo check --manifest-path src-tauri/Cargo.toml --target aarch64-apple-ios",
      });
    }
  }
  for (const suite of detection.e2e) {
    out.push({
      name: `e2e-${suite.repo}`,
      type: "test",
      phases: ["full"],
      command: suite.command,
    });
  }
  const wholeRepo = new Set(["docs", "kustomize", "chart", "verify"]);
  for (const repo of detection.tasks) {
    for (const name of repo.names) {
      if (!wholeRepo.has(name)) continue;
      out.push({
        name: `${name}-${repo.repo}`,
        type: "test",
        phases: ["full"],
        command: `task ${name}`,
      });
    }
  }
  for (const contract of detection.contracts) {
    if (contract.command === undefined) continue;
    if (contract.kind === "ipc") {
      out.push({
        name: "generated-bindings",
        type: "test",
        phases: ["task", "full"],
        when: { changed: ["src-tauri/**", "src/**"] },
        command: contract.command,
        outputs: contract.outputs ?? [contract.path],
      });
    } else if (contract.kind === "crd") {
      out.push({
        name: "generated-crd",
        type: "test",
        phases: ["full"],
        command: contract.command,
        outputs: contract.outputs ?? [contract.path],
      });
    } else if (contract.kind === "generated") {
      out.push({
        name: "generated-artifacts",
        type: "test",
        phases: ["full"],
        command: contract.command,
        outputs: contract.outputs ?? [contract.path],
      });
    }
  }
  return out;
}

/**
 * The first `factory.config.jsonc`, written by `init` from detection. Comments explain each
 * section; later edits go through comment-preserving JSONC edits.
 */
export function renderInitialConfig(detection: Detection): string {
  const repos = detection.repos.map((r) => `    ${json(toRepoConfig(r))}`).join(",\n");
  const contracts = detection.contracts.map((c) => `    ${json(c)}`).join(",\n");
  const models = Object.entries(DEFAULT_MODELS)
    .map(([role, model]) => `    ${json(role)}: ${json(model)}`)
    .join(",\n");
  return `// ai-factory workspace config. Validated on every command; see README "Config reference".
// Detection only proposes values: edit freely, and use \`ai-factory detect\` to see drift.
{
  "$schema": "./.opencode/schemas/factory.config.schema.json",
  "schemaVersion": ${CONFIG_SCHEMA_VERSION},
  "layout": ${json(detection.layout)},

  // Repos are matched by path. "languages" selects the stacked standards per implementer.
  "repos": [
${repos}
  ],

  // opencode model ids ("provider/model") per role. contractReviewer defaults to reviewer.
  // "roles", "repos" and "agents" can override these; the flat entries stay the fallback.
  "models": {
${models}
  },

  // Project bars injected into every session. Add docs/security.md, docs/go.md, etc.
  "instructions": ${json(detection.instructions)},
  // Skills the agents should load first, from .opencode/skills or a custom source.
  "skills": { "sources": [".opencode/skills"], "roles": {}, "repos": {} },
  // MCP tool action patterns per role (e.g. "reviewer": ["mantine_*"]).
  "mcp": { "roles": {} },
  // Optional specialist agents and task routing by touched paths.
  "agents": [],
  "routing": [],

  "gates": {
    "maxRetries": 3,
    // Gate type -> script/target name looked up in package.json, Makefile, justfile, Taskfile.
    "scripts": { "format": "format:check", "lint": "lint", "types": "typecheck", "test": "test", "testAffected": "test:affected" },
    // Repo name -> gate type -> literal command; wins over scripts and profile defaults.
    "overrides": {},
    // Detected stack gates: iOS compile and generated-artifact drift. Edit or remove freely.
    "extra": ${json(suggestedExtraGates(detection))}
  },

  // Proposed by detection: confirm providers and consumers.
  "contracts": [
${contracts}
  ],

  "parallel": { "maxAgents": 4, "maxGateProcesses": 2, "withinRepo": "worktrees" },
  // Per agent turn wall-clock limit in minutes; a timed-out turn is retried.
  "runtime": { "turnTimeoutMinutes": 60 },
  "tokens": { "mode": "report", "contextPackMaxTokens": 8000, "gateOutputMaxLines": 80 },
  "addons": {
    "ponytail": {
      "enabled": true,
      "ref": ${json(`${PONYTAIL.tag}@${PONYTAIL.commit}`)},
      "roles": ["implementer", "reviewer"],
      "level": "full",
      "shortcutComments": "report"
    }
  },
  "logs": { "retentionDays": 14, "redact": true },
  // Per-change records. "local" keeps them in .factory/; "git" commits them under
  // factory-records/ so reports, approvals and usage survive a machine switch.
  "artifacts": { "mode": "local", "reports": true, "approvals": true, "usage": true },
  "graph": { "exclude": ${json(DEFAULT_GRAPH_EXCLUDE)} },
  // Agent shells and gates run in an OS sandbox where available ("auto"; macOS sandbox-exec).
  "security": { "sandbox": "auto" },
  // Web search provider for agents ("random" reuses an available provider) or false to disable it.
  "websearch": { "provider": "random" },
  // Task commits: "conventional" or "gitmoji"; scopes prefixes the repo name.
  "commits": { "style": "conventional", "scopes": false },
  // Agent-raised clarification during design and the no-spec quick task.
  "workflow": { "refine": true, "clarifyRounds": 2, "quick": { "enabled": true, "branchPrefix": "task/" } },
  // Detect release-please, goreleaser, changesets and forge CI (read-only).
  "release": { "detect": true },

  // Managed files the factory must never overwrite (workspace-relative paths).
  "unmanaged": []
}
`;
}
