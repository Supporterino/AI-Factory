import { rmSync } from "node:fs";
import { join } from "node:path";
import { PreconditionError } from "../errors.ts";
import { git, gitOk } from "../exec.ts";
import { changedFiles } from "../gates/affected.ts";
import { installDeps } from "../gates/install.ts";
import { runGates } from "../gates/run.ts";
import { commitAll, conventionalSubject } from "../git/commit.ts";
import { currentBranch, ensureClean } from "../git/repo.ts";
import { auditChanges } from "../policy/scope.ts";
import type { Pipeline } from "./context.ts";
import { quickPrompt, quickReviewPrompt } from "./prompts.ts";
import { requestSlug } from "./refine.ts";

export interface QuickResult {
  readonly repo: string;
  readonly branch: string;
  readonly commit?: string;
  readonly ok: boolean;
  readonly detail: string;
}

/** The usage-ledger id of a quick task; also `land`/artifact names, so keep it stable. */
export const quickChangeId = (task: string): string => `quick-${requestSlug(task)}`;

async function revert(dir: string, paths: readonly string[]): Promise<void> {
  for (const path of paths) {
    const inHead = (await git(["cat-file", "-e", `HEAD:${path}`], { cwd: dir })).code === 0;
    if (inHead) await gitOk(["checkout", "-q", "HEAD", "--", path], { cwd: dir });
    else {
      await git(["rm", "-q", "--cached", "--ignore-unmatch", "--", path], { cwd: dir });
      rmSync(join(dir, path), { force: true, recursive: true });
    }
  }
}

function gateOutput(report: Awaited<ReturnType<typeof runGates>>): string {
  return report.results
    .filter((r) => r.status !== "pass" && r.status !== "skipped")
    .map((r) => `[${r.name ?? r.type}] ${r.command ?? ""}\n${r.output}`)
    .join("\n\n");
}

/**
 * The no-spec quick path: branch, implement, gate, review, one local commit. It still uses
 * the factory's scope audit and gates; only the OpenSpec/approval part is skipped.
 */
