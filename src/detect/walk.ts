import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Directories never worth scanning for markers or contracts. */
export const SKIP_DIRS: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  "vendor",
  "dist",
  "build",
  ".build",
  "target",
  ".venv",
  "venv",
  "__pycache__",
  ".next",
  "coverage",
  ".factory",
  ".opencode",
  "openspec",
  "graphify-out",
]);

export interface WalkOptions {
  readonly maxDepth: number;
  readonly maxFiles: number;
  /** Repo-relative POSIX paths of directories to skip (e.g. submodules of the AI repo). */
  readonly skipPaths?: ReadonlySet<string>;
}

export interface FileEntry {
  /** Repo-relative POSIX path. */
  readonly path: string;
  readonly size: number;
}

/**
 * Lists files under `root`, breadth-first and sorted, so truncation by `maxFiles` is
 * deterministic. Nested git repos (a `.git` entry below the root) are not entered.
 */
export function listFiles(root: string, options: WalkOptions): FileEntry[] {
  const files: FileEntry[] = [];
  let level: string[] = [""];
  for (let depth = 0; depth <= options.maxDepth && level.length > 0; depth++) {
    const next: string[] = [];
    for (const rel of level) {
      const abs = rel === "" ? root : join(root, rel);
      let names: string[];
      try {
        names = readdirSync(abs).sort();
      } catch {
        continue;
      }
      for (const name of names) {
        const childRel = rel === "" ? name : `${rel}/${name}`;
        let stat: ReturnType<typeof statSync>;
        try {
          stat = statSync(join(abs, name));
        } catch {
          continue;
        }
        if (stat.isDirectory()) {
          if (SKIP_DIRS.has(name) || options.skipPaths?.has(childRel)) continue;
          if (existsSync(join(abs, name, ".git"))) continue;
          next.push(childRel);
        } else if (stat.isFile()) {
          files.push({ path: childRel, size: stat.size });
          if (files.length >= options.maxFiles) return files;
        }
      }
    }
    level = next;
  }
  return files;
}

/** Parent directory of a repo-relative path ("." for top-level files). */
export function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "." : path.slice(0, i);
}

export function baseOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** True if `dir` is `ancestor` or below it. "." is everyone's ancestor. */
export function isWithin(dir: string, ancestor: string): boolean {
  return ancestor === "." || dir === ancestor || dir.startsWith(`${ancestor}/`);
}
