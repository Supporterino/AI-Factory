import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Handoff } from "../handoff/schema.ts";
import type { Clarification } from "../state/run.ts";

/** Asks one free-text question; undefined means nobody can answer (no TTY) or the user stopped. */
export type Ask = (question: string, initial?: string) => Promise<string | undefined>;

const START = "<!-- ai-factory:questions:start -->";
const END = "<!-- ai-factory:questions:end -->";

const key = (step: string, question: string): string => `${step}\0${question.trim()}`;

/** Questions from a handoff that the user has not answered or skipped yet. */
export function unansweredQuestions(
  handoff: Handoff | undefined,
  existing: readonly Clarification[],
  step: string,
): string[] {
  if (handoff === undefined) return [];
  const answered = new Set(
    existing.filter((c) => c.status !== "unanswered").map((c) => key(c.step, c.question)),
  );
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of handoff.openQuestions) {
    const question = raw.trim();
    const k = key(step, question);
    if (question === "" || answered.has(k) || seen.has(k)) continue;
    seen.add(k);
    out.push(question);
  }
  return out;
}

export function recordUnanswered(
  step: string,
  questions: readonly string[],
  at = new Date().toISOString(),
): Clarification[] {
  return questions.map((question) => ({ step, question, status: "unanswered", at }));
}

/**
 * Asks questions in order. A blank answer is "skipped"; undefined stops asking and marks the
 * rest unanswered, so a closed stdin never fails a run.
 */
export async function askQuestions(input: {
  readonly ask: Ask;
  readonly step: string;
  readonly questions: readonly string[];
  readonly signal?: AbortSignal;
  readonly now?: () => string;
}): Promise<Clarification[]> {
  const at = input.now ?? (() => new Date().toISOString());
  const out: Clarification[] = [];
  let stopped = false;
  for (const question of input.questions) {
    if (stopped || input.signal?.aborted === true) {
      out.push({ step: input.step, question, status: "unanswered", at: at() });
      continue;
    }
    let answer: string | undefined;
    try {
      answer = await input.ask(question);
    } catch {
      answer = undefined;
    }
    if (answer === undefined) {
      stopped = true;
      out.push({ step: input.step, question, status: "unanswered", at: at() });
      continue;
    }
    const text = answer.trim();
    out.push(
      text === ""
        ? { step: input.step, question, status: "skipped", at: at() }
        : { step: input.step, question, status: "answered", answer: text, at: at() },
    );
  }
  return out;
}

/** Merge new records by step+question, keeping the original order. */
export function upsertClarifications(
  existing: readonly Clarification[],
  incoming: readonly Clarification[],
): Clarification[] {
  const map = new Map(existing.map((c) => [key(c.step, c.question), c]));
  for (const record of incoming) map.set(key(record.step, record.question), record);
  return [...map.values()];
}

const answerLine = (record: Clarification): string => {
  if (record.status === "answered") return record.answer ?? "";
  return record.status === "skipped" ? "_(skipped)_" : "_(not answered yet)_";
};

/** The marked block written into the change's `questions.md`. */
export function renderQuestions(records: readonly Clarification[]): string {
  const lines = [START, "## Clarifications", ""];
  for (const record of records) {
    lines.push(`### ${record.step}: ${record.question.replace(/\s+/g, " ").trim()}`, "");
    lines.push(`**Answer:** ${answerLine(record)}`, "");
  }
  lines.push(END);
  return `${lines.join("\n")}\n`;
}

/** Replaces the marked block, keeping anything the architect wrote in the file. */
export function mergeQuestionsBlock(existing: string, block: string): string {
  const start = existing.indexOf(START);
  const end = existing.indexOf(END);
  const complete = start !== -1 && end > start;
  const before = (complete ? existing.slice(0, start) : existing).trimEnd();
  const after = complete ? existing.slice(end + END.length).trimStart() : "";
  const parts = [before, block.trimEnd(), after].filter((part) => part !== "");
  return `${parts.join("\n\n")}\n`;
}

/**
 * Writes the Q&A twice: under `.factory/clarifications/` (gitignored, for resume and reports)
 * and, once the change folder exists, into `openspec/changes/<id>/questions.md`.
 */
export function writeClarifications(input: {
  readonly root: string;
  readonly id: string;
  readonly specDir?: string;
  readonly records: readonly Clarification[];
}): void {
  if (input.records.length === 0) return;
  const block = renderQuestions(input.records);
  const local = join(input.root, ".factory", "clarifications", `${input.id}.md`);
  mkdirSync(dirname(local), { recursive: true });
  writeFileSync(local, `# Clarifications: ${input.id}\n\n${block}`);
  if (input.specDir === undefined) return;
  const file = join(input.specDir, "openspec", "changes", input.id, "questions.md");
  mkdirSync(dirname(file), { recursive: true });
  const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
  writeFileSync(file, mergeQuestionsBlock(existing, block));
}
