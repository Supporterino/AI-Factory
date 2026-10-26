import type { z } from "zod";
import { Handoff } from "../handoff/schema.ts";
import { type AgentSession, addUsage, type Usage, ZERO_USAGE } from "./types.ts";

/**
 * Handoffs (§11): every agent ends with a JSON block validated against the handoff schema.
 * An invalid one gets exactly one repair prompt, which never counts against a retry budget.
 */

const FENCED = /```json\s*\n([\s\S]*?)\n?```/g;

export type HandoffParse = { ok: true; handoff: Handoff } | { ok: false; problem: string };

export function extractHandoff(text: string): HandoffParse {
  const blocks = [...text.matchAll(FENCED)].map((m) => m[1] ?? "");
  const brace = text.lastIndexOf("{");
  const candidate = blocks.at(-1) ?? (brace === -1 ? "" : text.slice(brace));
  if (candidate.trim() === "")
    return { ok: false, problem: "no ```json block found at the end of your reply" };
  let value: unknown;
  try {
    value = JSON.parse(candidate);
  } catch (err) {
    return { ok: false, problem: `the JSON block does not parse: ${(err as Error).message}` };
  }
  const parsed = Handoff.safeParse(value);
  if (!parsed.success) return { ok: false, problem: issues(parsed.error) };
  return { ok: true, handoff: parsed.data };
}

function issues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}

export interface HandoffTurn {
  readonly handoff?: Handoff;
  /** Why no valid handoff was obtained (after the repair attempt), or the session error. */
  readonly problem?: string;
  readonly outcome: "succeeded" | "failed" | "interrupted";
  readonly usage: Usage;
  readonly text: string;
}

/** Prompts, then asks once for a corrected handoff if needed. */
export async function promptForHandoff(
  session: AgentSession,
  prompt: string,
  signal?: AbortSignal,
): Promise<HandoffTurn> {
  const first = await session.prompt(prompt, signal);
  if (first.outcome !== "succeeded") {
    return {
      outcome: first.outcome,
      usage: first.usage,
      text: first.text,
      problem: first.error ?? first.outcome,
    };
  }
  const parsed = extractHandoff(first.text);
  if (parsed.ok)
    return { handoff: parsed.handoff, outcome: "succeeded", usage: first.usage, text: first.text };

  const repair = await session.prompt(
    `Your handoff is invalid: ${parsed.problem}. Reply with only the corrected \`\`\`json block (schema: .opencode/schemas/handoff.schema.json). Do not change any files.`,
    signal,
  );
  const usage = addUsage(first.usage, repair.usage ?? ZERO_USAGE);
  const second = repair.outcome === "succeeded" ? extractHandoff(repair.text) : undefined;
  if (second?.ok)
    return { handoff: second.handoff, outcome: "succeeded", usage, text: repair.text };
  return {
    outcome: repair.outcome,
    usage,
    text: repair.text,
    problem: `invalid handoff after one repair: ${second && !second.ok ? second.problem : (repair.error ?? repair.outcome)}`,
  };
}

/** `key: value` lines from a handoff's decisions (orchestrator intake format). */
export function decisionValues(handoff: Handoff): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of handoff.decisions) {
    const m = line.match(/^\s*([a-z][a-z-]*)\s*:\s*(.+)$/i);
    if (m?.[1] && m[2]) out.set(m[1].toLowerCase(), m[2].trim());
  }
  return out;
}
