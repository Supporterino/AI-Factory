import type { ContractConfig, FactoryConfig, RepoConfig } from "../config/schema.ts";
import { contractKey } from "./contracts.ts";
import { type DetectedRepo, type Detection, toRepoConfig } from "./workspace.ts";

/**
 * Differences between detection and the config. Repos are matched by path and contracts
 * by kind + provider + path, so renaming a repo in the config is not a difference.
 */
export type Change =
  | { kind: "layout"; from: FactoryConfig["layout"] | undefined; to: FactoryConfig["layout"] }
  | { kind: "repo-added"; repo: RepoConfig }
  | { kind: "repo-removed"; name: string; path: string }
  | {
      kind: "repo-changed";
      name: string;
      path: string;
      field: "languages" | "subPaths" | "defaultBranch" | "role";
      from: unknown;
      to: unknown;
    }
  | { kind: "contract-added"; contract: ContractConfig }
  | { kind: "contract-removed"; contract: ContractConfig }
  | { kind: "contract-consumers"; contract: ContractConfig; from: string[]; to: string[] };

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function repoChanges(configured: RepoConfig, detected: DetectedRepo): Change[] {
  const changes: Change[] = [];
  const push = (
    field: "languages" | "subPaths" | "defaultBranch" | "role",
    from: unknown,
    to: unknown,
  ) => {
    if (!same(from, to)) {
      changes.push({
        kind: "repo-changed",
        name: configured.name,
        path: configured.path,
        field,
        from,
        to,
      });
    }
  };
  push("role", configured.role, detected.role);
  // An uninitialised submodule tells us nothing about languages or branches.
  if (!detected.initialized) return changes;
  push("languages", configured.languages, detected.languages);
  push("subPaths", configured.subPaths ?? [], detected.subPaths ?? []);
  if (detected.defaultBranch !== undefined) {
    push("defaultBranch", configured.defaultBranch, detected.defaultBranch);
  }
  return changes;
}

/** `config` is undefined before `init`: then everything detected is an addition. */
export function diffDetection(detection: Detection, config: FactoryConfig | undefined): Change[] {
  const changes: Change[] = [];
  if (config?.layout !== detection.layout) {
    changes.push({ kind: "layout", from: config?.layout, to: detection.layout });
  }

  const configuredRepos = config?.repos ?? [];
  for (const detected of detection.repos) {
    const configured = configuredRepos.find((r) => r.path === detected.path);
    if (configured === undefined) {
      changes.push({ kind: "repo-added", repo: toRepoConfig(detected) });
    } else {
      changes.push(...repoChanges(configured, detected));
    }
  }
  for (const configured of configuredRepos) {
    if (!detection.repos.some((r) => r.path === configured.path)) {
      changes.push({ kind: "repo-removed", name: configured.name, path: configured.path });
    }
  }

  // Contracts in the config name repos by config name; detection names them by detected
  // name. Translate detected names through the shared repo path.
  const nameByPath = new Map(configuredRepos.map((r) => [r.path, r.name]));
  const configName = (detectedName: string): string => {
    const path = detection.repos.find((r) => r.name === detectedName)?.path;
    return (path !== undefined ? nameByPath.get(path) : undefined) ?? detectedName;
  };
  const detectedContracts = detection.contracts.map((c) => ({
    ...c,
    provider: configName(c.provider),
    consumers: c.consumers.map(configName).sort(),
  }));
  const configuredContracts = config?.contracts ?? [];
  for (const detected of detectedContracts) {
    const configured = configuredContracts.find((c) => contractKey(c) === contractKey(detected));
    if (configured === undefined) {
      changes.push({ kind: "contract-added", contract: detected });
    } else if (!same([...configured.consumers].sort(), detected.consumers)) {
      changes.push({
        kind: "contract-consumers",
        contract: configured,
        from: configured.consumers,
        to: detected.consumers,
      });
    }
  }
  for (const configured of configuredContracts) {
    if (!detectedContracts.some((c) => contractKey(c) === contractKey(configured))) {
      changes.push({ kind: "contract-removed", contract: configured });
    }
  }
  return changes;
}

const list = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join(", ")}]`
    : String(value);

export function formatChange(change: Change): string {
  switch (change.kind) {
    case "layout":
      return `~ layout: ${change.from ?? "(none)"} → ${change.to}`;
    case "repo-added":
      return `+ repo ${change.repo.name} (${change.repo.path}) languages ${list(change.repo.languages)}`;
    case "repo-removed":
      return `- repo ${change.name} (${change.path})`;
    case "repo-changed":
      return `~ repo ${change.name} ${change.field}: ${list(change.from)} → ${list(change.to)}`;
    case "contract-added":
      return `+ contract ${change.contract.kind} ${change.contract.provider}:${change.contract.path} → consumers ${list(change.contract.consumers)}`;
    case "contract-removed":
      return `- contract ${change.contract.kind} ${change.contract.provider}:${change.contract.path}`;
    case "contract-consumers":
      return `~ contract ${change.contract.kind} ${change.contract.provider}:${change.contract.path} consumers: ${list(change.from)} → ${list(change.to)}`;
  }
}
