import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/**
 * The real path of `abs` with symlinks resolved, also for paths that do not exist yet: the
 * longest existing ancestor is resolved and the rest appended. A dangling symlink is followed
 * to where it points. Path checks use this so a symlink inside the worktree cannot point a
 * write (or a read) somewhere else.
 */
export function realPathOf(abs: string, depth = 0): string {
  if (depth > 40) return abs;
  const missing: string[] = [];
  let current = abs;
  for (let i = 0; i < 4096; i++) {
    const st = lstatSync(current, { throwIfNoEntry: false });
    if (st !== undefined) {
      try {
        return join(realpathSync.native(current), ...missing.reverse());
      } catch {
        // A dangling symlink: follow it by hand.
        if (st.isSymbolicLink()) {
          const target = resolve(dirname(current), readlinkSync(current));
          return realPathOf(join(target, ...missing.reverse()), depth + 1);
        }
        return abs;
      }
    }
    const parent = dirname(current);
    if (parent === current) return abs;
    missing.push(basename(current));
    current = parent;
  }
  return abs;
}
