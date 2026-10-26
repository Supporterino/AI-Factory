import type { FactoryConfig } from "../config/schema.ts";
import { opencodeGlobRegExp } from "./glob.ts";

export interface RoutedAgent {
  readonly agent: string;
  readonly role: "implementer";
  readonly custom: boolean;
}

/**
 * Picks the agent for one task. Custom agents win only when their phase is `implementer`
 * and one of their `routing.paths` overlaps the task's `touches` globs.
 */
export function agentForTask(
  config: FactoryConfig,
  repo: string,
  touches: readonly string[],
): RoutedAgent {
  for (const rule of config.routing) {
    const agent = config.agents.find((a) => a.id === rule.agent);
    if (agent === undefined || agent.phase !== "implementer") continue;
    const hit = rule.paths.some((path) =>
      touches.some((touch) => {
        try {
          return opencodeGlobRegExp(path).test(touch) || opencodeGlobRegExp(touch).test(path);
        } catch {
          return false;
        }
      }),
    );
    if (hit) return { agent: agent.id, role: "implementer", custom: true };
  }
  return { agent: `implementer-${repo}`, role: "implementer", custom: false };
}
