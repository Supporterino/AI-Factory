import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PreconditionError } from "../errors.ts";
import { gitOk } from "../exec.ts";
import { runGates } from "../gates/run.ts";
import { commitPaths } from "../git/commit.ts";
import { bumpPointers } from "../git/pointers.ts";
import { changeBranch } from "../git/repo.ts";
import type { Finding, Handoff } from "../handoff/schema.ts";
import { archiveChange, validateChange } from "../openspec/cli.ts";
import { profilesFor } from "../profiles/index.ts";
import type { RunSummary } from "../scheduler/scheduler.ts";
import { releaseActive } from "../state/active.ts";
import { type RunState, recordTask, TaskState } from "../state/run.ts";
import { setTaskChecked } from "../tasks/parse.ts";
import type { Pipeline } from "./context.ts";
import { packPath, specText } from "./implement.ts";
import { findingPack, findingTaskTitle, reviewPrompt } from "./prompts.ts";

const MAX_SUITE_ROUNDS = 2;

const touchedRepos = (run: RunState): string[] => [...new Set(run.tasks.map((t) => t.repo))];

function addTask(
  draft: RunState,
  task: Omit<TaskState, "status" | "failures" | "serial" | "history">,
): void {
  if (draft.tasks.some((t) => t.id === task.id)) return;
  const state = TaskState.parse({ ...task, status: "pending" });
  recordTask(state, "added", task.kind);
  draft.tasks.push(state);
}

/**
 * §7 step 8: once a repo's tasks merged, its reviewer and tester run in parallel (once per
 * repo). Must/should findings and the tester's work become tasks with their own budget.
 * Returns the number of tasks added.
 */
export async function review(p: Pipeline, id: string): Promise<number> {
  const run = p.run(id);
  const repos = touchedRepos(run).filter((r) => !run.reviewed.includes(r));
  if (repos.length === 0) return 0;
  p.out(`▶ review + tests: ${repos.join(", ")}`);
  const spec = specText(p, id);
  let added = 0;

  await Promise.all(
    repos.map((name) =>
      p.agents.run(async () => {
        const repo = p.repo(name);
        const base = run.branches[name]?.base ?? "HEAD";
        const res = await p.call({
          changeId: id,
          agent: "reviewer",
          role: "reviewer",
          modelRole: "reviewer",
          context: { directory: p.repoDir(repo), workspace: p.root, repo: name },
          title: `${id} review ${name}`,
          prompt: reviewPrompt({
            repo,
            base,
            head: changeBranch(id),
            spec,
            profiles: profilesFor(repo.languages).map((pr) => pr.title),
          }),
        });
        const findings: Finding[] = res.handoff?.findings ?? [];
        await p.update(id, (d) => {
          if (res.handoff) d.handoffs[`review:${name}`] = res.handoff;
          d.reviewed.push(name);
          let n = 0;
          for (const f of findings.filter((x) => x.severity !== "nice")) {
            n++;
            const taskId = `fix-${name}-${n}`;
            addTask(d, {
              id: taskId,
              title: findingTaskTitle(f),
              repo: name,
              deps: [],
              touches: ["**"],
              kind: "review-fix",
            });
            added++;
            mkdirSync(join(p.root, ".factory", "context", id), { recursive: true });
            writeFileSync(packPath(p.root, id, taskId), findingPack(f));
          }
          addTask(d, {
            id: `test-${name}`,
            title: `Ensure every scenario of ${name} has a test`,
            repo: name,
            deps: [],
            touches: ["**"],
            kind: "test",
          });
          added++;
        });
      }),
    ),
  );
  return added;
}

/**
 * §7 step 10: every touched repo runs its full gate set on `change/<id>`. A failure becomes a
 * fix task (at most two rounds). Returns the repos still failing.
 */
