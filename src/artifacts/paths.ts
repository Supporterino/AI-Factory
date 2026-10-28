import { join } from "node:path";

/**
 * Committed per-change records (`artifacts.mode: "git"`). A top-level directory, deliberately
 * distinct from the gitignored `.factory/` runtime state. Fixed on purpose: the agent policy
 * lists are static, so the path cannot be configurable without making every deny dynamic.
 */
export const ARTIFACTS_DIR = "factory-records";

/** Change ids and quick-task ids (`quick-<slug>`) are lowercase slugs; nothing else may be a path. */
const ARTIFACT_ID = /^[a-z0-9][a-z0-9-]*$/;

export function isArtifactId(id: string): boolean {
  return ARTIFACT_ID.test(id);
}

export type ArtifactKind = "reports" | "approvals" | "usage";

export function artifactFile(root: string, kind: ArtifactKind, name: string): string {
  return join(root, ARTIFACTS_DIR, kind, name);
}

export const artifactDir = (root: string, kind?: ArtifactKind): string =>
  kind === undefined ? join(root, ARTIFACTS_DIR) : join(root, ARTIFACTS_DIR, kind);
