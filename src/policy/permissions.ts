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

/** Files no agent may read or edit. */
export const SECRET_PATHS = [
  ".env*",
  "*/.env*",
  "*.pem",
  "*.key",
  "id_rsa*",
  "id_ed25519*",
  "id_ecdsa*",
  "*/id_rsa*",
  "*/id_ed25519*",
  "*/id_ecdsa*",
  "*kubeconfig*",
  "*/.kube/*",
  "*/.aws/*",
  "*/.config/gcloud/*",
  "*.tfstate",
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

/** Static rules rendered into `.opencode/agents/<role>.md`. Sessions add task-specific ones. */
export function agentRules(role: AgentRole): PermissionRule[] {
  const rules: PermissionRule[] = ACTIONS.map((a) => rule(a, "*", "deny"));
  switch (role) {
    case "orchestrator":
      // Works only from the DAG, task states and handoffs in its prompt. No tools.
      break;
    case "explorer":
    case "architect":
      rules.push(...READ_TOOLS, ...allowAll("shell", GRAPH_QUERY_COMMANDS));
      break;
    case "reviewer":
    case "contract-reviewer":
      rules.push(...READ_TOOLS, ...allowAll("shell", [...GRAPH_QUERY_COMMANDS, ...READ_ONLY_GIT]));
      break;
    case "tester":
      // Edit scope (test globs inside the worktree) is granted per session.
      rules.push(...READ_TOOLS, rule("shell", "*", "allow"));
      break;
    case "implementer":
      rules.push(...READ_TOOLS, rule("shell", "*", "allow"), rule("edit", "*", "allow"));
      break;
  }
  return [...rules, ...alwaysDeny()];
}

/** Appended last to every rule set, static or per session. */
export function alwaysDeny(): PermissionRule[] {
  return [
    ...denyAll("edit", [...PROTECTED_PATHS, ...SECRET_PATHS]),
    ...denyAll("read", SECRET_PATHS),
    ...denyAll("shell", SHELL_DENY),
    rule("external_directory", "*", "deny"),
  ];
}
