import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { checkApprovalHash } from "../approval/approval.ts";
import { instructionPaths } from "../config/instructions.ts";
import { type FactoryConfig, repoLanguages } from "../config/schema.ts";
import { PreconditionError } from "../errors.ts";
import { git, gitOk } from "../exec.ts";
import { changedFiles } from "../gates/affected.ts";
import { changedGateDefinitions } from "../gates/definitions.ts";
import { installDeps } from "../gates/install.ts";
import { resolveGates } from "../gates/resolve.ts";
import { type GateReport, runGates } from "../gates/run.ts";
import { worktreeFiles } from "../gates/targets.ts";
import { branchSubmodule } from "../git/branching.ts";
import { commitTask } from "../git/commit.ts";
import { abortRebase, mergeTask } from "../git/merge-queue.ts";
import { changeBranch, currentBranch, ensureClean, refExists } from "../git/repo.ts";
import { addTaskWorktree, taskBranch, worktreePath } from "../git/worktrees.ts";
import { updateGraph } from "../graph/graph.ts";
import { GraphUpdater } from "../graph/updater.ts";
import { appendLog } from "../logs/log.ts";
import { auditChanges, type SessionContext } from "../policy/scope.ts";
import { profilesFor } from "../profiles/index.ts";
import {
  type AttemptContext,
  type AttemptResult,
  type MergeResult,
  type RunSummary,
  Scheduler,
  type TaskRunner,
} from "../scheduler/scheduler.ts";
import { claimActive, enqueue, removeFromQueue } from "../state/active.ts";
import { loadRun, type TaskState } from "../state/run.ts";
import { agentForTask } from "../tasks/routing.ts";
import { type GateSnapshot, loadGateSnapshot, snapshotDefinitions } from "../update/snapshot.ts";
import { capText } from "../util/cap.ts";
import { fence } from "../util/fence.ts";
import { verifyApproval } from "./approve.ts";
import type { Pipeline } from "./context.ts";
import { conflictPrompt, packsPrompt, taskPrompt, testerPrompt } from "./prompts.ts";

/** `addons.ponytail.shortcutComments: "forbid"` turns new `shortcut:` comments into a lint failure. */
export const forbidShortcuts = (p: Pipeline): boolean =>
  p.config.addons.ponytail.enabled && p.config.addons.ponytail.shortcutComments === "forbid";

/** Gate config and tables for a change: its activation snapshot when there is one. */
export function gateDefinitions(
  p: Pipeline,
  id: string,
): { config: FactoryConfig; gateTables?: GateSnapshot["tables"] } {
  const snapshot = loadGateSnapshot(p.root, id);
  if (snapshot === undefined) return { config: p.config };
  return { config: { ...p.config, gates: snapshot.gates }, gateTables: snapshot.tables };
}

export const packPath = (root: string, id: string, task: string): string =>
  join(root, ".factory", "context", id, `${task}.md`);

export type Activation =
  | { status: "active" }
  | { status: "queued" }
  | { status: "running"; pid: number | null };

/**
 * Makes the change the workspace's active one (§11): claims the lock, moves the AI repo
 * checkout to `change/<id>` (dropping a draft worktree), re-verifies the approval and branches
 * every touched submodule. Busy → the change waits in the queue.
 */
export async function activate(p: Pipeline, id: string): Promise<Activation> {
  const claim = await claimActive(p.root, id);
  if (claim.status === "busy") {
    await enqueue(p.root, id);
    await p.update(id, (d) => {
      d.phase = "queued";
    });
    p.out(`⧗ ${id} is queued behind ${claim.holder.changeId}`);
    return { status: "queued" };
  }
  if (claim.status === "running") return { status: "running", pid: claim.holder.pid };
  // Active now, also when resumed by hand while queued: it must not be started again (P11).
  await removeFromQueue(p.root, id);

  const run = p.run(id);
  const branch = changeBranch(id);
  if (run.draft !== undefined) {
    await gitOk(["worktree", "remove", join(p.root, run.draft)], { cwd: p.root });
    await p.update(id, (d) => {
      delete d.draft;
    });
  }
  if ((await currentBranch(p.root)) !== branch) {
    await ensureClean(p.root, "the AI repo");
    await gitOk(["switch", "-q", branch], { cwd: p.root });
  }
  await verifyApproval(p, id, p.root);
  // The change runs on the definitions it started with, even across `update --force`.
  snapshotDefinitions(p.root, id, p.config, p.run(id).factoryVersion);

  const repos = [...new Set(p.run(id).tasks.map((t) => t.repo))];
  const branches: Record<string, { branch: string; base: string }> = {};
  for (const name of repos) {
    const repo = p.repo(name);
    if (repo.path === ".") {
      const base =
        p.run(id).branches["."]?.base ?? (await gitOk(["rev-parse", "HEAD"], { cwd: p.root }));
      branches[name] = { branch, base };
    } else {
      const b = await branchSubmodule(p.root, repo, id);
      branches[name] = { branch: b.branch, base: b.base };
    }
  }
  await p.update(id, (d) => {
    Object.assign(d.branches, branches);
    if (d.phase === "queued" || d.phase === "awaiting-approval") d.phase = "implementing";
    d.abortRequested = false;
  });
  return { status: "active" };
}

