import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { FactoryConfig, Language } from "../config/schema.ts";
import { PROFILES, type Profile } from "../profiles/index.ts";
import { writeJsonAtomic } from "../state/files.ts";

/**
 * Definitions a change runs on (§10): taken when it becomes active, so an `update --force`
 * in the middle does not change them.
 * - Agents: copied into `.factory/worktrees/<id>/.opencode/agents/`. opencode prefers the
 *   closest `.opencode/agents` to a session's directory (verified with 2.1.2), so every task
 *   session in the change's worktrees keeps its original prompts and permissions.
 * - Gates: the config's gate settings and every profile's gate table, in the run folder.
 */

export interface GateSnapshot {
  readonly factoryVersion: string;
  readonly gates: FactoryConfig["gates"];
  readonly tables: Record<Language, Profile["gates"]>;
}

const gateFile = (root: string, id: string): string =>
  join(root, ".factory", "runs", id, "snapshot", "gates.json");

export function snapshotDefinitions(
  root: string,
  id: string,
  config: FactoryConfig,
  factoryVersion: string,
): void {
  const agents = join(root, ".opencode", "agents");
  const target = join(root, ".factory", "worktrees", id, ".opencode", "agents");
  if (existsSync(agents) && !existsSync(target)) {
    mkdirSync(target, { recursive: true });
    cpSync(agents, target, { recursive: true });
  }
  if (!existsSync(gateFile(root, id))) {
    const tables = Object.fromEntries(
      (Object.keys(PROFILES) as Language[]).map((l) => [l, PROFILES[l].gates]),
    ) as Record<Language, Profile["gates"]>;
    writeJsonAtomic(gateFile(root, id), {
      factoryVersion,
      gates: config.gates,
      tables,
    } satisfies GateSnapshot);
  }
}

export function loadGateSnapshot(root: string, id: string): GateSnapshot | undefined {
  const file = gateFile(root, id);
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as GateSnapshot) : undefined;
}

/**
 * At close: drop the agent snapshot and the change's worktree folders once no task
 * worktree is left in them. The gate snapshot stays with the run as a record.
 */
export function dropAgentSnapshot(root: string, id: string): void {
  const dir = join(root, ".factory", "worktrees", id);
  rmSync(join(dir, ".opencode"), { recursive: true, force: true });
  if (!existsSync(dir)) return;
  for (const repo of readdirSync(dir)) {
    const repoDir = join(dir, repo);
    if (readdirSync(repoDir).length === 0) rmSync(repoDir, { recursive: true });
  }
  if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true });
}
