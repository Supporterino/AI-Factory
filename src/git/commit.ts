import { git, gitOk } from "../exec.ts";

/**
 * Commits made by the CLI. Messages are Conventional Commits with trailers that `repoint`
 * and humans can search for. They skip the repo's commit hooks (`--no-verify`): the gates
 * already checked the content, and hooks that rewrite files would bypass the check-only
 * guard (ADR-0016).
 */

const TYPE_BY_VERB: ReadonlyArray<readonly [RegExp, string]> = [
  [/^(fix|correct|repair|resolve|handle)\b/i, "fix"],
  [/^(test|cover|verify)\b/i, "test"],
  [/^(refactor|rename|move|extract|simplify|restructure|split|inline)\b/i, "refactor"],
  [/^(document|docs?)\b/i, "docs"],
  [/^(bump|upgrade|pin)\b/i, "chore"],
  [/^(speed up|optimi[sz]e|cache)\b/i, "perf"],
];

/** "Add health endpoint" → "feat: add health endpoint". `type` overrides the verb mapping. */
export function conventionalSubject(title: string, type?: string): string {
  const clean = title.trim().replace(/\s+/g, " ").replace(/\.$/, "");
  const kind = type ?? TYPE_BY_VERB.find(([re]) => re.test(clean))?.[1] ?? "feat";
  const lowered = clean.charAt(0).toLowerCase() + clean.slice(1);
  return `${kind}: ${lowered}`;
}

export interface Trailers {
  readonly [key: string]: string;
}

function message(subject: string, trailers: Trailers): string[] {
  const block = Object.entries(trailers).map(([k, v]) => `${k}: ${v}`);
  return block.length > 0 ? ["-m", subject, "-m", block.join("\n")] : ["-m", subject];
}

/**
 * Stages everything in a worktree and commits it. Returns the commit, or undefined when
 * there was nothing to commit.
 */
export async function commitAll(
  dir: string,
  subject: string,
  trailers: Trailers = {},
): Promise<string | undefined> {
  await gitOk(["add", "-A"], { cwd: dir });
  if ((await git(["diff", "--cached", "--quiet"], { cwd: dir })).code === 0) return undefined;
  await gitOk(["commit", "-q", "--no-verify", ...message(subject, trailers)], { cwd: dir });
  return gitOk(["rev-parse", "HEAD"], { cwd: dir });
}

/** Commits only `paths` (other staged work is left alone). */
export async function commitPaths(
  dir: string,
  paths: readonly string[],
  subject: string,
  trailers: Trailers = {},
): Promise<string | undefined> {
  if (paths.length === 0) return undefined;
  await gitOk(["add", "-A", "--", ...paths], { cwd: dir });
  if ((await git(["diff", "--cached", "--quiet", "--", ...paths], { cwd: dir })).code === 0)
    return undefined;
  await gitOk(["commit", "-q", "--no-verify", ...message(subject, trailers), "--", ...paths], {
    cwd: dir,
  });
  return gitOk(["rev-parse", "HEAD"], { cwd: dir });
}

/** The task commit: subject from the task title plus `Change-Id` and `Task` trailers. */
export function commitTask(
  worktree: string,
  id: string,
  task: string,
  title: string,
  type?: string,
): Promise<string | undefined> {
  return commitAll(worktree, conventionalSubject(title, type), { "Change-Id": id, Task: task });
}
