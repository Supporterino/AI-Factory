import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { CHANGE_ID } from "../git/repo.ts";
import { parseTasks } from "../tasks/parse.ts";
import { changePath } from "./cli.ts";

/**
 * Existing OpenSpec changes in the workspace (ADR-0038). `adopt` uses this to find changes
 * that predate the factory; `init` and `doctor` use it to point at them.
 */

export interface PendingChange {
  readonly id: string;
  /** Absolute change directory. */
  readonly dir: string;
  /** Checked and total OpenSpec task checkboxes (0/0 when `tasks.md` is missing). */
  readonly done: number;
  readonly total: number;
  /** `schema` from `.openspec.yaml`, when present and readable. */
  readonly schema?: string;
  /** First proposal heading, else the first Why line, else the id. */
  readonly summary: string;
  /** The proposal's Why section, else the whole proposal, else a generic request. */
  readonly request: string;
  /** `repo:` values already present in `tasks.md`, in first-seen order. */
  readonly repos: string[];
}

export const factoryRunFile = (root: string, id: string): string =>
  join(root, ".factory", "runs", `${id}.json`);

export const hasRun = (root: string, id: string): boolean => existsSync(factoryRunFile(root, id));

/**
 * Every unarchived `openspec/changes/<id>` directory that looks like a change. Archived
 * changes, non-directories, invalid ids and unrelated files are ignored.
 */
export function pendingChanges(root: string): PendingChange[] {
  const dir = changePath(root, "");
  let entries: string[];
  try {
    entries = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== "archive")
      .map((entry) => entry.name)
      .filter((name) => CHANGE_ID.test(name))
      .sort();
  } catch {
    return [];
  }
  return entries.flatMap((id) => {
    const change = readPendingChange(root, id);
    return change === undefined ? [] : [change];
  });
}

/** One pending change, or undefined when the directory is not an OpenSpec change. */
export function readPendingChange(root: string, id: string): PendingChange | undefined {
  const dir = changePath(root, id);
  if (!existsSync(dir)) return undefined;
  const hasMetadata = existsSync(join(dir, ".openspec.yaml"));
  if (!hasMetadata && !existsSync(join(dir, "proposal.md"))) return undefined;

  const tasksFile = join(dir, "tasks.md");
  const tasks = existsSync(tasksFile) ? parseTasks(readFileSync(tasksFile, "utf8")).tasks : [];
  const proposalFile = join(dir, "proposal.md");
  const proposal = existsSync(proposalFile) ? readFileSync(proposalFile, "utf8") : "";
  const schema = readSchema(dir);
  const why = section(proposal, "Why");
  const title = proposal.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const firstWhyLine = why
    ?.split("\n")
    .find((line) => line.trim() !== "")
    ?.trim();

  return {
    id,
    dir,
    done: tasks.filter((task) => task.done).length,
    total: tasks.length,
    ...(schema === undefined ? {} : { schema }),
    summary: title ?? firstWhyLine ?? id,
    request: why?.trim() || proposal.trim() || `Adopt the existing OpenSpec change ${id}`,
    repos: [...new Set(tasks.flatMap((task) => (task.repo === undefined ? [] : [task.repo])))],
  };
}

/** Pending changes that have no `.factory/runs/<id>.json` yet. */
export function unadoptedChanges(root: string): PendingChange[] {
  return pendingChanges(root).filter((change) => !hasRun(root, change.id));
}

function readSchema(dir: string): string | undefined {
  const file = join(dir, ".openspec.yaml");
  if (!existsSync(file)) return undefined;
  try {
    const parsed = parseYaml(readFileSync(file, "utf8")) as { schema?: unknown } | undefined;
    return typeof parsed?.schema === "string" ? parsed.schema : undefined;
  } catch {
    // A broken metadata file is reported by `openspec validate`; adoption treats it as default.
    return undefined;
  }
}

/** The body of a `## <heading>` section, up to the next `##` heading. */
function section(text: string, heading: string): string | undefined {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start === -1) return undefined;
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^##\s/.test(line)) break;
    body.push(line);
  }
  return body.join("\n").trim();
}
