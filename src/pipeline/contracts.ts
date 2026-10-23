import type { Pipeline } from "./context.ts";

/**
 * §7 step 9: the deterministic contract gate plus one cross-repo contract review. Slice 8
 * implements both; until then the step reports what it would check and passes.
 */
export async function contractPhase(
  p: Pipeline,
  id: string,
): Promise<{ ok: boolean; issues: string[] }> {
  const touched = new Set(p.run(id).tasks.map((t) => t.repo));
  const relevant = p.config.contracts.filter(
    (c) => touched.has(c.provider) || c.consumers.some((x) => touched.has(x)),
  );
  p.out(
    relevant.length === 0
      ? "▶ contracts: none touched"
      : `▶ contracts: ${relevant.length} touched (gate arrives in slice 8)`,
  );
  return { ok: true, issues: [] };
}
