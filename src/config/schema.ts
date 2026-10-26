import { z } from "zod";
import { PONYTAIL } from "../versions.ts";

/** Current `factory.config.jsonc` schema version. Bump only together with a migration. */
export const CONFIG_SCHEMA_VERSION = 3;

export const CONFIG_FILE = "factory.config.jsonc";

export const LANGUAGES = [
  "typescript",
  "react",
  "python",
  "go",
  "rust",
  "helm",
  "tauri",
  "swift",
] as const;
export const Language = z.enum(LANGUAGES);
export type Language = z.infer<typeof Language>;

export const ROLES = [
  "orchestrator",
  "architect",
  "reviewer",
  "contractReviewer",
  "implementer",
  "tester",
  "explorer",
] as const;
export type Role = (typeof ROLES)[number];

/** Roles a custom agent can fill. Hyphenated ids match the generated agent filenames. */
export const AGENT_PHASES = [
  "orchestrator",
  "architect",
  "explorer",
  "reviewer",
  "contract-reviewer",
  "tester",
  "implementer",
] as const;
export type AgentPhase = (typeof AGENT_PHASES)[number];

export const GATE_TYPES = ["format", "lint", "types", "test", "testAffected"] as const;
export const GateType = z.enum(GATE_TYPES);
export type GateType = z.infer<typeof GateType>;

export const CONTRACT_KINDS = [
  "openapi",
  "proto",
  "json-schema",
  "helm-values",
  "generated",
  "crd",
  "ipc",
  "custom",
] as const;
export const ContractKind = z.enum(CONTRACT_KINDS);
export type ContractKind = z.infer<typeof ContractKind>;

const RepoName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase letters, digits and dashes, starting alphanumeric");

/** A workspace-relative POSIX path: "." or segments without "..", leading "/" or "\". */
const RelPath = z
  .string()
  .min(1)
  .refine(
    (p) => p === "." || (!p.startsWith("/") && !p.includes("\\") && !p.split("/").includes("..")),
    "must be '.' or a relative POSIX path inside the workspace",
  );

/** opencode model id: "provider/model" with an optional "#variant". */
const ModelId = z.string().regex(/^[^/\s]+\/\S+$/, 'expected "provider/model"');

const SubPath = z.strictObject({
  path: RelPath,
  languages: z.array(Language),
});

export const RepoConfig = z.strictObject({
  name: RepoName,
  path: RelPath,
  role: z.enum(["orchestration", "code"]).default("code"),
  languages: z.array(Language),
  defaultBranch: z.string().min(1).optional(),
  /** Monorepo packages whose languages differ from the repo root. */
  subPaths: z.array(SubPath).optional(),
});
export type RepoConfig = z.infer<typeof RepoConfig>;

/** The repo's languages including its monorepo packages' (standards, test globs, installs). */
export const repoLanguages = (repo: Pick<RepoConfig, "languages" | "subPaths">): Language[] => [
  ...new Set([...repo.languages, ...(repo.subPaths ?? []).flatMap((s) => s.languages)]),
];

const ModelByRole = z.partialRecord(z.enum(ROLES), ModelId);

/**
 * Models resolve from most specific to least: custom agent, repo + role, role, then the flat
 * v1/v2 fields. The flat fields stay required so an existing config keeps working unchanged.
 */
const ModelsConfig = z.strictObject({
  orchestrator: ModelId,
  architect: ModelId,
  reviewer: ModelId,
  /** Defaults to `reviewer`. */
  contractReviewer: ModelId.optional(),
  implementer: ModelId,
  tester: ModelId,
  explorer: ModelId,
  /** Role-wide overrides; use these instead of the flat fields in new configs. */
  roles: ModelByRole.default({}),
  /** Per-repo role overrides, e.g. a cheaper implementer for docs/charts repos. */
  repos: z.record(z.string(), ModelByRole).default({}),
  /** Per-custom-agent overrides; wins over repo and role. */
  agents: z.record(z.string(), ModelId).default({}),
  /** Tried in order when the first model is unavailable at runtime. */
  fallback: z.array(ModelId).default([]),
});

