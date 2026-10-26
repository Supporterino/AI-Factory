import { globsOverlap, matchGlob } from "./glob.ts";
import type { ParsedTask } from "./parse.ts";

/** A task as the scheduler sees it: metadata required. */
export interface DagTask {
  readonly id: string;
  readonly title: string;
  readonly repo: string;
  readonly deps: readonly string[];
  readonly touches: readonly string[];
}

export interface DagIssue {
  readonly task?: string;
  readonly message: string;
}

/** Unbalanced `[` / `{`: the glob would match nothing, or everything (audit G9). */
function globSyntaxError(glob: string): string | undefined {
  let bracket = false;
  let braces = 0;
  for (const c of glob) {
    if (c === "[" && !bracket) bracket = true;
    else if (c === "]" && bracket) bracket = false;
    else if (c === "{" && !bracket) braces++;
    else if (c === "}" && !bracket) braces--;
    if (braces < 0) return "unbalanced }";
  }
  if (bracket) return "unclosed [";
  if (braces > 0) return "unclosed {";
  return undefined;
}

/**
 * Validates the task DAG before approval (§11): every task names a known code repo, its
 * deps exist, it has `touches`, ids are unique and there is no cycle.
 */
export function validateDag(
  tasks: readonly ParsedTask[],
  codeRepos: readonly string[],
): { tasks: DagTask[]; issues: DagIssue[] } {
  const issues: DagIssue[] = [];
  const ids = new Set<string>();
  for (const t of tasks) {
    if (ids.has(t.id)) issues.push({ task: t.id, message: `duplicate task id ${t.id}` });
    ids.add(t.id);
  }
  const valid: DagTask[] = [];
  for (const t of tasks) {
    const before = issues.length;
    if (t.repo === undefined) issues.push({ task: t.id, message: "missing `repo:` line" });
    else if (!codeRepos.includes(t.repo)) {
      issues.push({
        task: t.id,
        message: `unknown repo "${t.repo}" (known: ${codeRepos.join(", ")})`,
      });
    }
    if (t.deps === undefined)
      issues.push({ task: t.id, message: "missing `deps:` line (use `deps: none`)" });
    for (const dep of t.deps ?? []) {
      if (!ids.has(dep)) issues.push({ task: t.id, message: `unknown dependency ${dep}` });
      if (dep === t.id) issues.push({ task: t.id, message: "depends on itself" });
    }
    if (t.touches === undefined || t.touches.length === 0) {
      issues.push({ task: t.id, message: "missing `touches:` globs" });
    }
    for (const glob of t.touches ?? []) {
      if (glob.startsWith("/") || glob.split("/").includes("..")) {
        issues.push({ task: t.id, message: `touches glob "${glob}" must stay inside the repo` });
      }
      const syntax = globSyntaxError(glob);
      if (syntax !== undefined)
        issues.push({
          task: t.id,
          message: `touches glob "${glob}" is not a valid glob (${syntax})`,
        });
    }
    if (
      issues.length === before &&
      t.repo !== undefined &&
      t.deps !== undefined &&
      t.touches !== undefined
    ) {
      valid.push({ id: t.id, title: t.title, repo: t.repo, deps: t.deps, touches: t.touches });
    }
  }
  const cycle = findCycle(tasks.map((t) => ({ id: t.id, deps: t.deps ?? [] })));
  if (cycle) issues.push({ message: `dependency cycle: ${cycle.join(" → ")}` });
  return { tasks: valid, issues };
}

/** A cycle as a list of ids (first repeated at the end), or undefined. */
export function findCycle(
  nodes: readonly { id: string; deps: readonly string[] }[],
): string[] | undefined {
  const deps = new Map(nodes.map((n) => [n.id, n.deps]));
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  const visit = (id: string): string[] | undefined => {
    if (state.get(id) === "done") return undefined;
    if (state.get(id) === "visiting") return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, "visiting");
    stack.push(id);
    for (const dep of deps.get(id) ?? []) {
      if (!deps.has(dep)) continue;
      const found = visit(dep);
      if (found) return found;
    }
    stack.pop();
    state.set(id, "done");
    return undefined;
  };
  for (const n of nodes) {
    const found = visit(n.id);
    if (found) return found;
  }
  return undefined;
}

/** Every task that depends on `id`, directly or transitively. */
export interface ContractRef {
  readonly provider: string;
  readonly path: string;
  readonly consumers: readonly string[];
}

/**
 * Contract changes come first (§7): a consumer repo's task must depend, directly or not, on
 * every task that changes a contract it consumes. Enforced here, not only asked for in the
 * architect's prompt (audit G9).
 */
export function contractOrderIssues(
  tasks: readonly DagTask[],
  contracts: readonly ContractRef[],
): DagIssue[] {
  const issues: DagIssue[] = [];
  const ancestors = (id: string): Set<string> => {
    const out = new Set<string>();
    const queue = [id];
    while (queue.length > 0) {
      const next = queue.shift();
      const current = tasks.find((t) => t.id === next);
      for (const d of current?.deps ?? [])
        if (!out.has(d)) {
          out.add(d);
          queue.push(d);
        }
    }
    return out;
  };
  for (const c of contracts) {
    const changing = tasks.filter(
      (t) =>
        t.repo === c.provider &&
        t.touches.some((g) => globsOverlap(g, c.path) || matchGlob(g, c.path)),
    );
    if (changing.length === 0) continue;
    for (const t of tasks.filter((x) => c.consumers.includes(x.repo))) {
      const before = ancestors(t.id);
      const missing = changing.filter((x) => !before.has(x.id)).map((x) => x.id);
      if (missing.length > 0)
        issues.push({
          task: t.id,
          message: `consumes ${c.provider}:${c.path}, so it must depend on ${missing.join(", ")} (contract changes come first)`,
        });
    }
  }
  return issues;
}

export function dependentsOf(
  tasks: readonly { id: string; deps: readonly string[] }[],
  id: string,
): string[] {
  const out = new Set<string>();
  const queue = [id];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const t of tasks) {
      if (current !== undefined && t.deps.includes(current) && !out.has(t.id)) {
        out.add(t.id);
        queue.push(t.id);
      }
    }
  }
  return [...out];
}
