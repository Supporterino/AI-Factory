import { TransientError } from "../errors.ts";
import type { AgentSession, Turn } from "./types.ts";
import { addUsage } from "./types.ts";

/**
 * Shared per-provider limiter (§11): a rate-limit or overload error makes every session of
 * that provider wait with exponential backoff. Waiting never counts as a retry, and an outage
 * longer than the waits is an infrastructure failure, not a failed attempt (audit P16).
 */

/** A sleep that ends early when the signal aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

export const RATE_LIMITED = /\b(429|rate.?limit(ed)?|overloaded|too many requests|529)\b/i;

export class RateLimiter {
  readonly #until = new Map<string, number>();
  readonly #backoff = new Map<string, number>();
  readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(sleeper: (ms: number, signal?: AbortSignal) => Promise<void> = sleep) {
    this.#sleep = sleeper;
  }

  async wait(provider: string, signal?: AbortSignal): Promise<void> {
    const until = this.#until.get(provider) ?? 0;
    const delay = until - Date.now();
    if (delay > 0) await this.#sleep(delay, signal);
  }

  penalize(provider: string): number {
    const next = Math.min((this.#backoff.get(provider) ?? 1000) * 2, 120_000);
    this.#backoff.set(provider, next);
    this.#until.set(provider, Date.now() + next);
    return next;
  }

  ok(provider: string): void {
    this.#backoff.delete(provider);
  }
}

/** A session whose prompts wait on the limiter and resume after rate-limit failures. */
export function limited(
  session: AgentSession,
  limiter: RateLimiter,
  provider: string,
  maxWaits = 8,
): AgentSession {
  return {
    id: session.id,
    async prompt(text, signal) {
      let message = text;
      let total: Turn | undefined;
      for (let i = 0; ; i++) {
        await limiter.wait(provider, signal);
        const turn = await session.prompt(message, signal);
        total = total ? { ...turn, usage: addUsage(total.usage, turn.usage) } : turn;
        if (turn.outcome === "failed" && RATE_LIMITED.test(turn.error ?? "")) {
          if (i >= maxWaits)
            throw new TransientError(
              `rate limited by ${provider} after ${maxWaits} waits (${turn.error ?? ""})`,
            );
          limiter.penalize(provider);
          message = "Continue exactly where you stopped.";
          continue;
        }
        limiter.ok(provider);
        return total;
      }
    },
  };
}
