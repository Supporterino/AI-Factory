import { describe, expect, test } from "bun:test";
import type { GateEvent, GateReport } from "../src/gates/run.ts";
import { describeTool, Progress } from "../src/pipeline/progress.ts";
import type { Usage } from "../src/runtime/types.ts";
import { TaskState } from "../src/state/run.ts";
import { formatDuration } from "../src/util/duration.ts";

const usage = (tokens = 1200): Usage => ({
  input: tokens / 2,
  output: tokens / 4,
  reasoning: 0,
  cacheRead: tokens / 8,
  cacheWrite: tokens / 8,
  cost: 0.01,
});

const collect = () => {
  const lines: string[] = [];
  return { lines, out: (line: string) => lines.push(line) };
};

const task = (id: string, repo = "app"): TaskState =>
  TaskState.parse({
    id,
    title: `Task ${id}`,
    repo,
    deps: [],
    touches: ["src/**"],
    status: "running",
  });

const report = (passed: boolean): GateReport => ({
  repo: "app",
  mode: "task",
  base: "HEAD",
  passed,
  changed: [],
  results: [
    { type: "format", status: "pass", cwd: ".", command: "fmt", durationMs: 1200, output: "" },
    {
      type: "test",
      status: passed ? "pass" : "fail",
      cwd: ".",
      command: "test",
      durationMs: 12400,
      output: "",
    },
  ],
});

const gate = (type: "format" | "test", command: string) => ({
  type,
  command,
  cwd: ".",
});

describe("formatDuration", () => {
  test("short, unambiguous units", () => {
    expect(formatDuration(0)).toBe("0ms");
    expect(formatDuration(640)).toBe("640ms");
    expect(formatDuration(12_400)).toBe("12.4s");
    expect(formatDuration(134_000)).toBe("2m14s");
    expect(formatDuration(3_720_000)).toBe("1h02m");
  });
});

describe("describeTool", () => {
  test("shows the command or path, never file contents", () => {
    expect(describeTool("bash", { command: "  bun   test  " })).toBe("bash: bun test");
    expect(describeTool("edit", { filePath: "src/x.ts", content: "secret()" })).toBe(
      "edit: src/x.ts",
    );
    expect(describeTool("grep", { pattern: "TODO" })).toBe("grep: TODO");
    expect(describeTool("mystery", { content: "no useful field" })).toBe("mystery");
  });

  test("caps long details and redacts credentials", () => {
    const long = describeTool("bash", { command: "x".repeat(300) });
    expect(long.length).toBeLessThanOrEqual(100);
    expect(long.endsWith("…")).toBe(true);
    expect(
      describeTool("bash", { command: `curl -H "Authorization: Bearer ${"a".repeat(20)}"` }),
    ).toContain("[REDACTED");
  });
});

