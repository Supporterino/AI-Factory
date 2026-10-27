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
import { factoryDir, readOrCorrupt } from "../../state/files.ts";
import { loadRun, type RunState, scanRuns, type TaskState, updateRun } from "../../state/run.ts";
import { formatTokens, summarizeUsage, totalTokens, usageLine } from "../../usage/usage.ts";
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
  // `.opencode` holds the change's agent snapshot, not a worktree.
  return readdirSync(dir)
    .filter((repo) => repo !== ".opencode")
    .flatMap((repo) =>
      readdirSync(join(dir, repo)).map((task) => `.factory/worktrees/${id}/${repo}/${task}`),
    );
}

/** One frame of `status`; `--watch` calls this with a collecting `Io`. */
function renderStatus(io: Io, root: string, positionals: readonly string[]): void {
  // Corrupt state files are shown, not fatal: status is how they are found (audit P15).
  const lock = readOrCorrupt(() => readActive(root));
  const active = lock.value;
  const queued = readOrCorrupt(() => readQueue(root));
  const queue = queued.value?.entries.map((e) => e.changeId) ?? [];
  const { runs, corrupt } =
    positionals.length > 0
      ? { runs: [requireRun(root, changeId("status", positionals))], corrupt: [] }
      : scanRuns(root);

  if (positionals.length === 0) {
    io.out(
      lock.corrupt
        ? `active: unreadable: ${lock.corrupt.message}\n  ${lock.corrupt.fix}`
        : active
          ? `active: ${active.changeId}`
          : "active: none",
    );
    io.out(
      queued.corrupt
        ? `queue: unreadable: ${queued.corrupt.message}\n  ${queued.corrupt.fix}`
        : `queue: ${queue.length > 0 ? queue.join(", ") : "empty"}`,
    );
    if (runs.length === 0 && corrupt.length === 0)
      io.out('no changes yet (start one with `ai-factory run "<request>"`)');
  }
  for (const run of runs) printRun(io, root, run, active, queue.indexOf(run.id));
  for (const c of corrupt)
    io.out(`change ${c.id} — unreadable: ${c.error.message}\n  ${c.error.fix}`);
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
  if (run.mergeSeq > 0) {
    const lag = run.mergeSeq - run.graphSeq;
    io.out(
      `  graph: covers ${run.graphSeq} of ${run.mergeSeq} merges${lag > 0 ? ` (${lag} pending)` : ""}`,
    );
  }
  if (run.tasks.length > 0) {
    io.out(`  tasks: ${merged}/${run.tasks.length} merged (merge seq ${run.mergeSeq})`);
    const byStep = summarizeUsage(root, run.id).byStep;
    const taskTokens = new Map(Object.entries(byStep).map(([step, u]) => [step, totalTokens(u)]));
    const idWidth = Math.max(...run.tasks.map((t) => t.id.length));
    const repoWidth = Math.max(...run.tasks.map((t) => t.repo.length));
    for (const t of run.tasks) {
      const tokens = taskTokens.get(t.id);
      io.out(
        `    ${ICON[t.status]} ${t.id.padEnd(idWidth)} ${t.repo.padEnd(repoWidth)} ${t.title} — ${taskDetail(run, t)}${tokens ? ` · ${formatTokens(tokens)} tok` : ""}`,
      );
      if (t.status !== "merged" && t.lastGateOutput) {
        for (const line of t.lastGateOutput.split("\n").slice(0, 5)) io.out(`        ${line}`);
      }
    }
  }
  // Later phases' results (audit G4).
  const suite = Object.entries(run.fullSuite);
  if (suite.length > 0)
    io.out(
      `  full suite: ${suite.map(([repo, r]) => `${repo} ${r.passed ? "✓" : "✗"}`).join(", ")}`,
    );
  for (const [key, r] of Object.entries(run.contractResults))
    io.out(`  contracts: ${key} ${r.passed ? "✓" : `✗ (${r.summary})`}`);
  if (run.pointerCommit !== undefined)
    io.out(
      `  pointers: ${run.pointerCommit.slice(0, 12)} (provisional${run.pointers.length > 0 ? `; ${run.pointers.join(", ")}` : ""})`,
    );
  const worktrees = worktreesOf(root, run.id);
  if (worktrees.length > 0) io.out(`  worktrees: ${worktrees.join(", ")}`);
  const usage = summarizeUsage(root, run.id);
  if (usage.sessions > 0) {
    io.out(`  usage: ${usageLine(usage.total)} in ${usage.sessions} sessions`);
    const agents = Object.entries(usage.byAgent)
      .sort((a, b) => totalTokens(b[1]) - totalTokens(a[1]))
      .map(([agent, u]) => `${agent} ${formatTokens(totalTokens(u))}`);
    io.out(`    by agent: ${agents.join(", ")}`);
    io.out(
      `    retry overhead: ${formatTokens(totalTokens(usage.retryOverhead))} · wasted re-reads: ${usage.wastedReads}`,
    );
  }
}

