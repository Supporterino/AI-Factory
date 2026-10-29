import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExitCode } from "../src/cli/exit-codes.ts";
import { runCli } from "../src/cli/main.ts";
import type { Handoff } from "../src/handoff/schema.ts";
import {
  askQuestions,
  mergeQuestionsBlock,
  renderQuestions,
  unansweredQuestions,
  upsertClarifications,
  writeClarifications,
} from "../src/pipeline/clarify.ts";
import { clarifyPrompt } from "../src/pipeline/prompts.ts";
import type { Clarification } from "../src/state/run.ts";

const handoff = (openQuestions: string[]): Handoff => ({
  status: "done",
  task: "design",
  filesChanged: [],
  decisions: [],
  risks: [],
  openQuestions,
});

const record = (
  question: string,
  status: Clarification["status"],
  answer?: string,
): Clarification => ({
  step: "design",
  question,
  status,
  ...(answer === undefined ? {} : { answer }),
  at: "t",
});

describe("clarification records", () => {
  test("filters answered and skipped questions and removes duplicates", () => {
    expect(
      unansweredQuestions(
        handoff(["Which repo?", "Which repo?", " ", "Could it break consumers?"]),
        [record("Could it break consumers?", "answered", "Yes")],
        "design",
      ),
    ).toEqual(["Which repo?"]);
  });

  test("asks in order, skips blanks and stops on a closed input", async () => {
    const answers = [" A1 ", "", undefined, "A4"];
    let asked = 0;
    const records = await askQuestions({
      ask: async () => answers[asked++],
      step: "design",
      questions: ["Q1", "Q2", "Q3", "Q4"],
      now: () => "t",
    });
    expect(asked).toBe(3);
    expect(records.map((r) => [r.question, r.status, r.answer])).toEqual([
      ["Q1", "answered", "A1"],
      ["Q2", "skipped", undefined],
      ["Q3", "unanswered", undefined],
      ["Q4", "unanswered", undefined],
    ]);
  });

  test("a stopped input leaves the remaining questions unanswered", async () => {
    const records = await askQuestions({
      ask: async () => undefined,
      step: "intake",
      questions: ["Q1", "Q2"],
      now: () => "t",
    });
    expect(records.map((r) => r.status)).toEqual(["unanswered", "unanswered"]);
  });

  test("upserts by step and question, keeping the order", () => {
    const existing = [record("Q1", "unanswered"), record("Q2", "answered", "old")];
    const merged = upsertClarifications(existing, [
      { ...record("Q2", "answered", "new") },
      { ...record("Q3", "skipped") },
    ]);
    expect(merged.map((r) => [r.question, r.status, r.answer])).toEqual([
      ["Q1", "unanswered", undefined],
      ["Q2", "answered", "new"],
      ["Q3", "skipped", undefined],
    ]);
  });
});

describe("clarification files", () => {
  let root: string | undefined;
  afterEach(() => {
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  test("renders a marked block and preserves architect content", () => {
    const records = [record("Which repo?", "answered", "backend"), record("Skip?", "skipped")];
    const block = renderQuestions(records);
    expect(block).toContain("<!-- ai-factory:questions:start -->");
    expect(block).toContain("**Answer:** backend");
    expect(block).toContain("**Answer:** _(skipped)_");
    const merged = mergeQuestionsBlock("# Architect notes\n\nKeep me.\n", block);
    expect(merged).toContain("Keep me.");
    expect(merged).toContain("Which repo?");
    expect(
      mergeQuestionsBlock(merged, renderQuestions([record("Only?", "unanswered")])),
    ).not.toContain("Which repo?");
  });

  test("writes the local copy and the change's questions.md", () => {
    root = mkdtempSync(join(tmpdir(), "ai-factory-clarify-"));
    const id = "add-search";
    const change = join(root, "openspec", "changes", id);
    mkdirSync(change, { recursive: true });
    writeFileSync(join(change, "questions.md"), "# Architect notes\n");
    const records = [record("Which repo?", "answered", "backend")];
    writeClarifications({ root, id, specDir: root, records });

    const local = join(root, ".factory", "clarifications", `${id}.md`);
    expect(existsSync(local)).toBe(true);
    expect(readFileSync(local, "utf8")).toContain("Which repo?");
    const questions = readFileSync(join(change, "questions.md"), "utf8");
    expect(questions).toContain("Architect notes");
    expect(questions).toContain("**Answer:** backend");
  });
});

describe("clarify prompt", () => {
  test("names the step, answers and assumptions", () => {
    const prompt = clarifyPrompt("design", [record("Which status?", "answered", "404")]);
    expect(prompt).toContain("design handoff");
    expect(prompt).toContain("Q: Which status?");
    expect(prompt).toContain("A: 404");
    expect(prompt).toContain("narrowest reasonable reading");
  });
});

describe("--interactive removal", () => {
  test("explains the replacement instead of failing on an unknown option", async () => {
    const err: string[] = [];
    const code = await runCli(["run", "--interactive", "add search"], {
      cwd: process.cwd(),
      out: () => {},
      err: (text) => err.push(text),
    });
    expect(code).toBe(ExitCode.Usage);
    expect(err.join("\n")).toContain("--interactive was removed");
    expect(err.join("\n")).toContain("refine");
  });
});
