import { z } from "zod";
import { PONYTAIL } from "../versions.ts";

/** Current `factory.config.jsonc` schema version. Bump only together with a migration. */
export const CONFIG_SCHEMA_VERSION = 2;

export const CONFIG_FILE = "factory.config.jsonc";

export const LANGUAGES = ["typescript", "react", "python", "go", "rust", "helm", "tauri"] as const;
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

export const GATE_TYPES = ["format", "lint", "types", "test", "testAffected"] as const;
export const GateType = z.enum(GATE_TYPES);
export type GateType = z.infer<typeof GateType>;

export const CONTRACT_KINDS = ["openapi", "proto", "json-schema", "helm-values"] as const;
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

const ModelsConfig = z.strictObject({
  orchestrator: ModelId,
  architect: ModelId,
  reviewer: ModelId,
  /** Defaults to `reviewer`. */
  contractReviewer: ModelId.optional(),
  implementer: ModelId,
  tester: ModelId,
  explorer: ModelId,
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
});

export const ContractConfig = z.strictObject({
  kind: ContractKind,
  provider: RepoName,
  /** Relative to the provider repo (a directory for proto). */
  path: RelPath,
  consumers: z.array(RepoName),
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

const FactoryConfigBase = z.strictObject({
  $schema: z.string().optional(),
  schemaVersion: z.literal(CONFIG_SCHEMA_VERSION),
  layout: z.enum(["single", "submodules"]),
  repos: z.array(RepoConfig).min(1),
  models: ModelsConfig,
  gates: GatesConfig.prefault({}),
  contracts: z.array(ContractConfig).default([]),
  parallel: ParallelConfig.prefault({}),
  tokens: TokensConfig.prefault({}),
  addons: z.strictObject({ ponytail: PonytailConfig.prefault({}) }).prefault({}),
  logs: LogsConfig.prefault({}),
  graph: GraphConfig.prefault({}),
  security: SecurityConfig.prefault({}),
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
  });

  for (const repoName of Object.keys(cfg.gates.overrides)) {
    if (!codeRepos.has(repoName)) {
      issue(["gates", "overrides", repoName], `unknown code repo "${repoName}"`);
    }
  }
});

/** Parsed config with all defaults applied. */
export type FactoryConfig = z.output<typeof FactoryConfig>;
/** What a user may write (defaults optional). */
export type FactoryConfigInput = z.input<typeof FactoryConfig>;

/** The model for a role, resolving the documented fallbacks. */
export function modelFor(config: FactoryConfig, role: Role): string {
  if (role === "contractReviewer") return config.models.contractReviewer ?? config.models.reviewer;
  return config.models[role];
}
