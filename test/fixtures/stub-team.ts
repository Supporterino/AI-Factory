import type { Finding } from "../../src/handoff/schema.ts";
import type { StubRequest, StubStep } from "./stub-model.ts";

/**
 * A role-aware scripted model for end-to-end runs through the real opencode server: it
 * reads the agent's role from the system prompt and the instruction from the latest user
 * message, then replays tool calls (writes, a probe shell command) and ends with a handoff.
 * Stateless: the next step is the number of tool results since that user message.
 */

export interface TeamPlan {
  readonly changeId: string;
  readonly summary: string;
  readonly repos: readonly string[];
  /** Files the architect writes, relative to its session directory. */
  readonly spec: Readonly<Record<string, string>>;
  /** Task id → files the implementer writes (repo-relative). */
  readonly tasks: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** Repo → test files the tester writes. */
  readonly tests?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** Repo → review findings. */
  readonly findings?: Readonly<Record<string, Finding[]>>;
  /** Shell commands an implementer tries first (to show the guard), per task id. */
  readonly probes?: Readonly<Record<string, readonly string[]>>;
}

interface Part {
  readonly type?: string;
  readonly text?: string;
}

const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? (content as Part[])
          .filter((p) => p.type === "text")
          .map((p) => p.text ?? "")
          .join("\n")
      : "";

function current(req: StubRequest): { prompt: string; done: number } {
  const messages = (req.messages ?? []) as { role?: string; content?: unknown }[];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "user" || textOf(m.content).trim() === "") continue;
    let done = 0;
    for (const later of messages.slice(i + 1)) {
      if (Array.isArray(later.content))
        done += (later.content as Part[]).filter((p) => p.type === "tool_result").length;
    }
    return { prompt: textOf(m.content), done };
  }
  return { prompt: "", done: 0 };
}

function handoff(
  task: string,
  files: readonly string[],
  extra: Record<string, unknown> = {},
): StubStep {
  const body = {
    status: "done",
    task,
    filesChanged: [...files],
    decisions: [],
    risks: [],
    openQuestions: [],
    ...extra,
  };
  return { text: `Done.\n\n\`\`\`json\n${JSON.stringify(body)}\n\`\`\`` };
}

/** Writes `files` one per step, then the handoff. */
function writeThen(
  done: number,
  files: Readonly<Record<string, string>>,
  task: string,
  extra?: Record<string, unknown>,
  before: readonly string[] = [],
): StubStep {
  if (done < before.length) return { tool: "shell", input: { command: before[done] } };
  const entries = Object.entries(files);
  const i = done - before.length;
  const entry = entries[i];
  if (entry !== undefined) return { tool: "write", input: { path: entry[0], content: entry[1] } };
  return handoff(task, Object.keys(files), extra);
}

export function stubTeam(plan: TeamPlan): (req: StubRequest) => StubStep {
  return (req) => {
    const system = textOf(req.system);
    const role = system.match(/^# Role: ([^\n]+)/m)?.[1] ?? "";
    const { prompt, done } = current(req);

    if (role.startsWith("orchestrator")) {
      return handoff("intake", [], {
        decisions: [
          `change-id: ${plan.changeId}`,
          `summary: ${plan.summary}`,
          `repos: ${plan.repos.join(", ")}`,
        ],
      });
    }
    if (role.startsWith("explorer")) {
      const repo = prompt.match(/^Map repo `([^`]+)`/)?.[1] ?? "?";
      return handoff(`explore:${repo}`, [], {
        decisions: [`${repo}: entry points mapped from the graph`],
      });
    }
    if (role.startsWith("architect")) {
      if (prompt.startsWith("Write the OpenSpec change"))
        return writeThen(done, plan.spec, "design");
      if (prompt.includes("Write one context pack")) {
        const ids = [...prompt.matchAll(/^- (\S+) \[/gm)].map((m) => m[1] ?? "");
        const packs = Object.fromEntries(
          ids.map((id) => [
            `.factory/context/${plan.changeId}/${id}.md`,
            `## Task ${id}\nFiles: ${Object.keys(plan.tasks[id] ?? {}).join(", ") || "see tasks.md"}\nFollow the spec scenarios; keep the change minimal.\n`,
          ]),
        );
        return writeThen(done, packs, "context-packs");
      }
      return handoff("design", []);
    }
    if (role.startsWith("implementer")) {
      const id = prompt.match(/^(?:Your task |Task )(\S+?)[: ]/)?.[1] ?? "?";
      if (prompt.includes("has merge conflicts")) return handoff(id, []);
      return writeThen(done, plan.tasks[id] ?? {}, id, undefined, plan.probes?.[id] ?? []);
    }
    if (role.startsWith("tester")) {
      const id = prompt.match(/^Task (\S+):/)?.[1] ?? "?";
      const repo = prompt.match(/concerns repo `([^`]+)`/)?.[1] ?? "";
      const files = plan.tests?.[repo] ?? {};
      return writeThen(done, files, id, {
        decisions: Object.keys(files).map((f) => `scenarios covered in ${f}`),
      });
    }
    if (role.startsWith("reviewer")) {
      const repo = prompt.match(/^Review repo `([^`]+)`/)?.[1] ?? "";
      return handoff(`review:${repo}`, [], { findings: plan.findings?.[repo] ?? [] });
    }
    if (role.startsWith("contract reviewer"))
      return handoff("contract-review", [], { findings: [] });
    return handoff("unknown", []);
  };
}