export async function fullSuite(p: Pipeline, id: string): Promise<string[]> {
  const run = p.run(id);
  const repos = touchedRepos(run);
  p.out(`▶ full suite: ${repos.join(", ")}`);
  const failing: string[] = [];
  await Promise.all(
    repos.map(async (name) => {
      const repo = p.repo(name);
      const report = await p.gates.run(() =>
        runGates({
          root: p.root,
          config: p.config,
          repo,
          worktree: p.repoDir(repo),
          mode: "full",
          base: run.branches[name]?.base ?? "HEAD",
        }),
      );
      const output = report.results
        .filter((r) => r.status !== "pass" && r.status !== "skipped")
        .map((r) => `[${r.type}] ${r.command ?? ""}\n${r.output}`)
        .join("\n\n");
      await p.update(id, (d) => {
        d.fullSuite[name] = { passed: report.passed, output };
      });
      if (!report.passed) failing.push(name);
    }),
  );
  if (failing.length === 0) return [];
  const rounds = p.run(id).suiteRounds;
  if (rounds >= MAX_SUITE_ROUNDS) return failing;
  await p.update(id, (d) => {
    d.suiteRounds += 1;
    for (const name of failing) {
      const taskId = `suite-${name}-${d.suiteRounds}`;
      addTask(d, {
        id: taskId,
        title: `Fix the full-suite failures in ${name}`,
        repo: name,
        deps: [],
        touches: ["**"],
        kind: "suite-fix",
      });
      const t = d.tasks.find((x) => x.id === taskId);
      if (t) t.lastGateOutput = d.fullSuite[name]?.output ?? "";
    }
  });
  return [];
}

function harvest(run: RunState): { risks: string[]; questions: string[]; findings: string[] } {
  const risks: string[] = [];
  const questions: string[] = [];
  const findings: string[] = [];
  for (const [step, value] of Object.entries(run.handoffs)) {
    const h = value as Partial<Handoff>;
    for (const r of h.risks ?? []) risks.push(`${step}: ${r}`);
    for (const q of h.openQuestions ?? []) questions.push(`${step}: ${q}`);
    for (const f of h.findings ?? [])
      findings.push(
        `${step}: [${f.severity}] ${f.file ?? ""}${f.line ? `:${f.line}` : ""} ${f.problem}`,
      );
  }
  return { risks, questions, findings };
}

const reportFile = (root: string, id: string, kind: "final" | "paused"): string =>
  join(root, ".factory", "reports", kind === "final" ? `${id}.md` : `${id}-paused.md`);

/** The pause report (§7 failure semantics): what completed, failed, was cancelled, and what next. */
export function writePauseReport(p: Pipeline, id: string, summary: RunSummary): string {
  const run = p.run(id);
  const failed = run.tasks.filter((t) => t.status === "failed");
  const lines = [
    `# ${id}: paused`,
    "",
    `Reason: ${run.pausedReason ?? "unknown"}`,
    "",
    `- Completed: ${summary.merged.join(", ") || "none"}`,
    `- Failed: ${summary.failed.join(", ") || "none"}`,
    `- Cancelled (depend on a failed task): ${summary.cancelled.join(", ") || "none"}`,
    `- Not started: ${summary.pending.join(", ") || "none"}`,
    "",
    ...failed.flatMap((t) => [
      `## Task ${t.id}: ${t.title} (${t.repo})`,
      "",
      `Error: ${t.lastError ?? ""}`,
      ...(t.worktree ? [`Worktree (kept): ${t.worktree}`] : []),
      ...(t.lastGateOutput ? ["", "Last gate output:", "```", t.lastGateOutput, "```"] : []),
      "",
    ]),
    "## Next steps",
    "",
    "1. Inspect the failed task's worktree and fix the cause (or change the spec and approve again).",
    `2. \`ai-factory retry ${id} --task <task>\` resets the task's retry budget.`,
    `3. \`ai-factory resume ${id}\` continues the change.`,
    "",
  ];
  const file = reportFile(p.root, id, "paused");
  mkdirSync(join(p.root, ".factory", "reports"), { recursive: true });
  writeFileSync(file, lines.join("\n"));
  return file;
}

