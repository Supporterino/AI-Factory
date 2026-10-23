import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AttemptContext,
  type AttemptResult,
  type MergeResult,
  retryTask,
  Scheduler,
  type TaskRunner,
} from "../src/scheduler/scheduler.ts";
import {
  claimActive,
  dequeue,
  enqueue,
  readActive,
  readQueue,
  releaseActive,
  releaseDriver,
} from "../src/state/active.ts";
import { loadRun, newRun, type RunState, saveRun, TaskState, updateRun } from "../src/state/run.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ai-factory-sched-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

interface Spec {
  id: string;
  repo?: string;
  deps?: string[];
  touches?: string[];
}

function seed(specs: Spec[], mutate: (s: RunState) => void = () => {}): void {
  const state = newRun("add-x", "request", "implementing");
  state.tasks = specs.map((s) =>
    TaskState.parse({
      id: s.id,
      title: `Task ${s.id}`,
      repo: s.repo ?? "backend",
      deps: s.deps ?? [],
      touches: s.touches ?? [`${s.id}/**`],
      status: "pending",
    }),
  );
  mutate(state);
  saveRun(root, state);
}

/** Scripted runner: per-task attempt outcomes, delays and a concurrency log. */
class FakeRunner implements TaskRunner {
  attempts = new Map<string, AttemptResult[]>();
  merges = new Map<string, MergeResult[]>();
  resolves = new Map<string, boolean>();
  delay = 20;
  running = 0;
  maxRunning = 0;
  log: string[] = [];
  feedback: Record<string, (string | undefined)[]> = {};
  resets: string[] = [];
  afterMerges: number[] = [];
  afterMergeRunning = 0;
  afterMergeMax = 0;
  onAttempt?: (task: TaskState) => Promise<void> | void;

  async attempt(task: TaskState, ctx: AttemptContext): Promise<AttemptResult> {
    this.running++;
    this.maxRunning = Math.max(this.maxRunning, this.running);
    this.log.push(`start ${task.id}`);
    const seen = this.feedback[task.id] ?? [];
    seen.push(ctx.feedback);
    this.feedback[task.id] = seen;
    await this.onAttempt?.(task);
    await Bun.sleep(this.delay);
    this.running--;
    this.log.push(`end ${task.id}`);
    return this.attempts.get(task.id)?.shift() ?? { status: "passed", commit: `c-${task.id}` };
  }

  async merge(task: TaskState): Promise<MergeResult> {
    this.log.push(`merge ${task.id}`);
    return this.merges.get(task.id)?.shift() ?? { status: "merged", commit: `m-${task.id}` };
  }

  async resolveConflict(task: TaskState): Promise<boolean> {
    this.log.push(`resolve ${task.id}`);
    return this.resolves.get(task.id) ?? true;
  }

  async reset(task: TaskState): Promise<void> {
    this.resets.push(task.id);
  }

  async afterMerge(_task: TaskState, seq: number): Promise<void> {
    this.afterMergeRunning++;
    this.afterMergeMax = Math.max(this.afterMergeMax, this.afterMergeRunning);
    await Bun.sleep(5);
    this.afterMerges.push(seq);
    this.afterMergeRunning--;
  }
}

const schedule = (
  runner: TaskRunner,
  extra: { maxAgents?: number; maxRetries?: number; serialRepos?: string[] } = {},
) =>
  new Scheduler({
    root,
    id: "add-x",
    maxAgents: extra.maxAgents ?? 4,
    maxRetries: extra.maxRetries ?? 3,
    runner,
    ...(extra.serialRepos ? { serialRepos: extra.serialRepos } : {}),
  }).run();

const task = (id: string) => loadRun(root, "add-x")?.tasks.find((t) => t.id === id);
const concurrent = (log: string[], a: string, b: string) =>
  log.indexOf(`start ${b}`) < log.indexOf(`end ${a}`) &&
  log.indexOf(`start ${a}`) < log.indexOf(`end ${b}`);

