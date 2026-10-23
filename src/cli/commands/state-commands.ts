import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { findWorkspaceRoot } from "../../config/load.ts";
import { PreconditionError, UsageError } from "../../errors.ts";
import { CHANGE_ID } from "../../git/repo.ts";
import { retryTask } from "../../scheduler/scheduler.ts";
import {
  type ActiveLock,
  driverAlive,
  readActive,
  readQueue,
  releaseActive,
  removeFromQueue,
} from "../../state/active.ts";
import { factoryDir } from "../../state/files.ts";
import { listRuns, loadRun, type RunState, type TaskState, updateRun } from "../../state/run.ts";
import { type Command, type Io, parseCommandArgs } from "../command.ts";
import { ExitCode } from "../exit-codes.ts";

async function workspace(io: Io): Promise<string> {
  const root = await findWorkspaceRoot(io.cwd);
  if (root === undefined) throw new PreconditionError("not inside a git repository");
  return root;
}

function changeId(command: string, positionals: readonly string[]): string {
  const id = positionals[0];
  if (id === undefined || positionals.length > 1)
    throw new UsageError(`${command}: expected exactly one <change-id>`);
  if (!CHANGE_ID.test(id)) throw new UsageError(`${command}: invalid change id "${id}"`);
  return id;
}

function requireRun(root: string, id: string): RunState {
  const run = loadRun(root, id);
  if (run === undefined) throw new PreconditionError(`no change ${id} in this workspace`);
  return run;
}

const ICON: Record<TaskState["status"], string> = {
  pending: "·",
  running: "▶",
  merging: "⇢",
  merged: "✓",
  failed: "✗",
  cancelled: "⊘",
};

function taskDetail(run: RunState, task: TaskState): string {
  const merged = (id: string) => run.tasks.find((t) => t.id === id)?.status === "merged";
  switch (task.status) {
    case "merged":
      return `merged ${task.commit?.slice(0, 12) ?? ""}`.trim();
    case "failed":
      return `failed: ${task.lastError ?? "unknown"}`;
    case "cancelled":
      return "cancelled (a dependency failed)";
    case "pending": {
      const waiting = task.deps.filter((d) => !merged(d));
      const base = waiting.length > 0 ? `waiting on ${waiting.join(", ")}` : "ready";
      return task.serial ? `${base} (serial)` : base;
    }
    default:
      return `${task.status} · attempt ${task.failures + 1}`;
  }
}

function worktreesOf(root: string, id: string): string[] {
  const dir = factoryDir(root, "worktrees", id);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((repo) =>
    readdirSync(join(dir, repo)).map((task) => `.factory/worktrees/${id}/${repo}/${task}`),
  );
}

function printRun(
  io: Io,
  root: string,
  run: RunState,
  active: ActiveLock | undefined,
  queuePos: number,
): void {
  const role =
    active?.changeId === run.id
      ? `active, ${driverAlive(active) ? `driven by pid ${active.pid}` : "no process driving it (resume to continue)"}`
      : queuePos >= 0
        ? `queued #${queuePos + 1}`
        : "not active";
  io.out(`change ${run.id} — ${run.phase} (${role}; factory ${run.factoryVersion})`);
  if (run.pausedReason) io.out(`  paused: ${run.pausedReason}`);
  if (run.abortRequested) io.out("  abort requested");
  const branches = Object.entries(run.branches).map(
    ([repo, b]) => `${repo} ${b.branch} @${b.base.slice(0, 12)}`,
  );
  if (branches.length > 0) io.out(`  branches: ${branches.join(" · ")}`);
  const merged = run.tasks.filter((t) => t.status === "merged").length;
  if (run.tasks.length > 0) {
    io.out(`  tasks: ${merged}/${run.tasks.length} merged (merge seq ${run.mergeSeq})`);
    const idWidth = Math.max(...run.tasks.map((t) => t.id.length));
    const repoWidth = Math.max(...run.tasks.map((t) => t.repo.length));
    for (const t of run.tasks) {
      io.out(
        `    ${ICON[t.status]} ${t.id.padEnd(idWidth)} ${t.repo.padEnd(repoWidth)} ${t.title} — ${taskDetail(run, t)}`,
      );
      if (t.status !== "merged" && t.lastGateOutput) {
        for (const line of t.lastGateOutput.split("\n").slice(0, 5)) io.out(`        ${line}`);
      }
    }
  }
  const worktrees = worktreesOf(root, run.id);
  if (worktrees.length > 0) io.out(`  worktrees: ${worktrees.join(", ")}`);
}

