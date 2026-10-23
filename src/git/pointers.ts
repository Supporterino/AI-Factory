import { join } from "node:path";
import type { FactoryConfig, RepoConfig } from "../config/schema.ts";
import { PreconditionError } from "../errors.ts";
import { exec, git, gitOk } from "../exec.ts";
import { trackedBranch } from "./branching.ts";
import { commitPaths } from "./commit.ts";
import { dirtyPaths, ensureClean, refExists } from "./repo.ts";

/**
 * Submodule pointers (§7 step 11, ADR-0012). At close, the AI repo commits the submodules'
 * `change/<id>` tips as provisional pointers. After the user's MRs merge upstream,
 * `repoint` finds the merged commits and commits the real pointers.
 */

export const PROVISIONAL_SUBJECT = (id: string): string =>
  `chore(submodules): bump for ${id} [provisional]`;

export interface Pointer {
  readonly path: string;
  readonly from: string;
  readonly to: string;
}

/** Commits the current HEADs of `repos` as provisional pointers. Undefined if nothing moved. */
export async function bumpPointers(
  root: string,
  id: string,
  repos: readonly RepoConfig[],
): Promise<{ commit: string; pointers: Pointer[] } | undefined> {
  const paths = repos.map((r) => r.path);
  const commit = await commitPaths(root, paths, PROVISIONAL_SUBJECT(id), { "Change-Id": id });
  if (commit === undefined) return undefined;
  return { commit, pointers: await pointersOf(root, commit) };
}

/** Gitlink changes made by one commit. */
async function pointersOf(root: string, commit: string): Promise<Pointer[]> {
  const out = await gitOk(["diff-tree", "--no-commit-id", "-r", commit], { cwd: root });
  return out
    .split("\n")
    .filter((l) => l.startsWith(":160000 160000 "))
    .map((l) => {
      const [meta, path] = l.split("\t");
      const [, , from, to] = (meta ?? "").split(" ");
      return { path: path ?? "", from: from ?? "", to: to ?? "" };
    });
}

/** The provisional bump commit of a change (newest, across all local branches). */
export async function findProvisionalBump(
  root: string,
  id: string,
): Promise<{ commit: string; pointers: Pointer[] } | undefined> {
  const out = await gitOk(
    ["log", "--all", "--format=%H", "--fixed-strings", `--grep=${PROVISIONAL_SUBJECT(id)}`],
    { cwd: root },
  );
  const commit = out.split("\n")[0];
  if (commit === undefined || commit === "") return undefined;
  return { commit, pointers: await pointersOf(root, commit) };
}

export type RepointMethod = "fast-forward" | "merge-commit" | "trailer" | "patch-id";

export type RepointResult =
  | {
      repo: string;
      path: string;
      status: "repointed" | "already-merged";
      method: RepointMethod;
      from: string;
      to: string;
    }
  | {
      repo: string;
      path: string;
      status: "not-merged" | "ambiguous" | "skipped" | "fetch-failed";
      from: string;
      detail: string;
    };

async function patchId(dir: string, args: readonly string[]): Promise<string | undefined> {
  const diff = await gitOk(args, { cwd: dir });
  if (diff === "") return undefined;
  const res = await exec(["git", "patch-id", "--stable"], { cwd: dir, input: `${diff}\n` });
  return res.stdout.trim().split(" ")[0] || undefined;
}

const MAX_CANDIDATES = 500;

/** True when `commit` is `ancestor` or descends from it. */
async function contains(dir: string, commit: string, ancestor: string): Promise<boolean> {
  return (await git(["merge-base", "--is-ancestor", ancestor, commit], { cwd: dir })).code === 0;
}

/**
 * Where did `tip` land on `upstream`? If upstream contains `tip`: the mainline commit that
 * brought it in (`tip` itself for a fast-forward, else the merge commit). Otherwise the
 * newest mainline commit with the `Change-Id` trailer (rebase merge), then the one commit
 * with the same patch-id as the whole change (squash merge).
 */
export async function findMerged(
  dir: string,
  id: string,
  tip: string,
  upstream: string,
): Promise<
  { sha: string; method: RepointMethod } | { error: "not-merged" | "ambiguous"; detail: string }
