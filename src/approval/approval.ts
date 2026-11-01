import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { normalizeCheckboxes } from "../tasks/parse.ts";

/**
 * Spec approval (§7 step 3). The approval records a content hash of the change's proposal,
 * specs, design and tasks; task checkbox state is normalised out, so the CLI can tick tasks
 * without voiding it. Any other edit to those files voids the approval.
 */

export interface ApprovalHistoryEntry {
  /** The hash the approval replaced. */
  readonly hash: string;
  /** The spec commit the replaced approval pointed at. */
  readonly specCommit: string;
  readonly at: string;
  /** Why the approval was re-stamped (a reword, a manual edit, ...). */
  readonly reason: string;
}

export interface Approval {
  readonly changeId: string;
  readonly approver: string;
  /** AI-repo commit `docs(spec): <id>` that holds the approved spec. */
  readonly specCommit: string;
  readonly hash: string;
  readonly approvedAt: string;
  /** Previous approvals replaced by `reapprove`/`reword`, newest last. */
  readonly history?: readonly ApprovalHistoryEntry[];
}

/** Hand-written check (no zod) so the bundled plugin can use it. */
export function parseApproval(value: unknown): Approval | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  const ok =
    typeof v.changeId === "string" &&
    typeof v.approver === "string" &&
    typeof v.specCommit === "string" &&
    /^[0-9a-f]{40,64}$/.test(v.specCommit) &&
    typeof v.hash === "string" &&
    /^[0-9a-f]{64}$/.test(v.hash) &&
    typeof v.approvedAt === "string";
  if (!ok) return undefined;
  if (v.history !== undefined) {
    if (!Array.isArray(v.history)) return undefined;
    for (const entry of v.history) {
      if (typeof entry !== "object" || entry === null) return undefined;
      const e = entry as Record<string, unknown>;
      if (
        typeof e.hash !== "string" ||
        !/^[0-9a-f]{64}$/.test(e.hash) ||
        typeof e.specCommit !== "string" ||
        !/^[0-9a-f]{40,64}$/.test(e.specCommit) ||
        typeof e.at !== "string" ||
        typeof e.reason !== "string"
      )
        return undefined;
    }
  }
  return value as Approval;
}

export const changeDir = (root: string, id: string): string =>
  join(root, "openspec", "changes", id);
export const approvalFile = (root: string, id: string): string =>
  join(root, ".factory", "approvals", `${id}.json`);

/** Writes an approval record; the caller has already checked what it covers. */
export function writeApproval(root: string, approval: Approval): string {
  const file = approvalFile(root, approval.changeId);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(approval, null, 2)}\n`);
  return file;
}

/**
 * Whether a handoff `file` names the change's own spec folder (`openspec/changes/<id>/`).
 * Findings there cannot be fixed by an implementer: the architect owns that folder.
 * Accepts workspace-relative paths, `./` prefixes, backslashes and absolute paths.
 */
export function isChangeSpecPath(changeId: string, file: string | undefined): boolean {
  if (file === undefined) return false;
  const raw = file.replace(/\\/g, "/").replace(/^\.\//, "");
  const parts = raw.split("/");
  const absolute = raw.startsWith("/");
  for (let i = 0; i + 2 < parts.length; i++) {
    if (
      parts[i]?.toLowerCase() === "openspec" &&
      parts[i + 1]?.toLowerCase() === "changes" &&
      parts[i + 2] === changeId &&
      (i === 0 || absolute)
    )
      return true;
  }
  return false;
}

/** Whether a handoff `file` names anything under `openspec/` (the spec, not code). */
export function isSpecPath(file: string | undefined): boolean {
  if (file === undefined) return false;
  const raw = file.replace(/\\/g, "/").replace(/^\.\//, "");
  const parts = raw.split("/");
  if (parts[0]?.toLowerCase() === "openspec") return true;
  return raw.startsWith("/") && parts.some((part) => part.toLowerCase() === "openspec");
}

function filesUnder(dir: string, prefix = ""): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .sort()
    .flatMap((name) => {
      const rel = prefix === "" ? name : `${prefix}/${name}`;
      const abs = join(dir, name);
      return statSync(abs).isDirectory() ? filesUnder(abs, rel) : [rel];
    });
}

/** The files an approval covers, relative to the change dir. */
export function approvedFiles(root: string, id: string): string[] {
  const dir = changeDir(root, id);
  const top = ["proposal.md", "design.md", "tasks.md"].filter((f) => existsSync(join(dir, f)));
  const specs = filesUnder(join(dir, "specs"), "specs").filter((f) => f.endsWith(".md"));
  return [...top, ...specs].sort();
}

/** sha256 over `path NUL content NUL` of every covered file, with tasks.md normalised. */
export function specHash(root: string, id: string): string {
  const hash = createHash("sha256");
  const dir = changeDir(root, id);
  for (const rel of approvedFiles(root, id)) {
    let content = readFileSync(join(dir, rel), "utf8").replace(/\r\n/g, "\n");
    if (rel === "tasks.md") content = normalizeCheckboxes(content);
    hash.update(rel).update("\0").update(content).update("\0");
  }
  return hash.digest("hex");
}

export function readApproval(root: string, id: string): Approval | undefined {
  const file = approvalFile(root, id);
  if (!existsSync(file)) return undefined;
  try {
    return parseApproval(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return undefined;
  }
}

export type ApprovalCheck = { valid: true; approval: Approval } | { valid: false; reason: string };

/**
 * Filesystem-only check (the plugin uses it): an approval exists and the spec still hashes
 * the same. The CLI additionally verifies that the spec commit exists (`verifySpecCommit`).
 */
export function checkApprovalHash(root: string, id: string): ApprovalCheck {
  const approval = readApproval(root, id);
  if (approval === undefined) return { valid: false, reason: `change ${id} is not approved` };
  if (approvedFiles(root, id).length === 0)
    return { valid: false, reason: `change ${id} has no spec files` };
  if (specHash(root, id) !== approval.hash) {
    return { valid: false, reason: `the spec of ${id} changed after approval; approve it again` };
  }
  return { valid: true, approval };
}
