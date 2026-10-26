import { describe, expect, test } from "bun:test";
import { TransientError } from "../src/errors.ts";
import { limited, RateLimiter } from "../src/runtime/rate-limit.ts";
import { type AgentSession, type Turn, ZERO_USAGE } from "../src/runtime/types.ts";

const usage = { ...ZERO_USAGE, input: 1, output: 1 };

function session(outcomes: Turn[]): AgentSession & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    id: "ses_1",
    prompts,
    async prompt(text) {
      prompts.push(text);
      return outcomes.shift() ?? { outcome: "succeeded", text: "ok", usage };
    },
  } as AgentSession & { prompts: string[] };
}

const limitedTurn: Turn = { text: "", outcome: "failed", error: "429 Too Many Requests", usage };

describe("rate limiter", () => {
  test("waits with exponential backoff, continues the session and sums usage", async () => {
    const sleeps: number[] = [];
    const limiter = new RateLimiter(async (ms) => {
      sleeps.push(ms);
    });
    const s = session([limitedTurn, limitedTurn]);
    const turn = await limited(s, limiter, "anthropic").prompt("do it");
    expect(turn.outcome).toBe("succeeded");
    expect(turn.usage.input).toBe(3);
    expect(s.prompts).toEqual([
      "do it",
      "Continue exactly where you stopped.",
      "Continue exactly where you stopped.",
    ]);
    expect(sleeps.length).toBe(2);
    expect(sleeps[1] ?? 0).toBeGreaterThan(sleeps[0] ?? 0);
  });

  test("other failures are returned as they are", async () => {
    const s = session([{ text: "", outcome: "failed", error: "model refused", usage }]);
    const turn = await limited(s, new RateLimiter(async () => {}), "anthropic").prompt("x");
    expect(turn).toMatchObject({ outcome: "failed", error: "model refused" });
  });

  test("a long outage is an infrastructure failure, not a failed attempt (audit P16)", async () => {
    const s = session(Array.from({ length: 20 }, () => limitedTurn));
    const prompt = limited(s, new RateLimiter(async () => {}), "anthropic", 3).prompt("x");
    await expect(prompt).rejects.toBeInstanceOf(TransientError);
    await expect(
      limited(session([limitedTurn]), new RateLimiter(async () => {}), "anthropic", 0).prompt("x"),
    ).rejects.toThrow("rate limited");
  });

  test("a wait ends when the signal aborts", async () => {
    const limiter = new RateLimiter();
    limiter.penalize("anthropic");
    limiter.penalize("anthropic"); // 4 s
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 20);
    await limiter.wait("anthropic", controller.signal);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
