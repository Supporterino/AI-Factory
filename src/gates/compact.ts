/**
 * Gate output compaction (§11): what an agent sees on a retry. Strips ANSI codes and
 * duplicate lines, keeps failing items with their nearest context, and caps the length.
 */

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequences start with ESC.
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;

const SIGNAL =
  /\b(error|errors|fail|failed|failure|panic|exception|traceback|assert|expected|received|warning|undefined|cannot|not found)\b|✗|✖|×|FAIL|:\d+:\d+|\b[A-Z]{1,4}\d{3,5}\b/i;

const CONTEXT = 2;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

export function compactOutput(raw: string, maxLines: number): string {
  const lines = stripAnsi(raw)
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.trimEnd());

  // Drop blank lines and exact duplicates (repeated progress lines, repeated warnings).
  const seen = new Set<string>();
  const unique = lines.filter((l) => {
    if (l.trim() === "" || seen.has(l)) return false;
    seen.add(l);
    return true;
  });

  const keep = new Set<number>();
  unique.forEach((line, i) => {
    if (!SIGNAL.test(line)) return;
    for (let j = Math.max(0, i - CONTEXT); j <= Math.min(unique.length - 1, i + CONTEXT); j++)
      keep.add(j);
  });

  let selected: string[];
  if (keep.size === 0) {
    // No recognisable failure lines: the tail usually holds the summary.
    selected = unique.slice(-maxLines);
  } else {
    selected = [];
    let last = -1;
    for (const i of [...keep].sort((a, b) => a - b)) {
      if (i > last + 1) selected.push("…");
      selected.push(unique[i] ?? "");
      last = i;
    }
  }

  if (selected.length <= maxLines) return selected.join("\n");
  const shown = selected.slice(0, maxLines - 1);
  return [...shown, `… ${selected.length - shown.length} more lines`].join("\n");
}

/**
 * For a retry: lines of the new compacted output that were not in the previous attempt's,
 * so the agent sees what changed. Falls back to the full output when everything is new.
 */
export function changedSinceLastAttempt(previous: string, current: string): string {
  const before = new Set(previous.split("\n"));
  const fresh = current.split("\n").filter((l) => !before.has(l));
  if (fresh.length === 0) return "(same failures as the previous attempt)";
  return fresh.length === current.split("\n").length ? current : fresh.join("\n");
}
