import { isAbsolute, normalize, relative, resolve } from "node:path";
import { matchesAny, opencodeGlobRegExp } from "../tasks/glob.ts";
import { isProtectedPath, isSecretPath } from "./paths.ts";
import type { AgentRole } from "./permissions.ts";

/**
 * Edit scopes per role (§8). The CLI writes a session context file before it prompts an
 * agent; the plugin and the post-session audit judge every edit against it.
 */

export interface SessionContext {
  readonly sessionId: string;
  readonly changeId: string;
  readonly role: AgentRole;
  /** Absolute session directory: a task worktree, or the workspace root. */
  readonly directory: string;
  /** Absolute workspace root (the AI repo or the single repo). */
  readonly workspace: string;
  readonly repo?: string;
  readonly task?: string;
  /** Implementer: the task's `touches` globs (standard globs, relative to the worktree). */
  readonly touches?: readonly string[];
  /**
   * Tester and implementer: test-path globs (opencode semantics, `*` matches `/`). An
   * implementer may always add or update the repo's tests, even when `touches` omits them.
   */
  readonly testGlobs?: readonly string[];
}

const ROLES: readonly AgentRole[] = [
  "orchestrator",
  "architect",
  "explorer",
  "reviewer",
  "contract-reviewer",
  "tester",
  "implementer",
];
const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

/**
 * Validates a session context file. Hand-written (no zod) so the bundled plugin stays small;
 * anything unexpected is rejected and the plugin then refuses the tool call.
 */
export function parseSessionContext(value: unknown): SessionContext | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  const str = (k: string) => typeof v[k] === "string";
  if (!str("sessionId") || !str("changeId") || !str("directory") || !str("workspace"))
    return undefined;
  if (!ROLES.includes(v.role as AgentRole)) return undefined;
  for (const k of ["repo", "task"]) if (v[k] !== undefined && !str(k)) return undefined;
  for (const k of ["touches", "testGlobs"])
    if (v[k] !== undefined && !isStringArray(v[k])) return undefined;
  return value as SessionContext;
}

export type EditVerdict = { allowed: true; rel: string } | { allowed: false; reason: string };

/** Paths the architect may write, relative to the workspace root. */
export const architectDirs = (changeId: string): string[] => [
  `openspec/changes/${changeId}/`,
  `.factory/context/${changeId}/`,
];

const IMPLEMENTING_ROLES: ReadonlySet<AgentRole> = new Set(["implementer", "tester"]);

/**
 * Whether `ctx.role` may edit `path` (absolute or relative to the session directory).
 * `approval` returns true, or why there is no valid approval; implementers and testers need one.
 */
export function checkEdit(
  ctx: SessionContext,
  path: string,
  approval: () => true | string,
): EditVerdict {
  const abs = normalize(isAbsolute(path) ? path : resolve(ctx.directory, path));
  const rel = relative(ctx.directory, abs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    return {
      allowed: false,
      reason: `\`${path}\` is outside your ${ctx.role === "architect" ? "workspace" : "worktree"}`,
    };
  }
  if (isSecretPath(rel)) return { allowed: false, reason: `\`${rel}\` is a secret file` };

  if (ctx.role === "architect") {
    if (architectDirs(ctx.changeId).some((d) => rel.startsWith(d))) return { allowed: true, rel };
    return {
      allowed: false,
      reason: `the architect may only write ${architectDirs(ctx.changeId).join(" and ")} (not \`${rel}\`)`,
    };
  }
  if (isProtectedPath(rel))
    return { allowed: false, reason: `\`${rel}\` is managed by the factory` };
  if (!IMPLEMENTING_ROLES.has(ctx.role))
    return { allowed: false, reason: `the ${ctx.role} is read-only` };
  // The spec is the architect's; task progress is the factory's record (audit S15).
  if (/^openspec(\/|$)/i.test(rel))
    return {
      allowed: false,
      reason: `\`${rel}\` is the change's spec: only the architect writes it, and the factory ticks tasks`,
    };
  const approved = approval();
  if (approved !== true)
    return { allowed: false, reason: `${approved}; implementation edits are blocked` };

  if (ctx.role === "tester") {
    const globs = ctx.testGlobs ?? [];
    if (globs.some((g) => opencodeGlobRegExp(g).test(rel))) return { allowed: true, rel };
    return {
      allowed: false,
      reason: `the tester may only edit test files (${globs.join(", ")}), not \`${rel}\``,
    };
  }
  const inTests = (ctx.testGlobs ?? []).some((g) => opencodeGlobRegExp(g).test(rel));
  if (ctx.touches !== undefined && !matchesAny(ctx.touches, rel) && !inTests) {
    return {
      allowed: false,
      reason: `\`${rel}\` is outside this task's touches (${ctx.touches.join(", ")}); if you need it, stop with status "blocked"`,
    };
  }
  return { allowed: true, rel };
}

export interface Violation {
  readonly path: string;
  readonly reason: string;
}

/**
 * Post-session audit (CLI backstop for edits that bypassed the plugin, e.g. through shell
 * commands): every changed file in the session directory must be in scope.
 */
export function auditChanges(
  ctx: SessionContext,
  changed: readonly string[],
  approved: boolean,
): Violation[] {
  return changed.flatMap((path) => {
    const verdict = checkEdit(
      ctx,
      path,
      () => approved || `change ${ctx.changeId} is not approved`,
    );
    return verdict.allowed ? [] : [{ path, reason: verdict.reason }];
  });
}

/**
 * Paths named in a patch: apply_patch headers (`*** Add/Update/Delete File:`, `*** Move to:`)
 * and unified-diff headers (`--- a/x`, `+++ b/x`, `rename to`), CRLF or LF. Undefined when a
 * non-empty patch names no file: the caller refuses what it cannot judge (audit S17).
 */
export function patchPaths(patchText: string): string[] | undefined {
  const out = new Set<string>();
  for (const raw of patchText.split(/\r?\n/)) {
    const line = raw.replace(/\r$/, "");
    const m =
      line.match(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+?)\s*$/) ??
      line.match(/^(?:---|\+\+\+) (?:[ab]\/)?(.+?)(?:\t.*)?\s*$/) ??
      line.match(/^(?:rename|copy) (?:from|to) (.+?)\s*$/) ??
      line.match(/^diff --git a\/(.+?) b\/.+$/);
    if (m?.[1] && m[1] !== "/dev/null") out.add(m[1]);
  }
  if (out.size === 0 && patchText.trim() !== "") return undefined;
  return [...out];
}
