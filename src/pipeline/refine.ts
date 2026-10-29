import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Io } from "../cli/command.ts";
import { findWorkspaceRoot } from "../config/load.ts";
import { PreconditionError } from "../errors.ts";

const QUESTIONS: readonly [string, string, string][] = [
  ["scope", "Which repos, modules or capabilities does this touch?", ""],
  ["out-of-scope", "What is explicitly out of scope?", "nothing stated"],
  [
    "verification",
    "How should this be verified (tests, gates, manual checks)?",
    "the repository's normal gates",
  ],
  ["constraints", "Any contracts, compatibility or platform constraints?", "none stated"],
  ["extra", "Anything else the spec must know?", "none"],
];

export function requestSlug(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .slice(0, 8)
    .join("-");
  return slug === "" ? "request" : slug;
}

/**
 * CLI-mediated pre-run clarification. This is deliberately not a model turn: the headless
 * runtime rejects `ask` permissions, so the questions are asked before any session starts.
 * The result is a normal request file that `run --request` consumes.
 */
export async function refineRequest(
  io: Io,
  request: string,
): Promise<{ path: string; text: string }> {
  if (io.ask === undefined) {
    throw new PreconditionError("cannot ask questions in this environment", [
      "run `ai-factory refine` from an interactive terminal, or pass a complete request to `run`",
    ]);
  }
  const answers: [string, string][] = [];
  for (const [key, question, initial] of QUESTIONS) {
    const answer = await io.ask(question, initial);
    if (answer === undefined) {
      throw new PreconditionError("refinement was cancelled");
    }
    if (answer.trim() !== "" && answer !== initial) answers.push([key, answer.trim()]);
  }
  const text = `# Refined request

## Original

${request.trim()}

## Clarifications

${answers.map(([key, answer]) => `- **${key}**: ${answer}`).join("\n")}

## Instructions for the architect

Treat the clarifications as part of the request. If they conflict with the original, the
clarification wins. Keep anything not named here out of scope. If a question only a human can
answer remains, list it in the handoff \`openQuestions\`; the factory asks it and records the
Q&A in \`openspec/changes/<id>/questions.md\`.
`;
  const root = await findWorkspaceRoot(io.cwd);
  if (root === undefined) throw new PreconditionError("not inside a git repository");
  const dir = join(root, ".factory", "requests");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${requestSlug(request)}.md`);
  writeFileSync(path, text);
  return { path, text };
}
