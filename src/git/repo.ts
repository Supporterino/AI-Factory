import { PreconditionError } from "../errors.ts";
import { git, gitOk } from "../exec.ts";

/** Change ids follow OpenSpec's rule (kebab-case). */
export const CHANGE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const changeBranch = (id: string): string => `change/${id}`;

/** Uncommitted paths (untracked included, ignored excluded). Empty means clean. */
export async function dirtyPaths(dir: string): Promise<string[]> {
  const res = await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: dir });
  if (res.code !== 0)
    throw new PreconditionError(`${dir} is not a git checkout`, [res.stderr.trim()]);
  return res.stdout
    .split("\0")
    .filter((e) => e.length > 3)
    .map((e) => e.slice(3));
}

export async function ensureClean(dir: string, what: string): Promise<void> {
  const dirty = await dirtyPaths(dir);
  if (dirty.length > 0) {
    throw new PreconditionError(`${what} has uncommitted changes`, [
      ...dirty.slice(0, 20),
      ...(dirty.length > 20 ? [`… and ${dirty.length - 20} more`] : []),
      "commit or stash them first",
    ]);
  }
}

export async function currentBranch(dir: string): Promise<string | undefined> {
  const out = (await git(["branch", "--show-current"], { cwd: dir })).stdout.trim();
  return out === "" ? undefined : out;
}

export async function refExists(dir: string, ref: string): Promise<boolean> {
  return (
    (await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd: dir })).code === 0
  );
}

export async function revParse(dir: string, ref: string): Promise<string> {
  return gitOk(["rev-parse", "--verify", `${ref}^{commit}`], { cwd: dir });
}

/** Local branch if present, else the origin tracking branch. */
export async function resolveBranchRef(dir: string, branch: string): Promise<string> {
  for (const ref of [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`]) {
    if (await refExists(dir, ref)) return ref;
  }
  throw new PreconditionError(`branch ${branch} not found in ${dir}`, [
    `set "defaultBranch" for this repo in factory.config.jsonc, or fetch it`,
  ]);
}
