import { existsSync, mkdirSync, readdirSync, renameSync, rmdirSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Replacing an existing agent setup must be reversible. Before the first install (no lock),
 * the pieces the factory takes over are moved under `.factory/legacy/<timestamp>/`, which is
 * gitignored and out of opencode's discovery path. Later installs leave custom additions alone.
 */

const OPENSPEC_PREFIX = /^(opsx-|openspec-)/;

function move(root: string, rel: string, stamp: string, archived: string[]): void {
  const from = join(root, rel);
  if (!existsSync(from)) return;
  const to = join(root, ".factory", "legacy", stamp, rel);
  mkdirSync(dirname(to), { recursive: true });
  renameSync(from, to);
  archived.push(rel);
}

/** Moves a directory's entries that match `keep` out of the way, leaving the rest. */
function moveEntries(
  root: string,
  dir: string,
  keep: (name: string) => boolean,
  stamp: string,
  archived: string[],
): void {
  const abs = join(root, dir);
  if (!existsSync(abs)) return;
  for (const name of readdirSync(abs)) {
    if (keep(name)) continue;
    move(root, `${dir}/${name}`, stamp, archived);
  }
  try {
    if (readdirSync(abs).length === 0) rmdirSync(abs);
  } catch {
    // Not empty or already gone.
  }
}

export interface ArchiveResult {
  readonly stamp: string;
  readonly archived: string[];
}

/**
 * Archives agent/command/skill files that would otherwise collide with the factory's managed
 * files. OpenSpec's generated `opsx-*` commands and `openspec-*` skills stay in place.
 */
export function archiveLegacySetups(root: string, repoPaths: readonly string[]): ArchiveResult {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const archived: string[] = [];
  const dirs = [".opencode", ...repoPaths.filter((p) => p !== ".").map((p) => `${p}/.opencode`)];
  for (const base of dirs) {
    for (const name of ["agent", "agents"]) {
      moveEntries(root, `${base}/${name}`, () => false, stamp, archived);
    }
    moveEntries(root, `${base}/commands`, (n) => OPENSPEC_PREFIX.test(n), stamp, archived);
    moveEntries(root, `${base}/command`, () => false, stamp, archived);
    moveEntries(root, `${base}/skills`, (n) => OPENSPEC_PREFIX.test(n), stamp, archived);
  }
  return { stamp, archived };
}
