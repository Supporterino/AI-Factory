import type { Finding } from "../../src/handoff/schema.ts";
import type { Script, ScriptCall, ScriptStep } from "./scripted-runtime.ts";

/** A scripted "team" of agents for one change, used by the pipeline tests. */

export interface ScriptedTask {
  readonly id: string;
  readonly title: string;
  readonly repo: string;
  readonly deps: readonly string[];
  readonly touches: readonly string[];
  /** File the implementer writes, relative to the repo. */
  readonly file: string;
  readonly content: string;
}

export interface ScriptOptions {
  readonly changeId: string;
  readonly summary: string;
  readonly repos: readonly string[];
  readonly tasks: readonly ScriptedTask[];
  /** Delay of implementer sessions, to observe concurrency. */
  readonly delayMs?: number;
  /** Per-task override of the implementer step; return undefined for the default. */
  readonly implement?: (task: ScriptedTask, call: ScriptCall) => ScriptStep | undefined;
  readonly findings?: Readonly<Record<string, Finding[]>>;
  /** Test file the tester writes per repo (relative to the repo). */
  readonly testFiles?: Readonly<Record<string, string>>;
  readonly onCall?: (call: ScriptCall) => void | Promise<void>;
}

export function tasksMd(tasks: readonly ScriptedTask[]): string {
  const repos = [...new Set(tasks.map((t) => t.repo))];
  return repos
    .map((repo, i) => {
      const lines = tasks
        .filter((t) => t.repo === repo)
        .map(
          (t) =>
            `- [ ] ${t.id} ${t.title}\n  - repo: ${t.repo}\n  - deps: ${t.deps.length > 0 ? t.deps.join(", ") : "none"}\n  - touches: ${t.touches.join(", ")}`,
        );
      return `## ${i + 1}. ${repo}\n\n${lines.join("\n")}\n`;
    })
    .join("\n");
}

export function specFiles(id: string, tasks: readonly ScriptedTask[]): Record<string, string> {
  const base = `openspec/changes/${id}`;
  return {
    [`${base}/proposal.md`]:
      "## Why\nOperators need a health endpoint for load-balancer probes, and the UI should show it.\n\n## What Changes\n- Add GET /health\n- Show the health status\n\n## Impact\n- Repos and contracts as in tasks.md\n",
    [`${base}/design.md`]:
      "## Context\nSmall change.\n\n## Decisions\n- Reuse the existing HTTP server.\n",
    [`${base}/specs/health/spec.md`]:
      "## ADDED Requirements\n\n### Requirement: Health endpoint\nThe service SHALL expose GET /health returning 200 with status ok.\n\n#### Scenario: Healthy service\n- **WHEN** a client calls GET /health\n- **THEN** the response is 200 with body status ok\n",
    [`${base}/tasks.md`]: tasksMd(tasks),
  };
}

export function factoryScript(opts: ScriptOptions): Script {
  return async (call) => {
    await opts.onCall?.(call);
    const { agent, prompt } = call;
    if (agent === "orchestrator") {
      return {
        handoff: {
          task: "intake",
          decisions: [
            `change-id: ${opts.changeId}`,
            `summary: ${opts.summary}`,
            `repos: ${opts.repos.join(", ")}`,
          ],
        },
      };
    }
    if (agent === "explorer") {
      return {
        handoff: {
          task: "explore",
          decisions: ["entry point: main.go::main", "no health handler yet"],
        },
      };
    }
    if (agent === "architect") {
      if (prompt.startsWith("Write the OpenSpec change")) {
        return { edits: specFiles(opts.changeId, opts.tasks), handoff: { task: "design" } };
      }
      if (prompt.includes("Write one context pack")) {
        const ids = [...prompt.matchAll(/^- (\S+) \[/gm)].map((m) => m[1] ?? "");
        const edits = Object.fromEntries(
          ids.map((tid) => {
            const t = opts.tasks.find((x) => x.id === tid);
            return [
              `.factory/context/${opts.changeId}/${tid}.md`,
              `## Task ${tid}\n${t?.title ?? ""}\nTarget: ${t?.file ?? ""}\n`,
            ];
          }),
        );
        return { edits, handoff: { task: "context-packs" } };
      }
      return { handoff: { task: "design" } };
    }
    if (agent.startsWith("implementer-")) {
      if (prompt.includes("has merge conflicts")) return { handoff: { task: "conflict" } };
      const tid = prompt.match(/^Task (\S+):/)?.[1] ?? "";
      const task = opts.tasks.find((t) => t.id === tid);
      if (task === undefined) return { handoff: { task: tid } };
      const override = opts.implement?.(task, call);
      if (override) return override;
      return {
        delayMs: opts.delayMs ?? 0,
        edits: { [task.file]: task.content },
        handoff: { task: tid },
      };
    }
    if (agent === "reviewer") {
      const repo = call.spec.context.repo ?? "";
      return { handoff: { task: `review:${repo}`, findings: opts.findings?.[repo] ?? [] } };
    }
    if (agent === "tester") {
      const repo = call.spec.context.repo ?? "";
      const file = opts.testFiles?.[repo];
      return {
        ...(file ? { edits: { [file]: "// scenario: Healthy service\n" } } : {}),
        handoff: { task: `test-${repo}` },
      };
    }
    return { handoff: {} };
  };
}