export const statusCommand: Command = {
  name: "status",
  summary: "Show the active change, the queue, task states and branches",
  help: `Usage: ai-factory status [<change-id>] [--json]

Without an id: the active change (if any), the queue and every known change.
With an id: that change's phase, branches, task DAG with states, retries and worktrees.`,
  async run(args, io) {
    const { values, positionals } = parseCommandArgs(
      "status",
      args,
      { json: { type: "boolean", default: false } },
      true,
    );
    const root = await workspace(io);
    const active = readActive(root);
    const queue = readQueue(root).entries.map((e) => e.changeId);
    const runs =
      positionals.length > 0 ? [requireRun(root, changeId("status", positionals))] : listRuns(root);

    if (values.json) {
      io.out(
        JSON.stringify(
          {
            active: active ?? null,
            driverAlive: active ? driverAlive(active) : false,
            queue,
            runs,
          },
          null,
          2,
        ),
      );
      return ExitCode.Ok;
    }
    if (positionals.length === 0) {
      io.out(active ? `active: ${active.changeId}` : "active: none");
      io.out(`queue: ${queue.length > 0 ? queue.join(", ") : "empty"}`);
      if (runs.length === 0) io.out('no changes yet (start one with `ai-factory run "<request>"`)');
    }
    for (const run of runs) printRun(io, root, run, active, queue.indexOf(run.id));
    return ExitCode.Ok;
  },
};

export const abortCommand: Command = {
  name: "abort",
  summary: "Stop a change safely; keep branches and worktrees",
  help: `Usage: ai-factory abort <change-id>

Asks the process driving the change to stop (it finishes in-flight merges and interrupts
agents), marks the change aborted, removes it from the queue and releases the
active-change lock. Branches and worktrees are kept for inspection. The next queued
change is not started automatically; resume it when you are ready.`,
  async run(args, io) {
    const { positionals } = parseCommandArgs("abort", args, {}, true);
    const id = changeId("abort", positionals);
    const root = await workspace(io);
    const run = requireRun(root, id);
    if (run.phase === "done") throw new PreconditionError(`${id} is already closed`);
    await updateRun(root, id, (draft) => {
      draft.abortRequested = true;
      draft.phase = "aborted";
    });
    await removeFromQueue(root, id);
    await releaseActive(root, id);
    io.out(`aborted ${id}`);
    const branches = Object.entries(run.branches).map(([repo, b]) => `${repo}: ${b.branch}`);
    if (branches.length > 0) io.out(`kept branches: ${branches.join(", ")}`);
    const worktrees = worktreesOf(root, id);
    if (worktrees.length > 0) io.out(`kept worktrees: ${worktrees.join(", ")}`);
    return ExitCode.Ok;
  },
};

export const retryCommand: Command = {
  name: "retry",
  summary: "Reset a failed task's retry budget after a human fix",
  help: `Usage: ai-factory retry <change-id> --task <id>

Puts a failed task back in the queue with a fresh retry budget and un-cancels the tasks
that were cancelled because of it. Continue the change with \`ai-factory resume <id>\`.`,
  async run(args, io) {
    const { values, positionals } = parseCommandArgs(
      "retry",
      args,
      { task: { type: "string" } },
      true,
    );
    const id = changeId("retry", positionals);
    if (values.task === undefined) throw new UsageError("retry: --task <id> is required");
    const root = await workspace(io);
    const task = requireRun(root, id).tasks.find((t) => t.id === values.task);
    if (task === undefined) throw new UsageError(`retry: ${id} has no task ${values.task}`);
    if (task.status !== "failed")
      throw new PreconditionError(`task ${task.id} is ${task.status}, not failed`);
    const next = await updateRun(root, id, (draft) => retryTask(draft, task.id));
    const revived = next.tasks.filter((t) => t.status === "pending").map((t) => t.id);
    io.out(`requeued ${task.id} with a fresh retry budget (pending: ${revived.join(", ")})`);
    io.out(`continue with \`ai-factory resume ${id}\``);
    return ExitCode.Ok;
  },
};