const InstructionsConfig = z.strictObject({
  /** Workspace-relative paths opencode should inject into every session. */
  workspace: z.array(RelPath).default([]),
  /** Repo name → workspace-relative paths injected for that repo's sessions. */
  repos: z.record(z.string(), z.array(RelPath)).default({}),
});

const SkillsConfig = z.strictObject({
  /** Directories scanned for SKILL.md files. The default is opencode's own location. */
  sources: z.array(RelPath).default([".opencode/skills"]),
  /** Skill ids a role should load first. Empty means "do not advertise a skill". */
  roles: z.partialRecord(z.enum(ROLES), z.array(z.string().min(1))).default({}),
  /** Repo name → extra skills for every role working there. */
  repos: z.record(z.string(), z.array(z.string().min(1))).default({}),
});

const McpConfig = z.strictObject({
  /**
   * Role → opencode MCP tool action patterns (e.g. `mantine_*`). MCP tools are otherwise
   * left on `ask`, which the headless runtime rejects.
   */
  roles: z.partialRecord(z.enum(ROLES), z.array(z.string().min(1))).default({}),
});

const CustomAgent = z.strictObject({
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase letters, digits and dashes, starting alphanumeric"),
  /** Pipeline phase this agent can take over. */
  phase: z.enum(AGENT_PHASES),
  description: z.string().min(1).default("custom ai-factory agent"),
  model: ModelId.optional(),
  mode: z.enum(["primary", "subagent", "all"]).default("subagent"),
  /** Inline system prompt. Use `promptFile` for a longer prompt kept in the repository. */
  prompt: z.string().min(1).optional(),
  promptFile: RelPath.optional(),
  /** Skills this agent loads first; implies permission to use the skill tool. */
  skills: z.array(z.string().min(1)).default([]),
  /** Edit scope relative to the session directory. Empty for read-only agents. */
  edits: z.array(z.string().min(1)).default([]),
  /** Extra shell allow rules; the normal deny-list still wins. */
  shell: z.array(z.string().min(1)).default([]),
  /** Allow read-only web search/fetch. */
  web: z.boolean().default(false),
  /** MCP tool action patterns this agent may call (e.g. `mantine_*`). */
  mcp: z.array(z.string().min(1)).default([]),
});

const RoutingRule = z.strictObject({
  /** Task `touches` globs that select this agent. */
  paths: z.array(z.string().min(1)).min(1),
  /** A custom agent id or a built-in `implementer-<repo>` id. */
  agent: z.string().min(1),
});

const ExtraGate = z.strictObject({
  name: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase letters, digits and dashes, starting alphanumeric"),
  /** Reported under this base gate type; order still follows the normal gate order. */
  type: z.enum(GATE_TYPES).default("test"),
  phases: z.array(z.enum(["task", "full"])).default(["task", "full"]),
  /** Run only when a changed path matches one of these globs (task mode). */
  when: z
    .strictObject({ changed: z.array(z.string().min(1)).default([]) })
    .default({ changed: [] }),
  cwd: RelPath.default("."),
  command: z.string().min(1),
  env: z.record(z.string(), z.string()).default({}),
  /** Runs before `command`, in the same cwd/env. */
  setup: z.string().min(1).optional(),
  /** Generated-artifact gate: run the command, then fail if any output changed. */
  outputs: z.array(RelPath).default([]),
  /** `false` lets a gate write files (use with `outputs`); still restored on failure. */
  checkOnly: z.boolean().default(true),
  timeoutMs: z.int().min(1).optional(),
});

const GateCommands = z.partialRecord(GateType, z.string().min(1));

const GatesConfig = z.strictObject({
  maxRetries: z.int().min(0).max(10).default(3),
  /** Gate type → script/target name looked up in package.json, Makefile, justfile, Taskfile. */
  scripts: GateCommands.default({
    format: "format:check",
    lint: "lint",
    types: "typecheck",
    test: "test",
    testAffected: "test:affected",
  }),
  /** Repo name → gate type → literal command. Wins over scripts and profile defaults. */
  overrides: z.record(z.string(), GateCommands).default({}),
  /** Additional conditional/generated gates, run after the five base gates. */
  extra: z.array(ExtraGate).default([]),
});