/** §7 step 11: pointer bumps, archive, report, release. Never pushes. */
export async function close(p: Pipeline, id: string): Promise<string> {
  const run = p.run(id);
  const open = run.tasks.filter((t) => t.status !== "merged");
  if (open.length > 0)
    throw new PreconditionError(
      `cannot close ${id}: tasks not merged: ${open.map((t) => t.id).join(", ")}`,
    );
  p.out("▶ close");

  // Mirror task state into tasks.md (checkboxes are outside the approval hash).
  const tasksFile = join(p.root, "openspec", "changes", id, "tasks.md");
  if (existsSync(tasksFile)) {
    let text = readFileSync(tasksFile, "utf8");
    for (const t of run.tasks.filter((x) => x.kind === "task"))
      text = setTaskChecked(text, t.id, true);
    writeFileSync(tasksFile, text);
  }

  let pointerCommit: string | undefined;
  let pointers: string[] = [];
  if (p.config.layout === "submodules") {
    const repos = touchedRepos(run)
      .map((n) => p.repo(n))
      .filter((r) => r.path !== ".");
    const bump = await bumpPointers(p.root, id, repos);
    pointerCommit = bump?.commit;
    pointers =
      bump?.pointers.map(
        (ptr) => `${ptr.path}: ${ptr.from.slice(0, 12)} → ${ptr.to.slice(0, 12)}`,
      ) ?? [];
  }

  const issues = await validateChange(p.root, p.root, id);
  if (issues.length > 0)
    throw new PreconditionError(`openspec validate ${id} failed before archive`, issues);
  const archivedAs = await archiveChange(p.root, p.root, id);
  const archiveCommit = await commitPaths(p.root, ["openspec"], `chore(spec): archive ${id}`, {
    "Change-Id": id,
  });

  const done = p.run(id);
  const { risks, questions, findings } = harvest(done);
  const repoLines = await Promise.all(
    touchedRepos(done).map(async (name) => {
      const dir = p.repoDir(p.repo(name));
      const head = await gitOk(["rev-parse", "--short=12", changeBranch(id)], { cwd: dir });
      const count = (
        await gitOk(
          ["rev-list", "--count", `${done.branches[name]?.base ?? head}..${changeBranch(id)}`],
          { cwd: dir },
        )
      ).trim();
      return `- ${name}: \`${changeBranch(id)}\` at ${head} (${count} commit${count === "1" ? "" : "s"})`;
    }),
  );
  const lines = [
    `# ${id}: done`,
    "",
    done.summary,
    "",
    "## Branches (local only; nothing was pushed)",
    "",
    ...repoLines,
    `- AI repo: \`${changeBranch(id)}\`${archiveCommit ? ` (archive commit ${archiveCommit.slice(0, 12)})` : ""}`,
    "",
    "## Tasks",
    "",
    ...done.tasks.map(
      (t) =>
        `- [x] ${t.id} (${t.repo}, ${t.kind}): ${t.title}${t.failures > 0 ? ` — ${t.failures} failed attempt${t.failures === 1 ? "" : "s"}` : ""}`,
    ),
    "",
    ...(pointerCommit
      ? [
          "## Submodule pointers (provisional)",
          "",
          ...pointers.map((x) => `- ${x}`),
          "",
          `Push each \`${changeBranch(id)}\` branch and open your MRs. After they merge, run \`ai-factory repoint ${id}\` to replace these pointers with the merged commits.`,
          "",
        ]
      : []),
    `## Spec\n\nArchived as \`openspec/changes/archive/${archivedAs}\`.`,
    "",
    ...(findings.length > 0
      ? ["## Review findings", "", ...findings.map((f) => `- ${f}`), ""]
      : []),
    ...(risks.length > 0
      ? ["## Risks and things not checked", "", ...risks.map((r) => `- ${r}`), ""]
      : []),
    ...(questions.length > 0
      ? ["## Open questions", "", ...questions.map((q) => `- ${q}`), ""]
      : []),
  ];
  const file = reportFile(p.root, id, "final");
  mkdirSync(join(p.root, ".factory", "reports"), { recursive: true });
  writeFileSync(file, lines.join("\n"));

  await p.update(id, (d) => {
    d.phase = "done";
    if (pointerCommit) d.pointerCommit = pointerCommit;
    d.reportPath = file;
  });
  await releaseActive(p.root, id);
  p.out(`✓ ${id} done — report: ${file}`);
  return file;
}
