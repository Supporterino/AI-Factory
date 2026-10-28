import { readdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../../config/load.ts";
import { CHANGE_ID } from "../../git/repo.ts";
import { readActive, readQueue } from "../../state/active.ts";
import { loadRun } from "../../state/run.ts";
import type { CompletionValue } from "../command.ts";

/** What value completion knows about the current command line. */
export interface ValueContext {
  /** Workspace root, when the completer is inside one. */
  readonly root?: string;
  /** Positional values already typed after the command (flag values excluded). */
  readonly positionals: readonly string[];
}

const names = (dir: string, suffix: string): string[] => {
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(suffix))
      .map((name) => name.slice(0, -suffix.length));
  } catch {
    return [];
  }
};

const changeIds = (root: string, includeLedgers: boolean): string[] => {
  const ids = new Set<string>();
  for (const id of names(join(root, ".factory", "runs"), ".json")) ids.add(id);
  try {
    const active = readActive(root);
    if (active !== undefined) ids.add(active.changeId);
  } catch {
    // A corrupt lock only means no extra candidate.
  }
  try {
    for (const entry of readQueue(root).entries) ids.add(entry.changeId);
  } catch {
    // Same for a corrupt queue.
  }
  try {
    for (const entry of readdirSync(join(root, "openspec", "changes"), { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== "archive") ids.add(entry.name);
    }
  } catch {
    // No OpenSpec workspace yet.
  }
  if (includeLedgers) for (const id of names(join(root, ".factory", "usage"), ".json")) ids.add(id);
  return [...ids].filter((id) => CHANGE_ID.test(id));
};

const repoIds = (root: string): string[] => {
  try {
    return loadConfig(root)
      .config.repos.filter((repo) => repo.role === "code")
      .map((repo) => repo.name);
  } catch {
    try {
      return readdirSync(join(root, "repos"), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return [];
    }
  }
};

const agentIds = (root: string): string[] => {
  const ids = new Set(names(join(root, ".opencode", "agents"), ".md"));
  try {
    const config = loadConfig(root).config;
    for (const agent of config.agents) ids.add(agent.id);
    for (const role of ["orchestrator", "architect", "explorer", "reviewer", "tester"])
      ids.add(role);
    for (const repo of config.repos) if (repo.role === "code") ids.add(`implementer-${repo.name}`);
  } catch {
    // The rendered agents still complete when the config is broken.
  }
  return [...ids];
};

const modelIds = (root: string): string[] => {
  try {
    const found = new Set<string>();
    const visit = (value: unknown): void => {
      if (typeof value === "string") found.add(value);
      else if (Array.isArray(value)) for (const item of value) visit(item);
      else if (typeof value === "object" && value !== null)
        for (const item of Object.values(value)) visit(item);
    };
    visit(loadConfig(root).config.models);
    return [...found];
  } catch {
    return [];
  }
};

const taskIds = (root: string, positionals: readonly string[]): string[] => {
  let id = positionals.find((word) => CHANGE_ID.test(word));
  if (id === undefined) {
    try {
      id = readActive(root)?.changeId;
    } catch {
      id = undefined;
    }
  }
  if (id === undefined) return [];
  try {
    return loadRun(root, id)?.tasks.map((task) => task.id) ?? [];
  } catch {
    return [];
  }
};

/** Candidates for a dynamic value kind. Static choices live on the option itself. */
export function valueCandidates(kind: CompletionValue, context: ValueContext): string[] {
  if (kind === "shell") return ["bash", "zsh", "fish"];
  if (kind === "level") return ["lite", "full", "ultra"];
  if (kind === "file" || kind === "dir") return [];
  const root = context.root;
  if (root === undefined) return [];
  switch (kind) {
    case "change":
      return changeIds(root, false);
    case "ledger":
      return changeIds(root, true);
    case "task":
      return taskIds(root, context.positionals);
    case "repo":
      return repoIds(root);
    case "agent":
      return agentIds(root);
    case "model":
      return modelIds(root);
    default:
      return [];
  }
}
