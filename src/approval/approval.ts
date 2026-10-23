import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { normalizeCheckboxes } from "../tasks/parse.ts";

/**
 * Spec approval (§7 step 3). The approval records a content hash of the change's proposal,
 * specs, design and tasks; task checkbox state is normalised out, so the CLI can tick tasks
 * without voiding it. Any other edit to those files voids the approval.
 */

export interface Approval {
  readonly changeId: string;
  readonly approver: string;
  /** AI-repo commit `docs(spec): <id>` that holds the approved spec. */
  readonly specCommit: string;
  readonly hash: string;
  readonly approvedAt: string;
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
  return ok ? (value as Approval) : undefined;
}

export const changeDir = (root: string, id: string): string =>
  join(root, "openspec", "changes", id);
export const approvalFile = (root: string, id: string): string =>
  join(root, ".factory", "approvals", `${id}.json`);

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
