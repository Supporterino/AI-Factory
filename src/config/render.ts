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
  "models": {
${models}
  },

  "gates": {
    "maxRetries": 3,
    // Gate type -> script/target name looked up in package.json, Makefile, justfile, Taskfile.
    "scripts": { "format": "format:check", "lint": "lint", "types": "typecheck", "test": "test", "testAffected": "test:affected" },
    // Repo name -> gate type -> literal command; wins over scripts and profile defaults.
    "overrides": {}
  },

  // Proposed by detection: confirm providers and consumers.
  "contracts": [
${contracts}
  ],

  "parallel": { "maxAgents": 4, "maxGateProcesses": 2, "withinRepo": "worktrees" },
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
  "graph": { "exclude": ${json(DEFAULT_GRAPH_EXCLUDE)} },

  // Managed files the factory must never overwrite (workspace-relative paths).
  "unmanaged": []
}
`;
}
