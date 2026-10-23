import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ExecError } from "../errors.ts";
import { exec } from "../exec.ts";
import { type DagTask, validateDag } from "../tasks/dag.ts";
import { parseTasks } from "../tasks/parse.ts";
import { toolBin, toolEnv } from "../tools.ts";

/**
 * Typed wrappers over the OpenSpec CLI (tooling.md §2). Every call runs quietly with a
 * private config dir, so output never depends on the user's global OpenSpec profile.
 */

function env(root: string): Record<string, string> {
  const xdg = join(root, ".factory", "cache", "openspec-xdg");
  mkdirSync(xdg, { recursive: true });
  return { ...toolEnv("openspec"), XDG_CONFIG_HOME: xdg };
}

async function openspec(root: string, cwd: string, args: readonly string[]) {
  return exec([toolBin("openspec"), ...args], { cwd, env: env(root), timeoutMs: 120_000 });
}

export const changePath = (dir: string, id: string): string => join(dir, "openspec", "changes", id);

/** Scaffolds `openspec/changes/<id>/` (with `.openspec.yaml`) unless it exists. */
export async function newChange(root: string, dir: string, id: string): Promise<void> {
  if (existsSync(changePath(dir, id))) return;
  const res = await openspec(root, dir, ["new", "change", id]);
  if (res.code !== 0) throw new ExecError(`openspec new change ${id} failed`, res);
}

interface ValidateJson {
  items?: {
    id: string;
    valid: boolean;
    issues: { level: string; path?: string; message: string }[];
  }[];
}

/** `openspec validate <id> --strict --json`: error and warning messages, empty when valid. */
export async function validateChange(root: string, dir: string, id: string): Promise<string[]> {
  const res = await openspec(root, dir, ["validate", id, "--strict", "--json", "--no-interactive"]);
  let parsed: ValidateJson;
  try {
    parsed = JSON.parse(res.stdout) as ValidateJson;
  } catch {
    return [`openspec validate failed: ${(res.stderr || res.stdout).trim()}`];
  }
  const item = parsed.items?.find((i) => i.id === id);
  if (item === undefined) return [`openspec does not know change ${id}`];
  return item.valid
    ? []
    : item.issues.map(
        (i) => `openspec ${i.level.toLowerCase()}: ${i.path ? `${i.path}: ` : ""}${i.message}`,
      );
}

/** OpenSpec never validates proposal.md (gap G7); the factory checks the required sections. */
export function checkProposal(dir: string, id: string): string[] {
  const file = join(changePath(dir, id), "proposal.md");
  if (!existsSync(file)) return ["proposal.md is missing"];
  const text = readFileSync(file, "utf8");
  const issues: string[] = [];
  for (const heading of ["## Why", "## What Changes"]) {
    if (!text.split("\n").some((l) => l.trim() === heading))
      issues.push(`proposal.md lacks a "${heading}" section`);
  }
  const why =
    text
      .split(/^## Why\s*$/m)[1]
      ?.split(/^## /m)[0]
      ?.trim() ?? "";
  if (why.length > 0 && why.length < 20) issues.push("proposal.md: the Why section is too short");
  return issues;
}

export interface DesignCheck {
  readonly issues: string[];
  readonly tasks: DagTask[];
}

/** Everything that must hold before a change can be approved (§7 step 2). */
export async function checkDesign(
  root: string,
  dir: string,
  id: string,
  codeRepos: readonly string[],
): Promise<DesignCheck> {
  const issues = [...checkProposal(dir, id), ...(await validateChange(root, dir, id))];
  const tasksFile = join(changePath(dir, id), "tasks.md");
  if (!existsSync(tasksFile)) return { issues: [...issues, "tasks.md is missing"], tasks: [] };
  const parsed = parseTasks(readFileSync(tasksFile, "utf8"));
  issues.push(...parsed.issues.map((i) => `tasks.md:${i.line}: ${i.message}`));
  if (parsed.tasks.length === 0) issues.push("tasks.md has no tasks");
  const dag = validateDag(parsed.tasks, codeRepos);
  issues.push(
    ...dag.issues.map((i) => `tasks.md: ${i.task ? `task ${i.task}: ` : ""}${i.message}`),
  );
  return { issues, tasks: dag.tasks };
}

/** `openspec archive <id> --yes --json`. The caller has already checked that every task is done. */
export async function archiveChange(root: string, dir: string, id: string): Promise<string> {
  const res = await openspec(root, dir, ["archive", id, "--yes", "--json"]);
  if (res.code !== 0) throw new ExecError(`openspec archive ${id} failed`, res);
  const parsed = JSON.parse(res.stdout) as { archive?: { archivedAs?: string } };
  return parsed.archive?.archivedAs ?? id;
}
