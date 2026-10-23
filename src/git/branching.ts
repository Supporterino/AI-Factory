import { existsSync } from "node:fs";
import { join } from "node:path";
import type { RepoConfig } from "../config/schema.ts";
import { PreconditionError } from "../errors.ts";
import { git, gitOk } from "../exec.ts";
import {
  changeBranch,
  currentBranch,
  ensureClean,
  refExists,
  resolveBranchRef,
  revParse,
} from "./repo.ts";

/**
 * Change branches (§7, steps 1 and 4): the same `change/<id>` in the AI repo and in every
 * touched submodule. Branching is idempotent so `resume` can call it again.
 */

export interface BranchResult {
  readonly repo: string;
  readonly branch: string;
  /** Commit the branch started from. */
  readonly base: string;
  /** False when the branch already existed (resume). */
  readonly created: boolean;
}

/** Switches `dir` to `branch`, creating it from `start` if needed. `dir` must be clean. */
async function switchToChangeBranch(
  dir: string,
  branch: string,
  start: string,
): Promise<{ created: boolean }> {
  if ((await currentBranch(dir)) === branch) return { created: false };
  if (await refExists(dir, `refs/heads/${branch}`)) {
    await gitOk(["switch", "-q", branch], { cwd: dir });
    return { created: false };
  }
  await gitOk(["switch", "-q", "-c", branch, start], { cwd: dir });
  return { created: true };
}

/** Step 1: the AI repo (or the single repo) branches first, from its current HEAD. */
export async function branchAiRepo(root: string, id: string): Promise<BranchResult> {
  await ensureClean(root, "the AI repo");
  const branch = changeBranch(id);
  const base = await revParse(root, "HEAD");
  const { created } = await switchToChangeBranch(root, branch, "HEAD");
  return { repo: ".", branch, base, created };
}

/** The branch `.gitmodules` tracks for a submodule path (`submodule.<name>.branch`), if any. */
export async function trackedBranch(root: string, path: string): Promise<string | undefined> {
  const names = await git(
    ["config", "--file", ".gitmodules", "--get-regexp", "^submodule\\..*\\.path$"],
    { cwd: root },
  );
  if (names.code !== 0) return undefined;
  for (const line of names.stdout.split("\n")) {
    const [key, value] = line.split(" ");
    if (value?.trim() !== path || key === undefined) continue;
    const name = key.slice("submodule.".length, -".path".length);
    const branch = await git(
      ["config", "--file", ".gitmodules", "--get", `submodule.${name}.branch`],
      {
        cwd: root,
      },
    );
    const value2 = branch.stdout.trim();
    // "." means "same name as the superproject's branch", which is not a usable start point.
    return branch.code === 0 && value2 !== "" && value2 !== "." ? value2 : undefined;
  }
  return undefined;
}

/**
 * Step 4: branch a submodule from its tracked branch (if `.gitmodules` sets one) or its
 * default branch. Works from a detached HEAD, the usual state of a submodule.
 */
export async function branchSubmodule(
  root: string,
  repo: RepoConfig,
  id: string,
): Promise<BranchResult> {
  const dir = join(root, repo.path);
  if (!existsSync(join(dir, ".git"))) {
    throw new PreconditionError(`submodule ${repo.path} is not initialised`, [
      `run \`git submodule update --init ${repo.path}\``,
    ]);
  }
  await ensureClean(dir, `submodule ${repo.path}`);
  const branch = changeBranch(id);
  const from = (await trackedBranch(root, repo.path)) ?? repo.defaultBranch ?? "main";
  const start = await resolveBranchRef(dir, from);
  const { created } = await switchToChangeBranch(dir, branch, start);
  // On resume the branch has moved on; its base is still where it left the start branch.
  const base = await gitOk(["merge-base", branch, start], { cwd: dir });
  return { repo: repo.name, branch, base, created };
}