> {
  if (await contains(dir, upstream, tip)) {
    // Walk the mainline back to the first commit that brought `tip` in.
    const mainline = (
      await gitOk(["rev-list", "--first-parent", `--max-count=${MAX_CANDIDATES}`, upstream], {
        cwd: dir,
      })
    )
      .split("\n")
      .filter(Boolean);
    let point = upstream;
    for (const sha of mainline) {
      if (!(await contains(dir, sha, tip))) break;
      point = sha;
    }
    return point === tip
      ? { sha: tip, method: "fast-forward" }
      : { sha: point, method: "merge-commit" };
  }
  const base = await gitOk(["merge-base", tip, upstream], { cwd: dir });
  const range = `${base}..${upstream}`;

  const trailer = await gitOk(
    [
      "log",
      "--first-parent",
      "--format=%H",
      "--extended-regexp",
      `--grep=^Change-Id: ${id}$`,
      range,
    ],
    { cwd: dir },
  );
  const newest = trailer.split("\n")[0];
  if (newest) return { sha: newest, method: "trailer" };

  const wanted = await patchId(dir, ["diff", base, tip]);
  if (wanted === undefined) return { error: "not-merged", detail: "the change has no diff" };
  const candidates = (
    await gitOk(["rev-list", "--no-merges", "--first-parent", range], { cwd: dir })
  )
    .split("\n")
    .filter(Boolean)
    .slice(0, MAX_CANDIDATES);
  const matches: string[] = [];
  for (const sha of candidates) {
    if ((await patchId(dir, ["show", "--format=", sha])) === wanted) matches.push(sha);
  }
  if (matches.length === 1 && matches[0]) return { sha: matches[0], method: "patch-id" };
  if (matches.length > 1) {
    return {
      error: "ambiguous",
      detail: `several commits match the change: ${matches.map((m) => m.slice(0, 12)).join(", ")}`,
    };
  }
  return { error: "not-merged", detail: `no commit on ${upstream} contains the change yet` };
}

export interface RepointOutcome {
  readonly commit?: string;
  readonly results: RepointResult[];
}

/**
 * `ai-factory repoint <id>`: fetch each submodule, find where its change merged upstream and
 * commit the new pointers in the AI repo. Pointers whose MR has not merged stay provisional.
 */
export async function repoint(
  root: string,
  config: FactoryConfig,
  id: string,
): Promise<RepointOutcome> {
  if (config.layout === "single") {
    throw new PreconditionError("repoint only applies to the submodules layout");
  }
  const bump = await findProvisionalBump(root, id);
  if (bump === undefined)
    throw new PreconditionError(`no provisional pointer bump found for ${id}`);
  await ensureClean(root, "the AI repo");

  const results: RepointResult[] = [];
  const staged: string[] = [];
  for (const pointer of bump.pointers) {
    const repo = config.repos.find((r) => r.path === pointer.path);
    const name = repo?.name ?? pointer.path;
    const dir = join(root, pointer.path);
    const base = { repo: name, path: pointer.path, from: pointer.to };

    const current = (await git(["rev-parse", `HEAD:${pointer.path}`], { cwd: root })).stdout.trim();
    if (current !== pointer.to) {
      results.push({
        ...base,
        status: "skipped",
        detail: `pointer is ${current.slice(0, 12)}, not the provisional ${pointer.to.slice(0, 12)}`,
      });
      continue;
    }
    if ((await dirtyPaths(dir)).length > 0) {
      results.push({
        ...base,
        status: "skipped",
        detail: `${pointer.path} has uncommitted changes`,
      });
      continue;
    }
    const fetched = await git(["fetch", "-q", "origin"], { cwd: dir, timeoutMs: 120_000 });
    if (fetched.code !== 0) {
      results.push({ ...base, status: "fetch-failed", detail: fetched.stderr.trim() });
      continue;
    }
    const branch = (await trackedBranch(root, pointer.path)) ?? repo?.defaultBranch ?? "main";
    const upstream = `refs/remotes/origin/${branch}`;
    if (!(await refExists(dir, upstream))) {
      results.push({ ...base, status: "not-merged", detail: `origin/${branch} not found` });
      continue;
    }
    const found = await findMerged(dir, id, pointer.to, upstream);
    if ("error" in found) {
      results.push({ ...base, status: found.error, detail: found.detail });
      continue;
    }
    if (found.sha === pointer.to) {
      results.push({ ...base, status: "already-merged", method: found.method, to: found.sha });
      continue;
    }
    await gitOk(["checkout", "-q", "--detach", found.sha], { cwd: dir });
    staged.push(pointer.path);
    results.push({ ...base, status: "repointed", method: found.method, to: found.sha });
  }

  const body = results.flatMap((r) =>
    r.status === "repointed" && "to" in r
      ? [`${r.path}: ${r.from.slice(0, 12)} -> ${r.to.slice(0, 12)} (${r.method})`]
      : [],
  );
  const commit = await commitPaths(root, staged, `chore(submodules): repoint ${id}`, {
    "Change-Id": id,
    Repointed: body.join("; "),
  });
  return { ...(commit ? { commit } : {}), results };
}