export function specText(p: Pipeline, id: string): string {
  const dir = join(p.root, "openspec", "changes", id, "specs");
  if (!existsSync(dir)) return "";
  const out: string[] = [];
  const walk = (d: string, rel: string): void => {
    for (const name of readdirSync(d).sort()) {
      const abs = join(d, name);
      if (statSync(abs).isDirectory()) walk(abs, `${rel}${name}/`);
      else if (name.endsWith(".md"))
        out.push(`### specs/${rel}${name}\n${readFileSync(abs, "utf8").trim()}`);
    }
  };
  walk(dir, "");
  return out.join("\n\n");
}

function fallbackPack(p: Pipeline, id: string, task: TaskState, maxTokens: number): string {
  const text = `## Task ${task.id}: ${task.title}
Repo: ${task.repo}; touches: ${task.touches.join(", ")}; deps: ${task.deps.join(", ") || "none"}.

## Spec
${specText(p, id)}`;
  return capPack(text, maxTokens);
}

function capPack(text: string, maxTokens: number): string {
  return capText(
    text,
    maxTokens,
    `(context pack truncated to ${maxTokens} tokens; query the graph for the rest)`,
  );
}

/** The change's spec for review and test prompts, capped like a pack (audit P20). */
export function cappedSpec(p: Pipeline, id: string): string {
  const cap = p.config.tokens.contextPackMaxTokens;
  return capText(
    specText(p, id),
    cap,
    `(spec truncated to ${cap} tokens; read openspec/changes/${id}/specs/ for the rest)`,
  );
}

/**
 * §7 step 5: the architect writes one context pack per task after approval. Missing packs
 * get a deterministic fallback; oversized ones are truncated to `contextPackMaxTokens`.
 */
export async function ensureContextPacks(p: Pipeline, id: string): Promise<void> {
  const cap = p.config.tokens.contextPackMaxTokens;
  const tasks = p.run(id).tasks.filter((t) => t.kind === "task" && t.status === "pending");
  const missing = tasks.filter((t) => !existsSync(packPath(p.root, id, t.id)));
  if (missing.length > 0) {
    p.out(`▶ context packs (${missing.length})`);
    mkdirSync(join(p.root, ".factory", "context", id), { recursive: true });
    const res = await p.call({
      changeId: id,
      agent: "architect",
      role: "architect",
      modelRole: "architect",
      context: { directory: p.root, workspace: p.root },
      title: `context packs ${id}`,
      step: "context-packs",
      prompt: packsPrompt(id, missing, cap),
    });
    if (res.handoff) {
      await p.update(id, (d) => {
        d.handoffs["context-packs"] = res.handoff;
      });
    }
  }
  for (const t of tasks) {
    const file = packPath(p.root, id, t.id);
    const text = existsSync(file)
      ? capPack(readFileSync(file, "utf8"), cap)
      : fallbackPack(p, id, t, cap);
    writeFileSync(file, text);
  }
}

function gateCommands(p: Pipeline, task: TaskState, worktree: string): string[] {
  const plan = resolveGates({
    config: p.config,
    repo: p.repo(task.repo),
    worktree,
    mode: "full",
    base: "HEAD",
    changed: [],
    files: worktreeFiles(worktree),
  });
  return plan.gates.map((g) => (g.cwd === "." ? g.command : `(in ${g.cwd}) ${g.command}`));
}

