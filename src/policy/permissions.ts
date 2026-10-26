/**
 * opencode v2 permission rules (tooling.md §1, ADR-0011). The last matching rule wins and
 * `*` matches `/`. Every rule set starts by denying every action, adds the role's allows and
 * ends with the always-on denies, so those win over any allow.
 */

export type Effect = "allow" | "deny";

export interface PermissionRule {
  readonly action: string;
  readonly resource: string;
  readonly effect: Effect;
}

/** Every built-in opencode v2 tool action. */
export const ACTIONS = [
  "read",
  "glob",
  "grep",
  "edit",
  "shell",
  "subagent",
  "webfetch",
  "websearch",
  "skill",
  "question",
  "execute",
  "external_directory",
] as const;
export type Action = (typeof ACTIONS)[number];

/** Paths no agent may edit, relative to the session directory (§8). */
export const PROTECTED_PATHS = [
  "openspec/specs/*",
  ".opencode/*",
  ".factory/*",
  "factory.config.jsonc",
  "factory.lock.json",
  "AGENTS.md",
  "*/AGENTS.md",
  ".git",
  ".git/*",
  ".gitmodules",
] as const;

/**
 * Files no agent may read or edit: the opencode-rule form of `isSecretPath` (paths.ts). A test
 * keeps both lists in agreement (audit S11).
 */
export const SECRET_PATHS = [
  ".env*",
  "*/.env*",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  ...["id_rsa*", "id_dsa*", "id_ed25519*", "id_ecdsa*"].flatMap((n) => [n, `*/${n}`]),
  "*kubeconfig*",
  ...[
    ".kube/*",
    ".aws/*",
    ".config/gcloud/*",
    ".config/gh/*",
    ".azure/*",
    ".ssh/*",
    ".docker/config.json",
  ].flatMap((n) => [n, `*/${n}`]),
  ...[".netrc", ".npmrc", ".pypirc", ".git-credentials"].flatMap((n) => [n, `*/${n}`]),
  "*.tfstate",
  "*.tfstate.backup",
] as const;

/** Read-only graph queries agents may run (graph updates are the CLI's job). */
export const GRAPH_QUERY_COMMANDS = [
  "graphify query *",
  "graphify explain *",
  "graphify path *",
  "graphify affected *",
  "graphify god-nodes*",
] as const;

const READ_ONLY_GIT = [
  "git status*",
  "git diff*",
  "git log*",
  "git show*",
  "git blame *",
  // The contract reviewer reads several repos from the workspace root.
  "git -C * diff*",
  "git -C * log*",
  "git -C * show*",
] as const;

/**
 * Coarse shell denies. The plugin's parsed blocklist (slice 6) is the precise guard;
 * these keep the obvious cases out even if the plugin fails to load.
 */
export const SHELL_DENY = [
  "git push*",
  "git remote *",
  "git config *",
  "git reset --hard*",
  "git clean *",
  "git filter-*",
  "git rebase -i*",
  "git rebase --interactive*",
  "git branch -D *",
  "git branch -d *",
  "git tag -d *",
  "sudo *",
  "graphify update*",
  "graphify extract*",
  "graphify hook*",
  "graphify install*",
  "graphify * install*",
] as const;

export type AgentRole =
  | "orchestrator"
  | "architect"
  | "explorer"
  | "reviewer"
  | "contract-reviewer"
  | "tester"
  | "implementer";

const rule = (action: string, resource: string, effect: Effect): PermissionRule => ({
  action,
  resource,
  effect,
});
const allowAll = (action: Action, resources: readonly string[]) =>
  resources.map((r) => rule(action, r, "allow"));
const denyAll = (action: Action, resources: readonly string[]) =>
  resources.map((r) => rule(action, r, "deny"));

const READ_TOOLS: PermissionRule[] = [
  rule("read", "*", "allow"),
  rule("glob", "*", "allow"),
  rule("grep", "*", "allow"),
];

/**
 * Static rules rendered into `.opencode/agents/<role>.md`. Edit allowances are path rules
 * relative to the session directory; the plugin narrows them to the active change, the task
 * worktree and the repo's own test globs (ADR-0011).
 */