export const statusCommand: Command = {
  name: "status",
  summary: "Show the active change, the queue, task states and branches",
  help: `Usage: ai-factory status [<change-id>] [--json] [--watch [--interval <seconds>]]

Without an id: the active change (if any), the queue and every known change.
With an id: that change's phase, branches, task DAG with states, retries and worktrees.

  --watch            Reprint the same view every few seconds until Ctrl-C (a second
                     terminal is the easiest way to watch a long run)
  --interval <s>     Seconds between frames with --watch (default 2)`,
  async run(args, io) {
    const { values, positionals } = parseCommandArgs(
      "status",
      args,
      {
        json: { type: "boolean", default: false },
        watch: { type: "boolean", default: false },
        interval: { type: "string" },
      },
      true,
    );
    if (values.watch && values.json)
      throw new UsageError("status: --watch and --json exclude each other");
    const root = await workspace(io);
    if (positionals.length > 0) changeId("status", positionals);
    if (values.watch) {
      const seconds = values.interval === undefined ? 2 : Number(values.interval);
      if (!Number.isFinite(seconds) || seconds <= 0)
        throw new UsageError("status: --interval must be a positive number of seconds");
      await watchStatus(io, root, positionals, Math.max(10, Math.round(seconds * 1000)));
      return ExitCode.Ok;
    }
    if (!values.json) {
      renderStatus(io, root, positionals);
      return ExitCode.Ok;
    }
    // Corrupt state files are shown, not fatal: status is how they are found (audit P15).
    const lock = readOrCorrupt(() => readActive(root));
    const active = lock.value;
    const queued = readOrCorrupt(() => readQueue(root));
    const queue = queued.value?.entries.map((e) => e.changeId) ?? [];
    const { runs, corrupt } =
      positionals.length > 0
        ? { runs: [requireRun(root, changeId("status", positionals))], corrupt: [] }
        : scanRuns(root);
    io.out(
      JSON.stringify(
        {
          active: active ?? null,
          driverAlive: active ? driverAlive(active) : false,
          queue,
          runs: runs.map((r) => ({ ...r, usage: summarizeUsage(root, r.id) })),
          corrupt: [
            ...[lock.corrupt, queued.corrupt]
              .filter((e) => e !== undefined)
              .map((e) => ({ file: e.file, error: e.message })),
            ...corrupt.map((c) => ({ id: c.id, file: c.error.file, error: c.error.message })),
          ],
        },
        null,
        2,
      ),
    );
    return ExitCode.Ok;
  },
};

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    function done(): void {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** `status --watch`: one frame per interval, cleared on a terminal, separated when piped. */
async function watchStatus(
  io: Io,
  root: string,
  positionals: readonly string[],
  intervalMs: number,
): Promise<void> {
  let first = true;
  while (io.signal?.aborted !== true) {
    const lines: string[] = [];
    renderStatus({ ...io, out: (line) => lines.push(line) }, root, positionals);
    if (io.tty === true) io.out("\x1b[2J\x1b[H");
    else if (!first) io.out("");
    io.out(`updated ${new Date().toLocaleTimeString()} · Ctrl-C to stop`);
    for (const line of lines) io.out(line);
    first = false;
    await sleep(intervalMs, io.signal);
  }
}

export const abortCommand: Command = {
  name: "abort",
  summary: "Stop a change safely; keep branches and worktrees",
  help: `Usage: ai-factory abort <change-id>

Marks the change aborted and removes it from the queue. A process driving it stops at its
next safe point in any phase (it interrupts running agents) and then frees the workspace;
if nothing drives it, the active-change lock is released at once. Branches and worktrees
are kept for inspection. The next queued change is not started automatically; \`resume\`
the aborted change (or another one) when you are ready.`,
  async run(args, io) {
    const { positionals } = parseCommandArgs("abort", args, {}, true);
    const id = changeId("abort", positionals);
    const root = await workspace(io);
    const run = requireRun(root, id);
    if (run.phase === "done") throw new PreconditionError(`${id} is already closed`);
    // Read first: a corrupt lock refuses the abort before anything changed.
    const active = readActive(root);
    await updateRun(root, id, (draft) => {
      draft.abortRequested = true;
      draft.phase = "aborted";
    });
    await removeFromQueue(root, id);
    // A live driver in another process stops at its next safe point and frees the
    // workspace itself; otherwise nothing is running and the lock goes now.
    const driver =
      active?.changeId === id &&
      active.pid !== null &&
      active.pid !== process.pid &&
      driverAlive(active)
        ? active.pid
        : undefined;
    if (driver === undefined) await releaseActive(root, id);
    io.out(
      driver === undefined
        ? `aborted ${id}`
        : `aborted ${id}; pid ${driver} stops at its next safe point and frees the workspace`,
    );
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