export const ContractConfig = z.strictObject({
  kind: ContractKind,
  provider: RepoName,
  /** Relative to the provider repo (a directory for proto). */
  path: RelPath,
  consumers: z.array(RepoName),
  /** Generated/custom contracts: the generation or validation command. */
  command: z.string().min(1).optional(),
  /** Generated/custom contracts: files the command must leave unchanged. */
  outputs: z.array(RelPath).optional(),
  /** Accept breaking changes (e.g. a planned major version); consumer checks still run. */
  allowBreaking: z.boolean().optional(),
  /**
   * Consumer repo → check-only command run in that repo against the new contract
   * (`{contract}` = absolute path of the provider's contract), e.g. a type-check of a
   * generated client.
   */
  validate: z.record(RepoName, z.string().min(1)).optional(),
});
export type ContractConfig = z.infer<typeof ContractConfig>;

const ParallelConfig = z.strictObject({
  maxAgents: z.int().min(1).max(64).default(4),
  maxGateProcesses: z.int().min(1).max(64).default(2),
  withinRepo: z.enum(["worktrees", "serial"]).default("worktrees"),
});

const TokensConfig = z.strictObject({
  mode: z.literal("report").default("report"),
  contextPackMaxTokens: z.int().min(500).default(8000),
  gateOutputMaxLines: z.int().min(10).default(80),
});

export const PONYTAIL_ROLES = ["implementer", "reviewer"] as const;

const PonytailConfig = z.strictObject({
  enabled: z.boolean().default(true),
  /** "<tag>@<commit sha>". */
  ref: z
    .string()
    .regex(/^v\d+\.\d+\.\d+@[0-9a-f]{40}$/, 'expected "<tag>@<40-char commit sha>"')
    .default(`${PONYTAIL.tag}@${PONYTAIL.commit}`),
  roles: z.array(z.enum(PONYTAIL_ROLES)).default([...PONYTAIL_ROLES]),
  level: z.enum(["lite", "full", "ultra"]).default("full"),
  shortcutComments: z.enum(["report", "forbid"]).default("report"),
});

const LogsConfig = z.strictObject({
  retentionDays: z.int().min(1).default(14),
  redact: z.boolean().default(true),
});

/** v2 default: also vendored deps, build caches and coverage output (migration 001). */
export const DEFAULT_GRAPH_EXCLUDE = [
  "**/node_modules/**",
  "**/vendor/**",
  "**/target/**",
  "**/dist/**",
  "**/build/**",
  "**/coverage/**",
  "**/.next/**",
  "**/__pycache__/**",
  "**/.venv/**",
  ".factory/**",
  "graphify-out/**",
] as const;

const SecurityConfig = z.strictObject({
  /** OS sandbox for agent shells and gates: "auto" (macOS sandbox-exec when present) or "off". */
  sandbox: z.enum(["auto", "off"]).default("auto"),
});

const GraphConfig = z.strictObject({
  exclude: z.array(z.string().min(1)).default([...DEFAULT_GRAPH_EXCLUDE]),
});

const CommitsConfig = z.strictObject({
  /** Conventional commits by default; gitmoji keeps the same type prefix. */
  style: z.enum(["conventional", "gitmoji"]).default("conventional"),
  /** Prefix task commits with the repo name, e.g. `feat(backend): ...`. */
  scopes: z.boolean().default(false),
});

const QuickConfig = z.strictObject({
  enabled: z.boolean().default(true),
  branchPrefix: z.string().min(1).default("task/"),
});

const WorkflowConfig = z.strictObject({
  /** Offer `ai-factory refine` / `run --interactive` clarification before design. */
  refine: z.boolean().default(true),
  quick: QuickConfig.prefault({}),
});

const ReleaseConfig = z.strictObject({
  /** Detect and report release-please, goreleaser, changesets and forge CI. */
  detect: z.boolean().default(true),
});

