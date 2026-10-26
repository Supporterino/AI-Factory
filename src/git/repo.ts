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

/**
 * The newer of the local branch and its origin tracking branch (audit P20): a local branch the
 * user never pulled must not become a change's base. When they diverged, the local one wins.
 * `fetch` refreshes the tracking branch first (best effort: offline, the refs as they are).
 */
export async function resolveBranchRef(
  dir: string,
  branch: string,
  options: { fetch?: boolean } = {},
): Promise<string> {
  if (options.fetch === true) {
    await git(["fetch", "--quiet", "--no-tags", "origin", branch], {
      cwd: dir,
      env: { GIT_TERMINAL_PROMPT: "0" },
      timeoutMs: 60_000,
    });
  }
  const local = `refs/heads/${branch}`;
  const remote = `refs/remotes/origin/${branch}`;
  const hasLocal = await refExists(dir, local);
  const hasRemote = await refExists(dir, remote);
  if (hasLocal && hasRemote) {
    const behind = await git(["merge-base", "--is-ancestor", local, remote], { cwd: dir });
    return behind.code === 0 ? remote : local;
  }
  if (hasLocal) return local;
  if (hasRemote) return remote;
  throw new PreconditionError(`branch ${branch} not found in ${dir}`, [
    `set "defaultBranch" for this repo in factory.config.jsonc, or fetch it`,
  ]);
}
