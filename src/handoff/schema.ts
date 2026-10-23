import { z } from "zod";

/**
 * The JSON every agent ends with (§11). `.opencode/schemas/handoff.schema.json` is generated
 * from this schema; this file is the source of truth.
 */
export const Finding = z.strictObject({
  severity: z.enum(["must", "should", "nice"]),
  /** Repo-relative path and 1-based line, when the finding points at code. */
  file: z.string().optional(),
  line: z.int().min(1).optional(),
  /** What the code does. */
  what: z.string().min(1),
  /** What goes wrong. */
  problem: z.string().min(1),
  fix: z.string().min(1),
  /** The impact if the fix is skipped. */
  impact: z.string().min(1),
});
export type Finding = z.infer<typeof Finding>;

export const Handoff = z.strictObject({
  status: z.enum(["done", "blocked", "failed"]),
  /** The task id ("1.2"), or the role's step name for non-task agents ("intake", "review"). */
  task: z.string().min(1),
  filesChanged: z.array(z.string()),
  decisions: z.array(z.string()),
  /** Includes what was skipped or not checked. */
  risks: z.array(z.string()),
  openQuestions: z.array(z.string()),
  findings: z.array(Finding).optional(),
});
export type Handoff = z.infer<typeof Handoff>;

/** JSON Schema rendered into the workspace. */
export function handoffJsonSchema(): string {
  const schema = z.toJSONSchema(Handoff, { target: "draft-2020-12" });
  return `${JSON.stringify({ $id: "ai-factory/handoff.schema.json", title: "Agent handoff", ...schema }, null, 2)}\n`;
}