describe("Scheduler", () => {
  test("never exceeds maxAgents and merges everything", async () => {
    seed(["1.1", "1.2", "2.1", "2.2", "3.1", "3.2"].map((id) => ({ id, repo: `r${id[0]}` })));
    const runner = new FakeRunner();
    const summary = await schedule(runner, { maxAgents: 2 });
    expect(runner.maxRunning).toBe(2);
    expect(summary).toEqual({
      status: "complete",
      merged: ["1.1", "1.2", "2.1", "2.2", "3.1", "3.2"],
      failed: [],
      cancelled: [],
      pending: [],
    });
    expect(loadRun(root, "add-x")?.mergeSeq).toBe(6);
  });

  test("overlapping touches in one repo never run together; disjoint ones do", async () => {
    seed([
      { id: "1.1", touches: ["internal/http/**"] },
      { id: "1.2", touches: ["internal/http/health.go"] },
      { id: "1.3", touches: ["internal/db/**"] },
    ]);
    const runner = new FakeRunner();
    await schedule(runner);
    expect(concurrent(runner.log, "1.1", "1.2")).toBe(false);
    expect(concurrent(runner.log, "1.1", "1.3")).toBe(true);
    // 1.2 starts only after 1.1 merged, so it builds on it.
    expect(runner.log.indexOf("merge 1.1")).toBeLessThan(runner.log.indexOf("start 1.2"));
  });

  test("dependencies wait for the merge; serial repos run one task at a time", async () => {
    seed([
      { id: "1.1" },
      { id: "2.1", repo: "frontend", deps: ["1.1"] },
      { id: "3.1", repo: "deploy" },
      { id: "3.2", repo: "deploy" },
    ]);
    const runner = new FakeRunner();
    await schedule(runner, { serialRepos: ["deploy"] });
    expect(runner.log.indexOf("merge 1.1")).toBeLessThan(runner.log.indexOf("start 2.1"));
    expect(concurrent(runner.log, "3.1", "3.2")).toBe(false);
  });

  test("gate failures retry with feedback, then pass", async () => {
    seed([{ id: "1.1" }]);
    const runner = new FakeRunner();
    runner.attempts.set("1.1", [
      { status: "gate-failed", output: "lint: e1" },
      { status: "gate-failed", output: "lint: e2" },
      { status: "gate-failed", output: "lint: e3" },
    ]);
    expect((await schedule(runner)).status).toBe("complete");
    expect(runner.feedback["1.1"]).toEqual([undefined, "lint: e1", "lint: e2", "lint: e3"]);
    expect(task("1.1")).toMatchObject({ status: "merged", failures: 3 });
  });

  test("an exhausted budget fails the task, cancels only its dependents and pauses", async () => {
    seed([
      { id: "1.1" },
      { id: "1.2", deps: ["1.1"] },
      { id: "1.3", deps: ["1.2"] },
      { id: "2.1", repo: "frontend" },
    ]);
    const runner = new FakeRunner();
    runner.attempts.set(
      "1.1",
      Array.from(
        { length: 4 },
        (_, i) => ({ status: "gate-failed", output: `fail ${i}` }) as const,
      ),
    );
    const summary = await schedule(runner);
    expect(summary).toEqual({
      status: "paused",
      merged: ["2.1"],
      failed: ["1.1"],
      cancelled: ["1.2", "1.3"],
      pending: [],
    });
    expect(task("1.1")?.failures).toBe(4);
    expect(task("1.1")?.lastError).toContain("retry budget (3) exhausted");
    expect(task("1.1")?.lastGateOutput).toBe("fail 3");
    const run = loadRun(root, "add-x");
    expect(run?.phase).toBe("paused");
    expect(run?.pausedReason).toBe("failed: 1.1; cancelled: 1.2, 1.3");
  });

  test("retry resets the budget and un-cancels dependents", async () => {
    seed([{ id: "1.1" }, { id: "1.2", deps: ["1.1"] }]);
    const runner = new FakeRunner();
    runner.attempts.set(
      "1.1",
      Array.from({ length: 4 }, () => ({ status: "gate-failed", output: "x" }) as const),
    );
    await schedule(runner);
    await updateRun(root, "add-x", (draft) => retryTask(draft, "1.1"));
    expect(task("1.1")).toMatchObject({ status: "pending", failures: 0 });
    expect(task("1.2")?.status).toBe("pending");
    expect((await schedule(new FakeRunner())).status).toBe("complete");
  });

  test("blocked agents fail at once; runner errors count against the budget", async () => {
    seed([{ id: "1.1" }, { id: "2.1", repo: "frontend" }]);
    const runner = new FakeRunner();
    runner.attempts.set("1.1", [{ status: "blocked", reason: "needs db/migrations" }]);
    runner.onAttempt = (t) => {
      if (t.id === "2.1" && t.failures === 0) throw new Error("opencode crashed");
    };
    const summary = await schedule(runner);
    expect(summary.failed).toEqual(["1.1"]);
    expect(task("1.1")?.lastError).toBe("blocked: needs db/migrations");
    expect(task("2.1")).toMatchObject({ status: "merged", failures: 1 });
  });

  test("a merge conflict gets one resolution attempt, counted against the budget", async () => {
    seed([{ id: "1.1" }]);
    const runner = new FakeRunner();
    runner.merges.set("1.1", [{ status: "conflict", conflicts: ["main.go"] }]);
    expect((await schedule(runner)).status).toBe("complete");
    expect(runner.log.filter((l) => l.startsWith("merge") || l.startsWith("resolve"))).toEqual([
      "merge 1.1",
      "resolve 1.1",
      "merge 1.1",
    ]);
    expect(task("1.1")?.failures).toBe(1);
  });

  test("an unresolved conflict requeues the task to run serially from scratch", async () => {
    seed([{ id: "1.1" }, { id: "1.2" }]);
    const runner = new FakeRunner();
    runner.merges.set("1.1", [{ status: "conflict", conflicts: ["main.go"] }]);
    runner.resolves.set("1.1", false);
    expect((await schedule(runner)).status).toBe("complete");
    expect(runner.resets).toEqual(["1.1"]);
    expect(task("1.1")).toMatchObject({ status: "merged", serial: true });
    expect(runner.log.filter((l) => l === "start 1.1")).toHaveLength(2);
  });

  test("gates failing after the rebase go back to implementation", async () => {
    seed([{ id: "1.1" }]);
    const runner = new FakeRunner();
    runner.merges.set("1.1", [{ status: "gates-failed", output: "types: broke after rebase" }]);
    expect((await schedule(runner)).status).toBe("complete");
    expect(runner.feedback["1.1"]).toEqual([undefined, "types: broke after rebase"]);
  });

  test("graph updates after merges run one at a time in merge order", async () => {
    seed(["1.1", "2.1", "3.1", "4.1"].map((id) => ({ id, repo: `r${id[0]}` })));
    const runner = new FakeRunner();
    runner.delay = 1;
    await schedule(runner);
    expect(runner.afterMergeMax).toBe(1);
    expect(runner.afterMerges).toEqual([1, 2, 3, 4]);
  });

  test("crash → resume: interrupted tasks restart, finished ones stay", async () => {
    seed([{ id: "1.1" }, { id: "1.2" }, { id: "1.3" }], (s) => {
      const [a, b, c] = s.tasks;
      if (a && b && c) {
        a.status = "merged";
        b.status = "running";
        c.status = "merging";
      }
    });
    const runner = new FakeRunner();
    expect((await schedule(runner)).status).toBe("complete");
    expect(runner.log.some((l) => l === "start 1.1")).toBe(false);
    expect(task("1.2")?.history.map((h) => h.event)).toContain("recovered");
  });

  test("an abort requested by another process stops dispatch and keeps work resumable", async () => {
    seed(["1.1", "1.2", "1.3", "1.4"].map((id) => ({ id })));
    const runner = new FakeRunner();
    runner.delay = 30;
    runner.onAttempt = async (t) => {
      if (t.id === "1.1") {
        await updateRun(root, "add-x", (d) => {
          d.abortRequested = true;
        });
      }
    };
    const summary = await schedule(runner, { maxAgents: 1 });
    expect(summary.status).toBe("aborted");
    expect(summary.pending.length).toBeGreaterThan(0);
    expect(runner.log.filter((l) => l.startsWith("start"))).toEqual(["start 1.1"]);
  });
});

