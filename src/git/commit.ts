import { existsSync } from "node:fs";
import { join } from "node:path";
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

const GITMOJI: Readonly<Record<string, string>> = {
  feat: "✨",
  fix: "🐛",
  test: "✅",
  refactor: "♻️",
  docs: "📝",
  chore: "🔧",
  perf: "⚡️",
  ci: "👷",
  build: "🔧",
};

export interface CommitStyle {
  readonly style?: "conventional" | "gitmoji";
  readonly scope?: string;
}

/** "Add health endpoint" → "feat: add health endpoint". `type` overrides the verb mapping. */
export function conventionalSubject(
  title: string,
  type?: string,
  options: CommitStyle = {},
): string {
  const clean = title.trim().replace(/\s+/g, " ").replace(/\.$/, "");
  const kind = type ?? TYPE_BY_VERB.find(([re]) => re.test(clean))?.[1] ?? "feat";
  const lowered = clean.charAt(0).toLowerCase() + clean.slice(1);
  const scope = options.scope === undefined ? "" : `(${options.scope})`;
  const emoji = options.style === "gitmoji" ? `${GITMOJI[kind] ?? "🔧"} ` : "";
  return `${kind}${scope}: ${emoji}${lowered}`;
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

/**
 * Commits only `paths` (other staged work is left alone). Paths that neither exist nor are
 * tracked are skipped (git rejects pathspecs that match nothing).
 */
export async function commitPaths(
  dir: string,
  paths: readonly string[],
  subject: string,
  trailers: Trailers = {},
): Promise<string | undefined> {
  const usable: string[] = [];
  for (const p of paths) {
    if (
      existsSync(join(dir, p)) ||
      (await git(["ls-files", "--error-unmatch", "--", p], { cwd: dir })).code === 0
    )
      usable.push(p);
  }
  if (usable.length === 0) return undefined;
  await gitOk(["add", "-A", "--", ...usable], { cwd: dir });
  if ((await git(["diff", "--cached", "--quiet", "--", ...usable], { cwd: dir })).code === 0)
    return undefined;
  await gitOk(["commit", "-q", "--no-verify", ...message(subject, trailers), "--", ...usable], {
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
  style: CommitStyle = {},
): Promise<string | undefined> {
  return commitAll(worktree, conventionalSubject(title, type, style), {
    "Change-Id": id,
    Task: task,
  });
}
