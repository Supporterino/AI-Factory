import type { SessionContext } from "../policy/scope.ts";

/**
 * The seam between the pipeline and the agent runtime (ADR-0009). The real implementation
 * drives a private `opencode serve`; tests use a scripted one.
 */

export interface Usage {
  readonly input: number;
  readonly output: number;
  readonly reasoning: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly cost: number;
}

export const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
};

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    reasoning: a.reasoning + b.reasoning,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    cost: a.cost + b.cost,
  };
}

/**
 * Live progress inside one agent session (opencode's event stream). It is display-only: the
 * pipeline never depends on it, and a runtime without an event stream simply emits none.
 */
export type SessionActivity =
  | { readonly kind: "step-started"; readonly model?: string }
  | { readonly kind: "tool"; readonly tool: string; readonly input?: unknown }
  | {
      readonly kind: "tool-done";
      readonly tool: string;
      readonly status: "ok" | "failed";
      readonly error?: string;
    }
  | { readonly kind: "step-done"; readonly usage: Usage }
  | { readonly kind: "retry"; readonly reason?: string };

export interface SessionSpec {
  /** opencode agent id, e.g. "implementer-backend". */
  readonly agent: string;
  /** "provider/model" from the config (the agent's frontmatter model is not applied by opencode). */
  readonly model: string;
  /** Plugin context; `sessionId` is filled in by the runtime. */
  readonly context: Omit<SessionContext, "sessionId">;
  readonly title: string;
  /** Progress for the terminal. Callbacks must be cheap and must not throw. */
  readonly onActivity?: (activity: SessionActivity) => void;
}

export interface Turn {
  /** Text of the final assistant message. */
  readonly text: string;
  readonly outcome: "succeeded" | "failed" | "interrupted";
  readonly error?: string;
  /** Usage of this turn only. */
  readonly usage: Usage;
}

export interface AgentSession {
  readonly id: string;
  /** Sends a message and waits until the agent is idle. */
  prompt(text: string, signal?: AbortSignal): Promise<Turn>;
}

export interface AgentRuntime {
  open(spec: SessionSpec): Promise<AgentSession>;
  /** Releases the runtime (stops the private server). */
  close(): Promise<void>;
}