export async function quickTask(
  p: Pipeline,
  input: {
    readonly task: string;
    readonly repo?: string;
    readonly agent?: string;
    readonly review: boolean;
  },
): Promise<QuickResult> {
  if (!p.config.workflow.quick.enabled) {
    throw new PreconditionError("workflow.quick.enabled is false");
  }
  const code = p.codeRepos();
  const repo =
    input.repo === undefined
      ? code.length === 1
        ? code[0]
        : undefined
      : code.find((r) => r.name === input.repo);
  if (repo === undefined) {
    throw new PreconditionError(
      input.repo === undefined
        ? "quick: this workspace has several code repos; pass --repo <name>"
        : `quick: unknown repo "${input.repo}"`,
      code.map((r) => `  ${r.name} (${r.path})`),
    );
  }
  const dir = p.repoDir(repo);
  await ensureClean(dir, repo.name);
  const slug = requestSlug(input.task);
  const changeId = quickChangeId(input.task);
  const branch = `${p.config.workflow.quick.branchPrefix}${slug}`;
  if ((await currentBranch(dir)) === branch) {
    throw new PreconditionError(`already on ${branch}`);
  }
  if (
    (await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: dir })).code ===
    0
  ) {
    throw new PreconditionError(`branch ${branch} already exists`);
  }
  const base = (await gitOk(["rev-parse", "HEAD"], { cwd: dir })).trim();
  await gitOk(["switch", "-q", "-c", branch], { cwd: dir });

  const installed = await installDeps(p.root, dir, repo);
  const installFailure = installed.find((s) => s.status === "failed");
  if (installFailure !== undefined) {
    return {
      repo: repo.name,
      branch,
      ok: false,
      detail: `install failed: ${installFailure.detail ?? installFailure.dir}`,
    };
  }

  const explicit =
    input.agent === undefined ? undefined : p.config.agents.find((a) => a.id === input.agent);
  if (input.agent !== undefined && explicit === undefined) {
    throw new PreconditionError(`quick: unknown agent "${input.agent}"`);
  }
  if (explicit !== undefined && explicit.phase !== "implementer") {
    throw new PreconditionError(`quick: agent "${explicit.id}" is not an implementer`);
  }
  const routed =
    explicit === undefined
      ? { agent: `implementer-${repo.name}`, role: "implementer" as const, custom: false }
      : { agent: explicit.id, role: "implementer" as const, custom: true };
  const context = {
    directory: dir,
    workspace: p.root,
    repo: repo.name,
    task: "quick",
    touches: ["**"],
  };
  let feedback: string | undefined;
  let passed = false;
  let output = "";
  const runQuickGates = async (): Promise<Awaited<ReturnType<typeof runGates>>> => {
    const started = p.progress.now();
    const report = await runGates({
      root: p.root,
      config: p.config,
      repo,
      worktree: dir,
      mode: "task",
      base,
      onGate: (event) => p.progress.gate("quick", event),
    });
    p.progress.gatesDone("quick", report, p.progress.now() - started);
    return report;
  };
  for (let attempt = 1; attempt <= 3 && !passed; attempt++) {
    const res = await p.call({
      changeId: changeId,
      agent: routed.agent,
      role: "implementer",
      modelRole: "implementer",
      context,
      title: `quick ${slug} attempt ${attempt}`,
      label: input.task,
      step: "quick",
      kind: "attempt",
      attempt,
      prompt:
        feedback === undefined
          ? quickPrompt({ task: input.task, repo })
          : `${quickPrompt({ task: input.task, repo })}\n\nPrevious attempt failed:\n${feedback}`,
    });
    if (res.handoff === undefined || res.handoff.status !== "done") {
      return {
        repo: repo.name,
        branch,
        ok: false,
        detail: res.handoff?.openQuestions.join("; ") ?? res.problem ?? "agent did not finish",
      };
    }
    const changed = await changedFiles(dir, base);
    const violations = auditChanges(
      {
        sessionId: "quick-audit",
        changeId: changeId,
        role: "implementer",
        ...context,
      },
      changed,
      true,
    );
    if (violations.length > 0) {
      await revert(
        dir,
        violations.map((v) => v.path),
      );
      return {
        repo: repo.name,
        branch,
        ok: false,
        detail: `edits outside the quick scope were reverted:\n${violations.map((v) => `${v.path}: ${v.reason}`).join("\n")}`,
      };
    }
    const report = await runQuickGates();
    if (report.passed) {
      passed = true;
      break;
    }
    output = gateOutput(report);
    feedback = output;
  }
  if (!passed) {
    return { repo: repo.name, branch, ok: false, detail: `gates failed:\n${output}` };
  }

  if (input.review) {
    let findings: string[] = [];
    for (let round = 1; round <= 3; round++) {
      const review = await p.call({
        changeId: changeId,
        agent: "reviewer",
        role: "reviewer",
        modelRole: "reviewer",
        context: { directory: dir, workspace: p.root, repo: repo.name },
        title: `quick ${slug} review ${round}`,
        step: "quick-review",
        kind: "step",
        prompt: quickReviewPrompt({ task: input.task, repo }),
      });
      if (review.handoff === undefined) {
        return {
          repo: repo.name,
          branch,
          ok: false,
          detail: review.problem ?? "review produced no handoff",
        };
      }
      findings = (review.handoff.findings ?? [])
        .filter((f) => f.severity !== "nice")
        .map(
          (f) =>
            `- [${f.severity}] ${f.file ?? ""}${f.line ? `:${f.line}` : ""} ${f.problem}\n  fix: ${f.fix}`,
        );
      if (findings.length === 0) break;
      const fix = await p.call({
        changeId: changeId,
        agent: routed.agent,
        role: "implementer",
        modelRole: "implementer",
        context,
        title: `quick ${slug} fix ${round}`,
        label: input.task,
        step: "quick",
        kind: "attempt",
        attempt: 4 + round,
        prompt: `Fix these review findings for the quick task:\n${findings.join("\n")}\n\n${quickPrompt({ task: input.task, repo })}`,
      });
      if (fix.handoff?.status !== "done") {
        return { repo: repo.name, branch, ok: false, detail: "review fix did not finish" };
      }
      const report = await runQuickGates();
      if (!report.passed) {
        return {
          repo: repo.name,
          branch,
          ok: false,
          detail: `gates failed after review fix:\n${gateOutput(report)}`,
        };
      }
      if (round === 3) {
        return {
          repo: repo.name,
          branch,
          ok: false,
          detail: `review findings remain:\n${findings.join("\n")}`,
        };
      }
    }
  }

  const subject = conventionalSubject(input.task, undefined, {
    style: p.config.commits.style,
    ...(p.config.commits.scopes ? { scope: repo.name } : {}),
  });
  const commit = await commitAll(dir, subject, { "Change-Id": changeId });
  return {
    repo: repo.name,
    branch,
    ...(commit === undefined ? {} : { commit }),
    ok: true,
    detail: commit === undefined ? "nothing to commit" : `committed ${commit.slice(0, 12)}`,
  };
}
