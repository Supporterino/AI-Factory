import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Handoff } from "../../src/handoff/schema.ts";
import type { AgentRuntime, AgentSession, SessionSpec, Turn } from "../../src/runtime/types.ts";

/**
 * A scripted agent runtime (ADR-0009): each prompt calls the script, which may edit files in
 * the session directory and returns a handoff. No opencode, no model.
 */

export interface ScriptCall {
  readonly sessionId: string;
  readonly agent: string;
  readonly spec: SessionSpec;
  readonly directory: string;
  readonly prompt: string;
  /** 1-based turn number within the session. */
  readonly turn: number;
}

export interface ScriptStep {
  /** Paths relative to the session directory; null deletes. */
  readonly edits?: Readonly<Record<string, string | null>>;
  readonly handoff?: Partial<Handoff>;
  /** Raw reply text instead of a handoff (to test repairs). */
  readonly text?: string;
  readonly outcome?: Turn["outcome"];
  readonly error?: string;
  readonly delayMs?: number;
}

export type Script = (call: ScriptCall) => ScriptStep | Promise<ScriptStep>;

export const USAGE_PER_TURN = {
  input: 1000,
  output: 100,
  reasoning: 0,
  cacheRead: 600,
  cacheWrite: 200,
  cost: 0.01,
} as const;

export class ScriptedRuntime implements AgentRuntime {
  readonly calls: ScriptCall[] = [];
  running = 0;
  maxRunning = 0;
  /** Max concurrent sessions per agent-name prefix (e.g. "implementer"). */
  readonly maxByAgent = new Map<string, number>();
  readonly #runningByAgent = new Map<string, number>();
  #next = 0;
  closed = false;

  constructor(readonly script: Script) {}

  async open(spec: SessionSpec): Promise<AgentSession> {
    const sessionId = `ses_test_${++this.#next}`;
    let turn = 0;
    return {
      id: sessionId,
      prompt: async (prompt) => {
        turn++;
        const call: ScriptCall = {
          sessionId,
          agent: spec.agent,
          spec,
          directory: spec.context.directory,
          prompt,
          turn,
        };
        this.calls.push(call);
        const kind = spec.agent.split("-")[0] ?? spec.agent;
        this.running++;
        this.#runningByAgent.set(kind, (this.#runningByAgent.get(kind) ?? 0) + 1);
        this.maxRunning = Math.max(this.maxRunning, this.running);
        this.maxByAgent.set(
          kind,
          Math.max(this.maxByAgent.get(kind) ?? 0, this.#runningByAgent.get(kind) ?? 0),
        );
        try {
          const step = await this.script(call);
          if (step.delayMs) await Bun.sleep(step.delayMs);
          for (const [rel, content] of Object.entries(step.edits ?? {})) {
            const abs = join(spec.context.directory, rel);
            if (content === null) rmSync(abs, { force: true });
            else {
              mkdirSync(dirname(abs), { recursive: true });
              writeFileSync(abs, content);
            }
          }
          const handoff: Handoff = {
            status: "done",
            task: "x",
            filesChanged: Object.keys(step.edits ?? {}),
            decisions: [],
            risks: [],
            openQuestions: [],
            ...step.handoff,
          };
          const text = step.text ?? `Done.\n\`\`\`json\n${JSON.stringify(handoff)}\n\`\`\``;
          return {
            text,
            outcome: step.outcome ?? "succeeded",
            usage: { ...USAGE_PER_TURN },
            ...(step.error ? { error: step.error } : {}),
          };
        } finally {
          this.running--;
          this.#runningByAgent.set(kind, (this.#runningByAgent.get(kind) ?? 1) - 1);
        }
      },
    };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
