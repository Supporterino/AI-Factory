/**
 * `tasks.md` parsing (ADR-0004). A task is a checkbox line followed by indented metadata:
 *
 *   ## 1. backend
 *   - [ ] 1.1 Add health handler
 *     - repo: backend
 *     - deps: none
 *     - touches: internal/http/**, cmd/server/main.go
 *
 * OpenSpec only sees the checkbox lines; the factory reads the metadata itself.
 */

export interface ParsedTask {
  readonly id: string;
  readonly title: string;
  /** 1-based line of the checkbox. */
  readonly line: number;
  readonly done: boolean;
  readonly repo?: string;
  readonly deps?: readonly string[];
  readonly touches?: readonly string[];
}

export interface ParseIssue {
  readonly line: number;
  readonly message: string;
}

const TASK_LINE = /^- \[( |x|X)\] (\d+(?:\.\d+)+)\s+(.+?)\s*$/;
const ANY_CHECKBOX = /^\s*[-*] \[[ xX]\]/;
const META_LINE = /^\s{2,}- (repo|deps|touches):\s*(.*?)\s*$/;

const list = (value: string): string[] =>
  value
    .split(",")
    .map((s) => s.trim().replace(/^`|`$/g, ""))
    .filter((s) => s !== "");

export function parseTasks(text: string): { tasks: ParsedTask[]; issues: ParseIssue[] } {
  const lines = text.split("\n");
  const tasks: ParsedTask[] = [];
  const issues: ParseIssue[] = [];
  let current: { -readonly [K in keyof ParsedTask]: ParsedTask[K] } | undefined;
  let inFence = false;

  const flush = (): void => {
    if (current) tasks.push(current);
    current = undefined;
  };

  lines.forEach((raw, index) => {
    const lineNo = index + 1;
    if (/^\s*```/.test(raw)) inFence = !inFence;
    const task = inFence ? null : raw.match(TASK_LINE);
    if (task) {
      flush();
      current = { id: task[2] ?? "", title: task[3] ?? "", line: lineNo, done: task[1] !== " " };
      return;
    }
    if (ANY_CHECKBOX.test(raw)) {
      // OpenSpec counts every checkbox as a task, even indented or fenced ones.
      issues.push({
        line: lineNo,
        message: "checkbox that is not a top-level `- [ ] N.M title` task line",
      });
      return;
    }
    const meta = raw.match(META_LINE);
    if (meta && !current) {
      issues.push({ line: lineNo, message: `\`${meta[1]}\` line outside a task` });
      return;
    }
    if (meta && current) {
      const [, key, value = ""] = meta;
      if (key === "repo") current.repo = value.replace(/^`|`$/g, "");
      else if (key === "deps") current.deps = /^none$/i.test(value) ? [] : list(value);
      else if (key === "touches") current.touches = list(value);
      return;
    }
    if (/^#{1,6}\s/.test(raw) || (raw.trim() !== "" && !/^\s/.test(raw))) flush();
  });
  flush();
  return { tasks, issues };
}

/** Sets one task's checkbox; the rest of the text is untouched. */
export function setTaskChecked(text: string, id: string, done: boolean): string {
  const lines = text.split("\n");
  const i = lines.findIndex((l) => l.match(TASK_LINE)?.[2] === id);
  if (i === -1) return text;
  lines[i] = (lines[i] ?? "").replace(/^- \[[ xX]\]/, done ? "- [x]" : "- [ ]");
  return lines.join("\n");
}

/** Task checkbox state normalised out (for the approval hash, §7). */
export function normalizeCheckboxes(text: string): string {
  return text
    .split("\n")
    .map((l) => (TASK_LINE.test(l) ? l.replace(/^- \[[xX]\]/, "- [ ]") : l))
    .join("\n");
}
