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