const FactoryConfigBase = z.strictObject({
  $schema: z.string().optional(),
  /** v2 is accepted at runtime so an existing workspace keeps working until `update`. */
  schemaVersion: z.union([z.literal(2), z.literal(CONFIG_SCHEMA_VERSION)]),
  layout: z.enum(["single", "submodules"]),
  repos: z.array(RepoConfig).min(1),
  models: ModelsConfig,
  instructions: InstructionsConfig.prefault({}),
  skills: SkillsConfig.prefault({}),
  mcp: McpConfig.prefault({}),
  agents: z.array(CustomAgent).default([]),
  routing: z.array(RoutingRule).default([]),
  gates: GatesConfig.prefault({}),
  contracts: z.array(ContractConfig).default([]),
  parallel: ParallelConfig.prefault({}),
  tokens: TokensConfig.prefault({}),
  addons: z.strictObject({ ponytail: PonytailConfig.prefault({}) }).prefault({}),
  logs: LogsConfig.prefault({}),
  graph: GraphConfig.prefault({}),
  security: SecurityConfig.prefault({}),
  commits: CommitsConfig.prefault({}),
  workflow: WorkflowConfig.prefault({}),
  release: ReleaseConfig.prefault({}),
  /** Managed files (workspace-relative) the factory must never overwrite on update. */
  unmanaged: z.array(RelPath).default([]),
});

export const FactoryConfig = FactoryConfigBase.superRefine((cfg, ctx) => {
  const issue = (path: (string | number)[], message: string): void => {
    ctx.addIssue({ code: "custom", path, message });
  };

  const names = new Set<string>();
  const paths = new Set<string>();
  cfg.repos.forEach((repo, i) => {
    if (names.has(repo.name)) issue(["repos", i, "name"], `duplicate repo name "${repo.name}"`);
    if (paths.has(repo.path)) issue(["repos", i, "path"], `duplicate repo path "${repo.path}"`);
    names.add(repo.name);
    paths.add(repo.path);
  });

  const orchestration = cfg.repos.filter((r) => r.role === "orchestration");
  if (cfg.layout === "single") {
    if (cfg.repos.length !== 1 || cfg.repos[0]?.path !== ".") {
      issue(["repos"], 'single layout needs exactly one repo with path "."');
    }
    if (orchestration.length > 0) {
      issue(["repos"], 'single layout has no "orchestration" repo');
    }
  } else {
    if (orchestration.length !== 1 || orchestration[0]?.path !== ".") {
      issue(["repos"], 'submodules layout needs exactly one "orchestration" repo with path "."');
    }
    cfg.repos.forEach((repo, i) => {
      if (repo.role === "code" && repo.path === ".") {
        issue(["repos", i, "path"], 'code repos in submodules layout cannot use path "."');
      }
    });
  }

  const codeRepos = new Set(cfg.repos.filter((r) => r.role === "code").map((r) => r.name));
  cfg.contracts.forEach((contract, i) => {
    for (const repo of Object.keys(contract.validate ?? {})) {
      if (!contract.consumers.includes(repo)) {
        issue(["contracts", i, "validate", repo], `"${repo}" is not a consumer of this contract`);
      }
    }
    if (!codeRepos.has(contract.provider)) {
      issue(["contracts", i, "provider"], `unknown code repo "${contract.provider}"`);
    }
    contract.consumers.forEach((consumer, j) => {
      if (!codeRepos.has(consumer)) {
        issue(["contracts", i, "consumers", j], `unknown code repo "${consumer}"`);
      } else if (consumer === contract.provider) {
        issue(["contracts", i, "consumers", j], "a provider cannot consume its own contract");
      }
    });
    if (
      ["generated", "crd", "ipc", "custom"].includes(contract.kind) &&
      contract.command === undefined
    ) {
      issue(["contracts", i, "command"], `${contract.kind} contracts need a command`);
    }
  });

  for (const repoName of Object.keys(cfg.gates.overrides)) {
    if (!codeRepos.has(repoName)) {
      issue(["gates", "overrides", repoName], `unknown code repo "${repoName}"`);
    }
  }

  for (const key of ["instructions", "skills"] as const) {
    for (const repoName of Object.keys(cfg[key].repos)) {
      if (!codeRepos.has(repoName)) {
        issue([key, "repos", repoName], `unknown code repo "${repoName}"`);
      }
    }
  }
  for (const repoName of Object.keys(cfg.models.repos)) {
    if (!codeRepos.has(repoName)) {
      issue(["models", "repos", repoName], `unknown code repo "${repoName}"`);
    }
  }

  const agentIds = new Set<string>();
  for (const [i, agent] of cfg.agents.entries()) {
    if (agentIds.has(agent.id)) issue(["agents", i, "id"], `duplicate agent id "${agent.id}"`);
    if (agent.prompt === undefined && agent.promptFile === undefined) {
      issue(["agents", i], "a custom agent needs `prompt` or `promptFile`");
    }
    if (agent.prompt !== undefined && agent.promptFile !== undefined) {
      issue(["agents", i], "use either `prompt` or `promptFile`, not both");
    }
    agentIds.add(agent.id);
  }
  const builtin = new Set([
    "orchestrator",
    "architect",
    "explorer",
    "reviewer",
    "contract-reviewer",
    "tester",
    ...cfg.repos.filter((r) => r.role === "code").map((r) => `implementer-${r.name}`),
  ]);
  for (const [i, agent] of cfg.agents.entries()) {
    if (builtin.has(agent.id)) {
      issue(["agents", i, "id"], `"${agent.id}" is a built-in agent id; choose another id`);
    }
  }
  for (const [i, rule] of cfg.routing.entries()) {
    if (!agentIds.has(rule.agent) && !builtin.has(rule.agent)) {
      issue(["routing", i, "agent"], `unknown agent "${rule.agent}"`);
    }
  }
  for (const agentId of Object.keys(cfg.models.agents)) {
    if (!agentIds.has(agentId)) {
      issue(["models", "agents", agentId], `unknown custom agent "${agentId}"`);
    }
  }
});

