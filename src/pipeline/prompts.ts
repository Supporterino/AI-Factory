import type { ContractConfig, RepoConfig } from "../config/schema.ts";
import type { Finding } from "../handoff/schema.ts";
import type { TaskState } from "../state/run.ts";
import { fence } from "../util/fence.ts";

/**
 * Task messages sent to agents. They carry only task-specific content; role rules, standards
 * and add-ons live in the agent files so the cached prefix stays stable (ADR-0010).
 */

const repoLines = (repos: readonly RepoConfig[]): string =>
  repos
    .map((r) => `- ${r.name} (${r.path}): ${r.languages.join(", ") || "no languages detected"}`)
    .join("\n");

export function intakePrompt(request: string, repos: readonly RepoConfig[]): string {
  return `Change request:
"""
${request}
"""

Workspace code repos:
${repoLines(repos)}

Produce the change id, the summary and the likely repos as described in your instructions.`;
}

export function explorePrompt(repo: RepoConfig, summary: string): string {
  return `Map repo \`${repo.name}\` (path: ${repo.path}, languages: ${repo.languages.join(", ") || "unknown"}) for this change:
"""
${summary}
"""
Use \`task: "explore:${repo.name}"\`. Put your summary (≤ 40 lines) in \`decisions\`.`;
}

export function designPrompt(input: {
  id: string;
  summary: string;
  request: string;
  explorations: Readonly<Record<string, string>>;
  repos: readonly RepoConfig[];
  contracts: readonly ContractConfig[];
}): string {
  const explored = Object.entries(input.explorations)
    .map(([repo, text]) => `### ${repo}\n${text}`)
    .join("\n\n");
  const contracts = input.contracts.map(
    (c) => `- ${c.kind} ${c.provider}:${c.path} → ${c.consumers.join(", ") || "no consumers"}`,
  );
  return `Write the OpenSpec change \`${input.id}\` in \`openspec/changes/${input.id}/\` (the folder exists; fill proposal.md, specs/<capability>/spec.md, design.md and tasks.md).

Request:
"""
${input.request}
"""
Summary: ${input.summary}

Code repos (the only valid \`repo:\` values):
${repoLines(input.repos)}

Contracts:
${contracts.length > 0 ? contracts.join("\n") : "- none configured"}

Explorer findings:
${explored || "(none)"}

Use \`task: "design"\` in your handoff and list every file you wrote.`;
}

export function designRepairPrompt(issues: readonly string[]): string {
  return `The change does not validate yet. Fix exactly these problems in the change files, then end with a new handoff:
${issues.map((i) => `- ${i}`).join("\n")}`;
}

export function packsPrompt(id: string, tasks: readonly TaskState[], maxTokens: number): string {
  const list = tasks.map(
    (t) =>
      `- ${t.id} [${t.repo}] ${t.title} (touches: ${t.touches.join(", ")}; deps: ${t.deps.join(", ") || "none"})`,
  );
  return `The spec of \`${id}\` is approved. Write one context pack per task to \`.factory/context/${id}/<task-id>.md\`, each under ${maxTokens} tokens (about ${maxTokens * 4} characters), as described in your instructions:
${list.join("\n")}

Use \`task: "context-packs"\` in your handoff.`;
}

export function taskPrompt(input: {
  task: TaskState;
  pack: string;
  gates: readonly string[];
  feedback?: string;
}): string {
  const { task } = input;
  const retry = input.feedback
    ? `\n\nThis is attempt ${task.failures + 1}. The previous attempt failed with (compacted):\n${fence(input.feedback)}\nFix exactly what this reports. Your earlier changes are still in the worktree.`
    : "";
  return `Task ${task.id}: ${task.title}
Repo: ${task.repo}. You may change only files matching: ${task.touches.join(", ")}.

${input.pack.trim()}

Gate commands that run after you finish (run the cheap ones yourself first):
${input.gates.map((g) => `- \`${g}\``).join("\n") || "- (resolved by the factory)"}${retry}`;
}

export function conflictPrompt(task: TaskState, conflicts: readonly string[]): string {
  return `Your task ${task.id} ("${task.title}") was rebased onto newer work and has merge conflicts in:
${conflicts.map((f) => `- ${f}`).join("\n")}
Resolve every conflict so both changes are kept and correct. Remove all conflict markers. Do not run git commands that change history; the factory continues the rebase. End with a handoff (\`task: "${task.id}"\`).`;
}

export function reviewPrompt(input: {
  repo: RepoConfig;
  base: string;
  head: string;
  spec: string;
  profiles: readonly string[];
}): string {
  return `Review repo \`${input.repo.name}\` for this change: \`git diff ${input.base}..${input.head}\` (run it in this directory), plus the code around it.
Standards in force: ${input.profiles.join(", ") || "none"} (see .opencode/standards/ in the workspace).

Spec of the change:
${input.spec}

Use \`task: "review:${input.repo.name}"\`.`;
}

export function testerPrompt(input: {
  task: TaskState;
  spec: string;
  testGlobs: readonly string[];
  gates: readonly string[];
}): string {
  return `Task ${input.task.id}: make sure every scenario below that concerns repo \`${input.task.repo}\` has a test.
You may only edit test files (${input.testGlobs.join(", ")}).

Spec of the change:
${input.spec}

Gate commands:
${input.gates.map((g) => `- \`${g}\``).join("\n") || "- (resolved by the factory)"}

Use \`task: "${input.task.id}"\` and map scenarios to tests under \`decisions\`.`;
}

export function findingTaskTitle(f: Finding): string {
  const where = f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : "";
  return `Fix review finding${where}: ${f.problem.split("\n")[0]?.slice(0, 120) ?? ""}`;
}

export function findingPack(f: Finding): string {
  return `Review finding (${f.severity}):
- What the code does: ${f.what}
- Problem: ${f.problem}
- Fix: ${f.fix}
- Impact if skipped: ${f.impact}
${f.file ? `- Location: ${f.file}${f.line ? `:${f.line}` : ""}` : ""}`;
}

export function contractReviewPrompt(input: {
  contracts: readonly { key: string; summary: string }[];
  diffs: readonly string[];
}): string {
  return `One cross-repo review of the contracts this change touches. The deterministic contract gate already ran:
${input.contracts.map((c) => c.summary).join("\n")}

Read the provider and consumer changes (run these from the workspace root):
${input.diffs.map((d) => `- \`${d}\``).join("\n")}

Report only real mismatches between providers and consumers as findings, with \`file\` as a workspace-relative path. Use \`task: "contract-review"\`.`;
}