describe("Progress", () => {
  test("normal prints lifecycle, failures, slow gates and the summary", () => {
    const { lines, out } = collect();
    let clock = 0;
    const progress = new Progress({ out, maxAttempts: 3, heartbeatMs: 0, now: () => clock });
    progress.agentStarted({
      step: "1.1",
      agent: "implementer-app",
      model: "stub/model",
      label: "Add the multiply helper",
      attempt: 1,
    });
    expect(lines.at(-1)).toBe(
      "  ▶ [1.1] Add the multiply helper · implementer-app (stub/model) · attempt 1/3",
    );
    progress.activity("1.1", { kind: "tool", tool: "bash", input: { command: "bun test" } });
    expect(lines).toHaveLength(1);
    progress.activity("1.1", {
      kind: "tool-done",
      tool: "bash",
      status: "failed",
      error: "exit 1",
    });
    expect(lines.at(-1)).toBe("  ✗ [1.1] bash failed: exit 1");
    progress.activity("1.1", { kind: "step-done", usage: usage() });
    clock = 12_400;
    progress.agentFinished({
      step: "1.1",
      outcome: "succeeded",
      durationMs: 12_400,
      usage: usage(),
    });
    expect(lines.at(-1)).toBe("  ✓ [1.1] session done in 12.4s · 1.2k tok");
    progress.gate("1.1", {
      phase: "plan",
      gates: [gate("format", "fmt"), gate("test", "test")],
    });
    expect(lines.at(-1)).toBe("  ⚙ [1.1] gates: format, test");
    progress.gate("1.1", {
      phase: "end",
      gate: gate("test", "test"),
      status: "fail",
      durationMs: 12_400,
    });
    expect(lines.at(-1)).toBe("  ✗ [1.1] test fail 12.4s");
    progress.gatesDone("1.1", report(false), 13_000);
    expect(lines.at(-1)).toBe("  ✗ [1.1] gates failed (test) in 13.0s");
    progress.task({ type: "merged", task: task("1.1"), commit: "abc" });
    expect(lines.at(-1)).toBe("  ✓ 1.1 merged (app)");
    progress.implementSummary({ merged: 1, failed: 0, cancelled: 0, pending: 0, total: 1 }, 13_000);
    expect(lines.at(-1)).toBe("implement: 1/1 merged in 13.0s");
    progress.stop();
  });

  test("verbose adds every tool call and gate start", () => {
    const { lines, out } = collect();
    const progress = new Progress({
      out,
      verbosity: "verbose",
      maxAttempts: 3,
      heartbeatMs: 0,
    });
    progress.agentStarted({ step: "1.1", agent: "implementer-app", model: "stub/model" });
    progress.activity("1.1", { kind: "tool", tool: "edit", input: { filePath: "src/x.ts" } });
    expect(lines.at(-1)).toBe("  · [1.1] edit: src/x.ts");
    progress.gate("1.1", { phase: "start", gate: gate("test", "bun test") });
    expect(lines.at(-1)).toBe("  ⚙ [1.1] test started (bun test)");
    progress.gate("1.1", {
      phase: "end",
      gate: gate("format", "fmt"),
      status: "pass",
      durationMs: 100,
    });
    expect(lines.at(-1)).toBe("  ✓ [1.1] format 100ms");
    progress.stop();
  });

  test("quiet keeps problems, merges and the summary only", () => {
    const { lines, out } = collect();
    const progress = new Progress({ out, verbosity: "quiet", maxAttempts: 3, heartbeatMs: 0 });
    progress.agentStarted({ step: "1.1", agent: "implementer-app", model: "stub/model" });
    progress.activity("1.1", { kind: "tool", tool: "bash", input: { command: "bun test" } });
    progress.gate("1.1", { phase: "plan", gates: [gate("test", "test")] });
    progress.task({ type: "waiting", tasks: [{ id: "1.2", reason: "waiting on 1.1" }] });
    expect(lines).toHaveLength(0);
    progress.task({ type: "retry", task: task("1.1"), attempt: 2, reason: "gates failed" });
    expect(lines).toHaveLength(0);
    progress.task({ type: "merged", task: task("1.1"), commit: "abc" });
    progress.implementSummary({ merged: 1, failed: 0, cancelled: 0, pending: 0, total: 1 }, 1000);
    expect(lines.slice(-2)).toEqual(["  ✓ 1.1 merged (app)", "implement: 1/1 merged in 1.0s"]);
    progress.stop();
  });

  test("the heartbeat line lists every running session with elapsed time and tokens", () => {
    const { lines, out } = collect();
    let clock = 1000;
    const progress = new Progress({ out, maxAttempts: 3, heartbeatMs: 0, now: () => clock });
    progress.agentStarted({ step: "1.1", agent: "implementer-app", model: "stub/model" });
    progress.agentStarted({ step: "1.2", agent: "implementer-app", model: "stub/model" });
    progress.activity("1.1", { kind: "tool", tool: "bash", input: { command: "bun test" } });
    progress.activity("1.1", { kind: "step-done", usage: usage() });
    progress.gate("1.2", { phase: "start", gate: gate("test", "bun test") });
    clock += 134_000;
    progress.tick();
    const line = lines.at(-1) ?? "";
    expect(line).toContain("running 3");
    expect(line).toContain("1.1 2m14s · bash: bun test · 1.2k tok");
    expect(line).toContain("1.2 2m14s");
    // A long gate is visible too: no agent session is running during it.
    expect(line).toContain("[1.2] test 2m14s");
    progress.stop();
  });

  test("waiting lines say why a task has not started", () => {
    const { lines, out } = collect();
    const progress = new Progress({ out, maxAttempts: 3, heartbeatMs: 0 });
    progress.task({
      type: "waiting",
      tasks: [
        { id: "1.2", reason: "waiting on 1.1" },
        { id: "1.3", reason: "touches overlap with 1.2" },
      ],
    });
    expect(lines.at(-1)).toBe("  … waiting: 1.2 (waiting on 1.1), 1.3 (touches overlap with 1.2)");
    progress.stop();
  });

  test("gate events from a failing plan keep their own icon", () => {
    const { lines, out } = collect();
    const progress = new Progress({ out, verbosity: "verbose", heartbeatMs: 0 });
    const event: GateEvent = {
      phase: "end",
      gate: gate("format", "fmt"),
      status: "not-check-only",
      durationMs: 30,
    };
    progress.gate("1.1", event);
    expect(lines.at(-1)).toBe("  ✗ [1.1] format not-check-only 30ms");
    progress.stop();
  });
});
