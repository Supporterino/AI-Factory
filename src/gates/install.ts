import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { RepoConfig } from "../config/schema.ts";
import { exec } from "../exec.ts";
import { profilesFor } from "../profiles/index.ts";
import { installDirs, worktreeFiles } from "./targets.ts";

/**
 * Worktree dependency installs (§9). Every new worktree installs from its lockfile; package
 * stores and build caches are shared under `.factory/cache/` so installs stay cheap.
 * Install time and failures never count against a task's retry budget.
 */

export function cacheEnv(root: string, repoName: string): Record<string, string> {
  const cache = join(root, ".factory", "cache");
  const env = {
    npm_config_cache: join(cache, "npm"),
    npm_config_store_dir: join(cache, "pnpm-store"),
    BUN_INSTALL_CACHE_DIR: join(cache, "bun"),
    YARN_CACHE_FOLDER: join(cache, "yarn"),
    UV_CACHE_DIR: join(cache, "uv"),
    GOMODCACHE: join(cache, "go", "mod"),
    GOCACHE: join(cache, "go", "build"),
    GOLANGCI_LINT_CACHE: join(cache, "golangci-lint"),
    CARGO_TARGET_DIR: join(cache, "cargo-target", repoName),
  };
  for (const dir of Object.values(env)) mkdirSync(dir, { recursive: true });
  return env;
}

/** Non-interactive, colourless env for installs and gates. */
export const QUIET_ENV: Readonly<Record<string, string>> = {
  CI: "1",
  NO_COLOR: "1",
  FORCE_COLOR: "0",
  TERM: "dumb",
};

export interface InstallStep {
  readonly dir: string;
  readonly command?: string;
  readonly status: "ok" | "failed" | "skipped";
  readonly detail?: string;
  readonly durationMs: number;
}

export async function installDeps(
  root: string,
  worktree: string,
  repo: RepoConfig,
  timeoutMs = 15 * 60_000,
): Promise<InstallStep[]> {
  const files = worktreeFiles(worktree);
  const env = { ...cacheEnv(root, repo.name), ...QUIET_ENV };
  const steps: InstallStep[] = [];
  const done = new Set<string>();
  for (const profile of profilesFor(repo.languages)) {
    for (const dir of installDirs(profile, files)) {
      const step = profile.install.find((s) => existsSync(join(worktree, dir, s.lockfile)));
      const key = `${dir}\0${step?.command ?? profile.id}`;
      if (done.has(key)) continue;
      done.add(key);
      if (step === undefined) {
        steps.push({
          dir,
          status: "skipped",
          detail: `no lockfile for ${profile.title} (${profile.install.map((s) => s.lockfile).join(", ")})`,
          durationMs: 0,
        });
        continue;
      }
      const res = await exec(["sh", "-c", step.command], {
        cwd: join(worktree, dir),
        env,
        timeoutMs,
      });
      steps.push({
        dir,
        command: step.command,
        status: res.code === 0 ? "ok" : "failed",
        ...(res.code === 0 ? {} : { detail: (res.stderr || res.stdout).trim().slice(-4000) }),
        durationMs: res.durationMs,
      });
    }
  }
  return steps;
}