describe("active change lock and queue", () => {
  test("one active change; a second is busy; a dead driver can be replaced", async () => {
    expect(await claimActive(root, "a")).toEqual({ status: "acquired", tookOver: false });
    expect((await claimActive(root, "b")).status).toBe("busy");
    // Same change, another live process: running.
    expect((await claimActive(root, "a", process.ppid)).status).toBe("running");

    const dead = spawnSync("true").pid ?? 999_999;
    await releaseActive(root, "a");
    expect(await claimActive(root, "a", dead)).toEqual({ status: "acquired", tookOver: false });
    expect(await claimActive(root, "a")).toEqual({ status: "acquired", tookOver: true });

    await releaseDriver(root, "a");
    expect(readActive(root)).toMatchObject({ changeId: "a", pid: null });
    expect((await claimActive(root, "b")).status).toBe("busy");
    await releaseActive(root, "a");
    expect(readActive(root)).toBeUndefined();
  });

  test("approved changes queue in order", async () => {
    await enqueue(root, "b");
    await enqueue(root, "c");
    await enqueue(root, "b");
    expect(readQueue(root).entries.map((e) => e.changeId)).toEqual(["b", "c"]);
    expect(await dequeue(root)).toBe("b");
    expect(await dequeue(root)).toBe("c");
    expect(await dequeue(root)).toBeUndefined();
  });
});
