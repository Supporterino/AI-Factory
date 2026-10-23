import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { gitOk } from "../exec.ts";

/**
 * Push blocking (ADR-0003). Layer 1 is the agent environment below; layer 3 is the local
 * `pre-push` hook, installed only where the hooks directory is untracked (inside .git).
 */

export const HOOK_MARKER = "# ai-factory-hook v1";
export const CHAINED_HOOK = "pre-push.ai-factory-chained";
/** Set in every agent process. The hook rejects pushes while it is present. */
export const AGENT_MARKER_ENV = "AI_FACTORY_AGENT";

export const PRE_PUSH_HOOK = `#!/bin/sh
${HOOK_MARKER} (installed by ai-factory; reinstalled by \`ai-factory init\`, checked by \`doctor\`)
# Agents run with ${AGENT_MARKER_ENV} set while a change is active; they must never push.
if [ -n "$${AGENT_MARKER_ENV}" ]; then
  echo "ai-factory: pushes are blocked for agents while a change is active" >&2
  exit 1
fi
# A pre-push hook that existed before ai-factory was installed still runs.
chained="$(dirname "$0")/${CHAINED_HOOK}"
if [ -x "$chained" ]; then
  exec "$chained" "$@"
fi
exit 0
`;

export type HookStatus =
  | { status: "installed" | "updated" | "unchanged" | "chained"; path: string }
  | { status: "skipped"; reason: string };

async function hooksDir(repoDir: string): Promise<{ hooks: string; common: string }> {
  const [hooks, common] = (
    await gitOk(
      ["rev-parse", "--path-format=absolute", "--git-path", "hooks", "--git-common-dir"],
      {
        cwd: repoDir,
      },
    )
  ).split("\n");
  if (hooks === undefined || common === undefined)
    throw new Error(`cannot resolve hooks for ${repoDir}`);
  return { hooks, common };
}

/** Installs (or refreshes) the factory's pre-push hook in one repo. Never touches tracked files. */
export async function installPrePush(repoDir: string): Promise<HookStatus> {
  if (!existsSync(join(repoDir, ".git"))) {
    return { status: "skipped", reason: "not a checked-out git repository" };
  }
  const { hooks, common } = await hooksDir(repoDir);
  const rel = relative(common, hooks);
  if (rel.startsWith("..") || rel.startsWith("/")) {
    return {
      status: "skipped",
      reason: `core.hooksPath points outside .git (${hooks}); agents are still blocked by the git environment`,
    };
  }
  mkdirSync(hooks, { recursive: true });
  const path = join(hooks, "pre-push");
  let status: "installed" | "updated" | "unchanged" | "chained" = "installed";
  if (existsSync(path)) {
    const current = readFileSync(path, "utf8");
    if (current === PRE_PUSH_HOOK) return { status: "unchanged", path };
    if (current.includes(HOOK_MARKER)) {
      status = "updated";
    } else {
      const chained = join(hooks, CHAINED_HOOK);
      if (existsSync(chained)) {
        return {
          status: "skipped",
          reason: `both pre-push and ${CHAINED_HOOK} exist; resolve by hand`,
        };
      }
      renameSync(path, chained);
      status = "chained";
    }
  }
  writeFileSync(path, PRE_PUSH_HOOK);
  chmodSync(path, 0o755);
  return { status, path };
}

/** True when the repo's pre-push hook is the factory's current hook. */
export async function prePushInstalled(repoDir: string): Promise<boolean> {
  if (!existsSync(join(repoDir, ".git"))) return false;
  const { hooks } = await hooksDir(repoDir);
  const path = join(hooks, "pre-push");
  return existsSync(path) && readFileSync(path, "utf8") === PRE_PUSH_HOOK;
}

/**
 * Environment for agent processes. Adds the hook marker and rewrites every push URL to an
 * unknown transport, so `git push` fails even with `--no-verify` (verified with git 2.54);
 * fetch is unaffected. Existing GIT_CONFIG_COUNT entries are preserved.
 */
export function agentGitEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const count = Number.parseInt(base.GIT_CONFIG_COUNT ?? "0", 10) || 0;
  return {
    [AGENT_MARKER_ENV]: "1",
    GIT_CONFIG_COUNT: String(count + 1),
    [`GIT_CONFIG_KEY_${count}`]: "url.ai-factory-push-blocked://.pushInsteadOf",
    [`GIT_CONFIG_VALUE_${count}`]: "",
    GIT_TERMINAL_PROMPT: "0",
  };
}
