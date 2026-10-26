import { describe, expect, test } from "bun:test";
import { extractHandoff, promptForHandoff } from "../src/runtime/handoff.ts";
import { type AgentSession, type Turn, ZERO_USAGE } from "../src/runtime/types.ts";

const usage = { ...ZERO_USAGE, input: 10 };
const valid =
  '```json\n{"status":"done","task":"1.1","filesChanged":[],"decisions":[],"risks":[],"openQuestions":[]}\n```';

function session(replies: string[]): AgentSession & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    id: "s",
    prompts,
    async prompt(text): Promise<Turn> {
      prompts.push(text);
      return { text: replies.shift() ?? "", outcome: "succeeded", usage };
    },
  } as AgentSession & { prompts: string[] };
}

describe("handoff parsing and repair (audit T)", () => {
  test("the last json block counts; missing, broken and invalid blocks say why", () => {
    expect(extractHandoff(`text\n${valid}`)).toMatchObject({ ok: true, handoff: { task: "1.1" } });
    expect(extractHandoff("no block")).toMatchObject({ ok: false });
    expect(extractHandoff("```json\n{oops\n```")).toMatchObject({
      ok: false,
      problem: expect.stringContaining("does not parse"),
    });
    expect(extractHandoff('```json\n{"status":"maybe"}\n```')).toMatchObject({
      ok: false,
      problem: expect.stringContaining("status"),
    });
  });

  test("one repair prompt; usage of both turns is summed", async () => {
    const s = session(["I am done.", valid]);
    const turn = await promptForHandoff(s, "do it");
    expect(turn.handoff?.task).toBe("1.1");
    expect(s.prompts).toHaveLength(2);
    expect(s.prompts[1]).toStartWith("Your handoff is invalid");
    expect(turn.usage.input).toBe(20);
  });

  test("a second invalid reply ends without a handoff, and no third prompt", async () => {
    const s = session(["nope", "still nope", valid]);
    const turn = await promptForHandoff(s, "do it");
    expect(turn.handoff).toBeUndefined();
    expect(turn.problem).toContain("invalid handoff after one repair");
    expect(s.prompts).toHaveLength(2);
  });
});
