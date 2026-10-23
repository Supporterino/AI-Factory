import { readFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "../exec.ts";

/**
 * Ponytail `shortcut:` comments (§12): a known limit marked in code
 * (`shortcut: <the limit>, <when to upgrade>`; older `ponytail:` too). In `report` mode the
 * CLI collects new ones into the change report; in `forbid` mode a lint-stage check fails.
 */

const SHORTCUT =
  /(?:\/\/|#|\/\*|\*|--|<!--|;)\s*(?:shortcut|ponytail):\s*(.+?)\s*(?:\*\/|-->)?\s*$/i;

export interface Shortcut {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

export function shortcutIn(line: string): string | undefined {
  return line.match(SHORTCUT)?.[1];
}

/** Shortcuts on lines added by a unified diff with `-U0`. */
export function shortcutsInDiff(diff: string): Shortcut[] {
  const out: Shortcut[] = [];
  let file = "";
  let line = 0;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ ")) {
      file = raw.slice(4).replace(/^b\//, "");
      continue;
    }
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }
    if (raw.startsWith("+") && file !== "/dev/null") {
      const text = shortcutIn(raw.slice(1));
      if (text !== undefined) out.push({ file, line, text });
      line++;
    }
  }
  return out;
}

/** New shortcuts in a worktree since `base`: committed, uncommitted and untracked. */
export async function newShortcuts(dir: string, base: string): Promise<Shortcut[]> {
  const diff = await git(["diff", "-U0", "--no-color", "--no-ext-diff", base, "--"], { cwd: dir });
  const found = shortcutsInDiff(diff.stdout);
  const untracked = await git(["ls-files", "--others", "--exclude-standard"], { cwd: dir });
  for (const file of untracked.stdout.split("\n").filter(Boolean)) {
    let text: string;
    try {
      text = readFileSync(join(dir, file), "utf8");
    } catch {
      continue;
    }
    text.split("\n").forEach((l, i) => {
      const s = shortcutIn(l);
      if (s !== undefined) found.push({ file, line: i + 1, text: s });
    });
  }
  return found;
}

/** Shortcuts a change added on a repo's branch (`base..head`). */
export async function changeShortcuts(
  dir: string,
  base: string,
  head: string,
): Promise<Shortcut[]> {
  const diff = await git(["diff", "-U0", "--no-color", "--no-ext-diff", `${base}..${head}`, "--"], {
    cwd: dir,
  });
  return shortcutsInDiff(diff.stdout);
}