/** Parsed config with all defaults applied. */
export type FactoryConfig = z.output<typeof FactoryConfig>;
/** What a user may write (defaults optional). */
export type FactoryConfigInput = z.input<typeof FactoryConfig>;

/** The model for a role, resolving the documented fallbacks and overrides. */
export function modelFor(
  config: FactoryConfig,
  role: Role,
  options: { repo?: string; agent?: string } = {},
): string {
  const flat =
    role === "contractReviewer"
      ? (config.models.contractReviewer ?? config.models.reviewer)
      : config.models[role];
  if (options.agent !== undefined) {
    const agent = config.models.agents[options.agent];
    if (agent !== undefined) return agent;
  }
  if (options.repo !== undefined) {
    const repo = config.models.repos[options.repo]?.[role];
    if (repo !== undefined) return repo;
  }
  return config.models.roles[role] ?? flat;
}

/** Model labels for `doctor`: role names stay stable, overrides are qualified. */
export function modelEntries(config: FactoryConfig): [string, string][] {
  const out: [string, string][] = [];
  for (const role of ROLES) {
    if (role === "contractReviewer") continue;
    const model = config.models[role];
    if (typeof model === "string") out.push([role, model]);
  }
  if (config.models.contractReviewer !== undefined)
    out.push(["contractReviewer", config.models.contractReviewer]);
  for (const [role, model] of Object.entries(config.models.roles)) {
    if (model !== undefined) out.push([`${role} (role)`, model]);
  }
  for (const [repo, byRole] of Object.entries(config.models.repos)) {
    for (const [role, model] of Object.entries(byRole)) {
      if (model !== undefined) out.push([`${role} (${repo})`, model]);
    }
  }
  for (const [agent, model] of Object.entries(config.models.agents)) {
    out.push([`agent ${agent}`, model]);
  }
  return out;
}

/** Every model id a config can reach, for credential scoping and `doctor`. */
export function allModels(config: FactoryConfig): string[] {
  const out = new Set<string>();
  for (const role of ROLES) {
    const flat = config.models[role];
    if (typeof flat === "string") out.add(flat);
  }
  if (config.models.contractReviewer !== undefined) out.add(config.models.contractReviewer);
  for (const model of Object.values(config.models.roles)) if (model !== undefined) out.add(model);
  for (const byRole of Object.values(config.models.repos)) {
    for (const model of Object.values(byRole)) if (model !== undefined) out.add(model);
  }
  for (const model of Object.values(config.models.agents)) out.add(model);
  for (const model of config.models.fallback) out.add(model);
  return [...out].sort();
}

/** The provider ids a config names (`anthropic/claude…` → `anthropic`). */
export function providerIds(config: FactoryConfig): string[] {
  return [...new Set(allModels(config).map((m) => m.split("/")[0] ?? m))].sort();
}