export interface AgentRuleOptions {
  /** Allow the skill tool; the prompt names the skills to load. */
  readonly skills?: boolean;
  /** Allow read-only web search/fetch. */
  readonly web?: boolean;
  /** Extra MCP tool action patterns (e.g. `mantine_*`). */
  readonly mcp?: readonly string[];
}

export function agentRules(
  role: AgentRole,
  testGlobs: readonly string[] = [],
  options: AgentRuleOptions = {},
): PermissionRule[] {
  const rules: PermissionRule[] = ACTIONS.map((a) => rule(a, "*", "deny"));
  switch (role) {
    case "orchestrator":
      // Works only from the DAG, task states and handoffs in its prompt. No tools.
      break;
    case "explorer":
      rules.push(...READ_TOOLS, ...allowAll("shell", GRAPH_QUERY_COMMANDS));
      break;
    case "architect":
      rules.push(
        ...READ_TOOLS,
        ...allowAll("shell", GRAPH_QUERY_COMMANDS),
        rule("edit", "openspec/changes/*", "allow"),
      );
      rules.push(...optionalTools(options));
      // Context packs live under .factory/, which is protected for everyone else.
      return [...rules, ...alwaysDeny([".factory/context/*"])];
    case "reviewer":
    case "contract-reviewer":
      rules.push(...READ_TOOLS, ...allowAll("shell", [...GRAPH_QUERY_COMMANDS, ...READ_ONLY_GIT]));
      break;
    case "tester":
      rules.push(...READ_TOOLS, rule("shell", "*", "allow"), ...allowAll("edit", testGlobs));
      break;
    case "implementer":
      rules.push(...READ_TOOLS, rule("shell", "*", "allow"), rule("edit", "*", "allow"));
      break;
  }
  rules.push(...optionalTools(options));
  return [...rules, ...alwaysDeny()];
}

/** Explicit custom agent: exactly the scope in its config, never `edit: *`. */
export function customAgentRules(
  phase: AgentRole,
  options: {
    readonly edits?: readonly string[];
    readonly shell?: readonly string[];
    readonly skills?: boolean;
    readonly web?: boolean;
    readonly mcp?: readonly string[];
  },
): PermissionRule[] {
  const rules: PermissionRule[] = ACTIONS.map((a) => rule(a, "*", "deny"));
  rules.push(...READ_TOOLS);
  if (phase === "reviewer" || phase === "contract-reviewer") {
    rules.push(...allowAll("shell", [...GRAPH_QUERY_COMMANDS, ...READ_ONLY_GIT]));
  } else {
    rules.push(rule("shell", "*", "allow"));
  }
  rules.push(...allowAll("shell", options.shell ?? []));
  rules.push(...allowAll("edit", options.edits ?? []));
  rules.push(...optionalTools(options));
  return [...rules, ...alwaysDeny()];
}

function optionalTools(options: AgentRuleOptions): PermissionRule[] {
  const out: PermissionRule[] = [];
  if (options.skills === true) out.push(rule("skill", "*", "allow"));
  if (options.web === true)
    out.push(rule("webfetch", "*", "allow"), rule("websearch", "*", "allow"));
  for (const action of options.mcp ?? []) out.push(rule(action, "*", "allow"));
  return out;
}

/**
 * Appended last to every rule set. `reallow` re-opens paths inside the protected ones (the
 * architect's context folder); secrets stay denied after it.
 */
export function alwaysDeny(reallow: readonly string[] = []): PermissionRule[] {
  return [
    ...denyAll("edit", PROTECTED_PATHS),
    ...allowAll("edit", reallow),
    ...denyAll("edit", SECRET_PATHS),
    ...denyAll("read", SECRET_PATHS),
    ...denyAll("shell", SHELL_DENY),
    rule("external_directory", "*", "deny"),
  ];
}

function wildcard(pattern: string): RegExp {
  const body = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${body}$`, "s");
}

/**
 * The effect opencode gives a call, mirroring its matcher: the last matching rule wins,
 * `*` matches anything including `/`, `?` one character, and no match means `ask`.
 */
export function ruleEffect(
  rules: readonly PermissionRule[],
  action: string,
  resource: string,
): Effect | "ask" {
  for (let i = rules.length - 1; i >= 0; i--) {
    const r = rules[i];
    if (r !== undefined && r.action === action && wildcard(r.resource).test(resource))
      return r.effect;
  }
  return "ask";
}