/** The real task runner: worktree, agent session, scope audit, gates, commit, merge. */
const REPEAT_NOTE = "(same failures as the previous attempt: your last change did not fix them)";

/** Whether a failed attempt reproduced the previous attempt's gate output. */
const isRepeat = (previous: string | undefined, output: string): boolean =>
  previous !== undefined && previous.replace(`${REPEAT_NOTE}\n`, "") === output;

export class PipelineTaskRunner implements TaskRunner {
  readonly #lastRegate = new Map<string, GateReport>();

  constructor(
    readonly p: Pipeline,
    readonly id: string,
    readonly graph: GraphUpdater,
  ) {}

  /** `withinRepo: "serial"`: tasks run in the repo checkout itself, no worktrees. */
  get #serial(): boolean {
    return this.p.config.parallel.withinRepo === "serial";
  }

  /** The directory the task works in: its worktree, or the repo checkout in serial mode. */
  async #workdir(task: TaskState): Promise<{ dir: string; created: boolean }> {
    const repo = this.p.repo(task.repo);
    const repoDir = this.p.repoDir(repo);
    if (this.#serial) return { dir: repoDir, created: false };
    const wt = await addTaskWorktree(this.p.root, repoDir, repo.name, this.id, task.id);
    if (wt.created) {
      await this.p.update(this.id, (d) => {
        const t = d.tasks.find((x) => x.id === task.id);
        if (t) {
          t.worktree = wt.path;
          t.branch = wt.branch;
        }
      });
    }
    return { dir: wt.path, created: wt.created };
  }

  /**
   * Serial mode shares the repo checkout: work left by another task (one that failed or was
   * interrupted) is stashed with its name before this task starts, so this task's audit does
   * not revert it, charge it, and lose the evidence (audit P10).
   */
  async #claimCheckout(task: TaskState, dir: string): Promise<void> {
    const owner = this.p.run(this.id).serialOwner[task.repo];
    if (owner !== undefined && owner !== task.id) {
      const dirty = (await gitOk(["status", "--porcelain"], { cwd: dir })) !== "";
      if (dirty) {
        const message = `ai-factory ${this.id} ${owner}: work left by the task`;
        await gitOk(["stash", "push", "-q", "--include-untracked", "-m", message], { cwd: dir });
        appendLog(this.p.root, this.id, { kind: "stashed", task: owner, note: message });
        this.p.out(`  ! ${owner} left work in ${task.repo}; kept as \`git stash\`: ${message}`);
      }
    }
    await this.p.update(this.id, (d) => {
      d.serialOwner[task.repo] = task.id;
    });
  }

  async #base(dir: string): Promise<string> {
    return gitOk(["merge-base", "HEAD", changeBranch(this.id)], { cwd: dir });
  }

  async #gates(task: TaskState, dir: string, stage = "gates"): Promise<GateReport> {
    const repo = this.p.repo(task.repo);
    const base = await this.#base(dir);
    const report = await this.p.gates.run(async () => {
      const started = this.p.progress.now();
      const report = await runGates({
        root: this.p.root,
        ...gateDefinitions(this.p, this.id),
        repo,
        worktree: dir,
        mode: "task",
        base,
        graph: { root: this.p.root, repoPath: repo.path },
        forbidShortcuts: forbidShortcuts(this.p),
        onGate: (event) => this.p.progress.gate(task.id, event, stage),
      });
      this.p.progress.gatesDone(task.id, report, this.p.progress.now() - started, stage);
      return report;
    });
    appendLog(this.p.root, this.id, {
      kind: "gates",
      task: task.id,
      passed: report.passed,
      results: report.results.map((r) => ({ type: r.type, status: r.status, command: r.command })),
    });
    return report;
  }

  #context(task: TaskState, dir: string): Omit<SessionContext, "sessionId" | "changeId" | "role"> {
    const repo = this.p.repo(task.repo);
    if (task.kind === "test") {
      return {
        directory: dir,
        workspace: this.p.root,
        repo: repo.name,
        task: task.id,
        testGlobs: profilesFor(repoLanguages(repo)).flatMap((pr) => [...pr.testGlobs]),
      };
    }
    return {
      directory: dir,
      workspace: this.p.root,
      repo: repo.name,
      task: task.id,
      touches: [...task.touches],
    };
  }

  /**
   * Agents may not commit (the factory does), but if HEAD moved anyway, its commits are undone
   * into the working tree so the audit and the task commit see every change.
   */
  async #foldAgentCommits(task: TaskState, dir: string, headBefore: string): Promise<void> {
    const head = (await gitOk(["rev-parse", "HEAD"], { cwd: dir })).trim();
    if (head === headBefore) return;
    await gitOk(["reset", "-q", "--soft", headBefore], { cwd: dir });
    appendLog(this.p.root, this.id, {
      kind: "agent-commit",
      task: task.id,
      note: `HEAD moved during the session (${headBefore.slice(0, 12)} → ${head.slice(0, 12)}); folded back for the audit`,
    });
  }

  /** Reverts files an agent changed outside its scope (shell writes bypass the plugin). */
  async #audit(task: TaskState, dir: string): Promise<string[]> {
    const changed = await changedFiles(dir, "HEAD");
    const ctx: SessionContext = {
      sessionId: "audit",
      changeId: this.id,
      role: task.kind === "test" ? "tester" : "implementer",
      ...this.#context(task, dir),
    };
    const violations = auditChanges(ctx, changed, checkApprovalHash(this.p.root, this.id).valid);
    for (const v of violations) {
      // Restore what HEAD has; a file HEAD lacks (new, possibly staged) is removed.
      const inHead = (await git(["cat-file", "-e", `HEAD:${v.path}`], { cwd: dir })).code === 0;
      if (inHead) await gitOk(["checkout", "-q", "HEAD", "--", v.path], { cwd: dir });
      else {
        await git(["rm", "-q", "--cached", "--ignore-unmatch", "--", v.path], { cwd: dir });
        rmSync(join(dir, v.path), { force: true, recursive: true });
      }
    }
    return violations.map((v) => `${v.path}: ${v.reason}`);
  }

  async attempt(task: TaskState, ctx: AttemptContext): Promise<AttemptResult> {
    // ADR-0007: the graph this task queries must already contain its dependencies' merges.
    const run = this.p.run(this.id);
    const needed = Math.max(
      0,
      ...task.deps.map((d) => run.tasks.find((t) => t.id === d)?.mergeSeq ?? 0),
    );
    await this.graph.waitFor(needed);
    const { dir } = await this.#workdir(task);
    if (this.#serial) await this.#claimCheckout(task, dir);
    else if (!task.installed) {
      // Until it succeeds, also in a kept worktree. A failure (registry down) is not the
      // task's: no budget is spent, and repeats pause the change (audit P12).
      this.p.progress.install(task.id, task.repo, "start");
      const started = this.p.progress.now();
      const steps = await installDeps(this.p.root, dir, this.p.repo(task.repo));
      const failed = steps.find((s) => s.status === "failed");
      if (failed) {
        this.p.progress.install(
          task.id,
          task.repo,
          "failed",
          this.p.progress.now() - started,
          failed.detail ?? failed.dir,
        );
        return {
          status: "transient",
          reason: `dependency install failed in ${failed.dir}: ${failed.detail ?? ""}`.trim(),
        };
      }
      this.p.progress.install(task.id, task.repo, "done", this.p.progress.now() - started);
      await this.p.update(this.id, (d) => {
        const t = d.tasks.find((x) => x.id === task.id);
        if (t) t.installed = true;
      });
    }
    const pack = existsSync(packPath(this.p.root, this.id, task.id))
      ? readFileSync(packPath(this.p.root, this.id, task.id), "utf8")
      : "";
    const gates = gateCommands(this.p, task, dir);
    const isTest = task.kind === "test";
    const prompt = isTest
      ? testerPrompt({
          task,
          spec: cappedSpec(this.p, this.id),
          testGlobs: this.#context(task, dir).testGlobs ?? [],
          gates,
          instructions: instructionPaths(this.p.config, task.repo),
        })
      : taskPrompt({
          task,
          pack,
          gates,
          ...(ctx.feedback === undefined ? {} : { feedback: ctx.feedback }),
        });

    const headBefore = (await gitOk(["rev-parse", "HEAD"], { cwd: dir })).trim();
    const routed = agentForTask(this.p.config, task.repo, task.touches);
    const res = await this.p.call({
      changeId: this.id,
      agent: isTest ? "tester" : routed.agent,
      role: isTest ? "tester" : "implementer",
      modelRole: isTest ? "tester" : "implementer",
      context: this.#context(task, dir),
      title: `${this.id} ${task.id} attempt ${ctx.attempt}`,
      label: task.title,
      step: task.id,
      kind: "attempt",
      attempt: ctx.attempt,
      prompt:
        isTest && ctx.feedback
          ? `${prompt}\n\nPrevious attempt failed:\n${fence(ctx.feedback)}`
          : prompt,
    });
    if (res.handoff) {
      await this.p.update(this.id, (d) => {
        d.handoffs[task.id] = res.handoff;
      });
    }
    if (res.outcome === "interrupted") return { status: "error", reason: "session interrupted" };
    if (res.handoff === undefined) return { status: "error", reason: res.problem ?? "no handoff" };
    if (res.handoff.status === "blocked") {
      const why =
        [...res.handoff.openQuestions, ...res.handoff.risks].join("; ") || "agent reported blocked";
      return { status: "blocked", reason: why };
    }

    await this.#foldAgentCommits(task, dir, headBefore);
    const violations = await this.#audit(task, dir);
    if (violations.length > 0) {
      return {
        status: "gate-failed",
        output: `edits outside your scope were reverted:\n${violations.join("\n")}`,
      };
    }
    // The gates check the work as the repo defined them when the change started.
    const changeBase = this.p.run(this.id).branches[task.repo]?.base;
    if (changeBase !== undefined) {
      const names = Object.values(this.p.config.gates.scripts).filter(
        (n): n is string => typeof n === "string",
      );
      const redefined = await changedGateDefinitions(dir, changeBase, names);
      if (redefined.length > 0) {
        return {
          status: "gate-failed",
          output: `you changed how your work is checked; revert these gate definitions:\n${redefined.join("\n")}`,
        };
      }
    }
    const report = await this.#gates(task, dir);
    if (!report.passed) {
      const output = report.results
        .filter((r) => r.status !== "pass" && r.status !== "skipped")
        .map((r) => `[${r.name ?? r.type}] ${r.command ?? ""}\n${r.output}`)
        .join("\n\n");
      return {
        status: "gate-failed",
        // Every attempt is a fresh session: it needs the whole output, not a diff (audit P1).
        output: isRepeat(ctx.feedback, output) ? `${REPEAT_NOTE}\n${output}` : output,
      };
    }
    // Follow-up kinds have a fixed commit type; spec tasks derive it from the title.
    const type = task.kind === "test" ? "test" : task.kind === "task" ? undefined : "fix";
    const commit = await commitTask(dir, this.id, task.id, task.title, type, {
      style: this.p.config.commits.style,
      ...(this.p.config.commits.scopes ? { scope: task.repo } : {}),
    });
    return { status: "passed", ...(commit ? { commit } : {}) };
  }

  async merge(task: TaskState): Promise<MergeResult> {
    const repo = this.p.repo(task.repo);
    const repoDir = this.p.repoDir(repo);
    if (this.#serial) {
      await this.p.update(this.id, (d) => {
        if (d.serialOwner[task.repo] === task.id) delete d.serialOwner[task.repo];
      });
      return { status: "merged", commit: await gitOk(["rev-parse", "HEAD"], { cwd: repoDir }) };
    }
    const branch = taskBranch(this.id, task.id);
    const path = worktreePath(this.p.root, this.id, repo.name, task.id);
    // Idempotent on resume: a branch already contained in change/<id> (or gone with its worktree).
    if (!existsSync(path)) {
      const merged =
        !(await refExists(repoDir, `refs/heads/${branch}`)) ||
        (
          await git(["merge-base", "--is-ancestor", branch, changeBranch(this.id)], {
            cwd: repoDir,
          })
        ).code === 0;
      if (merged)
        return {
          status: "merged",
          commit: await gitOk(["rev-parse", changeBranch(this.id)], { cwd: repoDir }),
        };
    }
    const outcome = await mergeTask({
      repoDir,
      id: this.id,
      worktree: { path, branch, created: false },
      regate: async (wt) => {
        const report = await this.#gates(task, wt, "gates after rebase");
        this.#lastRegate.set(task.id, report);
        return report.passed;
      },
    });
    if (outcome.status === "merged") return { status: "merged", commit: outcome.head };
    if (outcome.status === "conflict") return { status: "conflict", conflicts: outcome.conflicts };
    const report = this.#lastRegate.get(task.id);
    const output =
      report?.results
        .filter((r) => r.status !== "pass" && r.status !== "skipped")
        .map((r) => `[${r.name ?? r.type}] ${r.output}`)
        .join("\n\n") ?? "gates failed after the rebase";
    return { status: "gates-failed", output };
  }

  async resolveConflict(task: TaskState, conflicts: readonly string[]): Promise<boolean> {
    const path = worktreePath(this.p.root, this.id, task.repo, task.id);
    const routed = agentForTask(this.p.config, task.repo, task.touches);
    const res = await this.p.call({
      changeId: this.id,
      agent: routed.agent,
      role: "implementer",
      modelRole: "implementer",
      context: { ...this.#context(task, path), touches: ["**"] },
      title: `${this.id} ${task.id} resolve conflicts`,
      step: task.id,
      kind: "conflict",
      prompt: conflictPrompt(task, conflicts),
    });
    if (res.handoff?.status !== "done") return false;
    for (const file of conflicts) {
      const abs = join(path, file);
      if (existsSync(abs) && /^(<{7}|={7}|>{7})( |$)/m.test(readFileSync(abs, "utf8")))
        return false;
    }
    return true;
  }

  async reset(task: TaskState): Promise<void> {
    const repo = this.p.repo(task.repo);
    const repoDir = this.p.repoDir(repo);
    const path = worktreePath(this.p.root, this.id, repo.name, task.id);
    if (existsSync(path)) {
      await abortRebase(path);
      await gitOk(["worktree", "remove", "--force", path], { cwd: repoDir });
    }
    await git(["branch", "-q", "-D", taskBranch(this.id, task.id)], { cwd: repoDir });
  }

  async afterMerge(task: TaskState, seq: number): Promise<void> {
    appendLog(this.p.root, this.id, {
      kind: "merged",
      task: task.id,
      repo: task.repo,
      mergeSeq: seq,
    });
    // Incremental, serialised and coalesced; dependents wait for coverage in attempt().
    this.graph.request(seq);
  }
}

/** §7 step 6–7: run the task DAG until every task merged, or the change pauses. */
export async function implement(p: Pipeline, id: string): Promise<RunSummary> {
  const run = loadRun(p.root, id);
  if (run === undefined) throw new PreconditionError(`no change ${id}`);
  const pending = run.tasks.filter((t) => t.status !== "merged").length;
  p.progress.setChangeId(id);
  p.out(
    `▶ implement: ${pending} task${pending === 1 ? "" : "s"} (max ${p.config.parallel.maxAgents} agents)`,
  );
  const started = p.progress.now();
  const graph = new GraphUpdater(
    async () => {
      const result = await updateGraph(p.root, { changeId: id });
      if (!result.ok) p.out(`  ! graph update failed: ${result.error ?? ""}`);
    },
    run.graphSeq,
    async (seq) => {
      await p.update(id, (d) => {
        d.graphSeq = Math.max(d.graphSeq, seq);
      });
    },
  );
  // After a crash, merges the graph has not seen yet are covered first.
  if (run.mergeSeq > run.graphSeq) graph.request(run.mergeSeq);
  const scheduler = new Scheduler({
    root: p.root,
    id,
    maxAgents: p.config.parallel.maxAgents,
    maxRetries: p.config.gates.maxRetries,
    ...(p.config.parallel.withinRepo === "serial"
      ? { serialRepos: p.codeRepos().map((r) => r.name) }
      : {}),
    runner: new PipelineTaskRunner(p, id, graph),
    signal: p.deps.signal,
    observe: (event) => p.progress.task(event),
  });
  const summary = await scheduler.run();
  // Reviews and later tasks read the graph; let the last update finish.
  await graph.idle();
  p.progress.implementSummary(
    {
      merged: summary.merged.length,
      failed: summary.failed.length,
      cancelled: summary.cancelled.length,
      pending: summary.pending.length,
      total: p.run(id).tasks.length,
    },
    p.progress.now() - started,
  );
  return summary;
}
