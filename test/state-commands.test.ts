import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ExitCode } from "../src/cli/exit-codes.ts";
import { claimActive, enqueue, readActive, readQueue } from "../src/state/active.ts";
import { loadRun, newRun, saveRun, TaskState } from "../src/state/run.ts";
import { createSingleRepoFixture, type Fixture } from "./fixtures/workspaces.ts";
import { cli } from "./helpers.ts";

describe("status, retry and abort", () => {
  let fx: Fixture;
  beforeEach(async () => {
    fx = await createSingleRepoFixture();
    const run = newRun("add-x", "Add a health endpoint", "paused");
    run.pausedReason = "failed: 1.1; cancelled: 1.2";
    run.branches = { ".": { branch: "change/add-x", base: "0123456789abcdef" } };
    const t = (id: string, status: TaskState["status"], extra: Partial<TaskState> = {}) =>
      TaskState.parse({
        id,
        title: `Task ${id}`,
        repo: "app",
        deps: [],
        touches: ["src/**"],
        status,
        ...extra,
      });
    run.tasks = [
      t("1.1", "failed", {
        failures: 4,
        lastError: "lint; retry budget (3) exhausted",
        lastGateOutput: "src/sum.ts:1 error",
      }),
      t("1.2", "cancelled", { deps: ["1.1"] }),
      t("1.3", "merged", { commit: "abcdef0123456789" }),
    ];
    saveRun(fx.root, run);
    saveRun(fx.root, newRun("next-thing", "later", "queued"));
    await claimActive(fx.root, "add-x");
    await enqueue(fx.root, "next-thing");
  });
  afterEach(() => fx.cleanup());

  test("status shows the active change, the queue and the task DAG", async () => {
    const run = await cli(fx.root, "status", "add-x");
    expect(run.code).toBe(ExitCode.Ok);
    expect(run.out.split("\n")).toEqual([
      `change add-x — paused (active, driven by pid ${process.pid}; factory 0.1.0)`,
      "  paused: failed: 1.1; cancelled: 1.2",
      "  branches: . change/add-x @0123456789ab",
      "  tasks: 1/3 merged (merge seq 0)",
      "    ✗ 1.1 app Task 1.1 — failed: lint; retry budget (3) exhausted",
      "        src/sum.ts:1 error",
      "    ⊘ 1.2 app Task 1.2 — cancelled (a dependency failed)",
      "    ✓ 1.3 app Task 1.3 — merged abcdef012345",
    ]);
    const all = await cli(fx.root, "status", "--json");
    const json = JSON.parse(all.out) as {
      active: { changeId: string };
      queue: string[];
      runs: { id: string }[];
    };
    expect(json.active.changeId).toBe("add-x");
    expect(json.queue).toEqual(["next-thing"]);
    expect(json.runs.map((r) => r.id).sort()).toEqual(["add-x", "next-thing"]);
  });

  test("retry requeues a failed task and its cancelled dependents", async () => {
    expect((await cli(fx.root, "retry", "add-x", "--task", "1.3")).code).toBe(
      ExitCode.Precondition,
    );
    const run = await cli(fx.root, "retry", "add-x", "--task", "1.1");
    expect(run.code).toBe(ExitCode.Ok);
    expect(run.out).toContain("requeued 1.1 with a fresh retry budget (pending: 1.1, 1.2)");
    const state = loadRun(fx.root, "add-x");
    expect(state?.tasks.map((t) => [t.id, t.status, t.failures])).toEqual([
      ["1.1", "pending", 0],
      ["1.2", "pending", 0],
      ["1.3", "merged", 0],
    ]);
  });

  test("abort marks the change, releases the lock and leaves the queue to the user", async () => {
    const run = await cli(fx.root, "abort", "add-x");
    expect(run.code).toBe(ExitCode.Ok);
    expect(run.out).toContain("kept branches: .: change/add-x");
    expect(loadRun(fx.root, "add-x")).toMatchObject({ phase: "aborted", abortRequested: true });
    expect(readActive(fx.root)).toBeUndefined();
    expect(readQueue(fx.root).entries.map((e) => e.changeId)).toEqual(["next-thing"]);
    expect((await cli(fx.root, "abort", "nope")).code).toBe(ExitCode.Precondition);
  });
});
