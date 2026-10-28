import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExitCode } from "../src/cli/exit-codes.ts";
import type { Usage } from "../src/runtime/types.ts";
import { summarizeWorkspaceUsage, totalTokens, workspaceUsageReport } from "../src/usage/usage.ts";
import { createSingleRepoFixture, type Fixture, writeFiles } from "./fixtures/workspaces.ts";
import { cli } from "./helpers.ts";

const usage = (input: number, cost: number): Usage => ({
  input,
  output: 10,
  reasoning: 0,
  cacheRead: 5,
  cacheWrite: 0,
  cost,
});

const entry = (
  at: string,
  agent: string,
  model: string,
  step: string,
  u: Usage,
  kind: "attempt" | "step" = "step",
  attempt?: number,
) => ({
  at,
  sessionId: `${at}-${agent}`,
  agent,
  model,
  step,
  kind,
  ...(attempt === undefined ? {} : { attempt }),
  usage: u,
});

const ledgers = {
  ".factory/usage/add-x.json": JSON.stringify({
    version: 1,
    changeId: "add-x",
    entries: [
      entry("2026-10-01T10:00:00.000Z", "architect", "a/strong", "design", usage(1000, 0.5)),
      entry(
        "2026-10-02T10:00:00.000Z",
        "implementer-app",
        "a/fast",
        "1.1",
        usage(300, 0.1),
        "attempt",
        1,
      ),
      entry(
        "2026-10-03T10:00:00.000Z",
        "implementer-app",
        "a/fast",
        "1.1",
        usage(200, 0.1),
        "attempt",
        2,
      ),
    ],
  }),
  ".factory/usage/quick-fix.json": JSON.stringify({
    version: 1,
    changeId: "quick-fix",
    entries: [
      entry(
        "2026-10-04T10:00:00.000Z",
        "implementer-app",
        "a/fast",
        "quick",
        usage(400, 0.2),
        "attempt",
        1,
      ),
    ],
  }),
  ".factory/logs/add-x/2026-10-01.jsonl": '{"kind":"waste"}\n{"kind":"tool"}\n{"kind":"waste"}\n',
};

describe("workspace usage aggregation", () => {
  let fx: Fixture;
  beforeEach(async () => {
    fx = await createSingleRepoFixture();
    writeFiles(fx.root, ledgers);
  });
  afterEach(() => fx.cleanup());

  test("aggregates every ledger by change, agent, model and day", () => {
    const summary = summarizeWorkspaceUsage(fx.root);
    expect(summary.sessions).toBe(4);
    expect(summary.entries).toBe(4);
    expect(summary.changes).toBe(2);
    expect(totalTokens(summary.total)).toBe(1960);
    expect(summary.total.cost).toBeCloseTo(0.9);
    expect(summary.byAgent.architect?.input).toBe(1000);
    expect(summary.byModel["a/fast"]?.input).toBe(900);
    expect(summary.byDay["2026-10-04"]?.input).toBe(400);
    expect(summary.sessionsByChange["add-x"]).toBe(3);
    expect(summary.retryOverhead.input).toBe(200);
    expect(summary.wastedReads).toBe(2);
    expect(summary.first).toBe("2026-10-01T10:00:00.000Z");
    expect(summary.last).toBe("2026-10-04T10:00:00.000Z");
    expect(summary.corrupt).toEqual([]);
  });

  test("filters by day, change, agent and model", () => {
    expect(summarizeWorkspaceUsage(fx.root, { since: "2026-10-03" }).sessions).toBe(2);
    expect(summarizeWorkspaceUsage(fx.root, { until: "2026-10-02" }).sessions).toBe(2);
    expect(summarizeWorkspaceUsage(fx.root, { changes: ["quick-fix"] }).sessions).toBe(1);
    expect(
      summarizeWorkspaceUsage(fx.root, { agents: ["architect"], models: ["a/strong"] }).sessions,
    ).toBe(1);
    expect(summarizeWorkspaceUsage(fx.root, { since: "2026-10-09" }).sessions).toBe(0);
  });

  test("a corrupt ledger is reported and the rest still aggregates", () => {
    writeFiles(fx.root, { ".factory/usage/bad.json": "{not json" });
    const summary = summarizeWorkspaceUsage(fx.root);
    expect(summary.sessions).toBe(4);
    expect(summary.corrupt).toEqual([join(".factory", "usage", "bad.json")]);
  });

  test("report tables follow the selected dimensions", () => {
    const summary = summarizeWorkspaceUsage(fx.root);
    const report = workspaceUsageReport(summary, ["change", "day"]).join("\n");
    expect(report).toContain("| Change | Tokens | Share | Cost | Sessions |");
    expect(report).toContain("By change");
    expect(report).toContain("By day");
    expect(report).not.toContain("By agent");
    expect(report).toContain("| add-x | 1.5k |");
  });
});

describe("usage command", () => {
  let fx: Fixture;
  beforeEach(async () => {
    fx = await createSingleRepoFixture();
    writeFiles(fx.root, ledgers);
  });
  afterEach(() => fx.cleanup());

  test("prints the workspace report", async () => {
    const run = await cli(fx.root, "usage");
    expect(run.code).toBe(ExitCode.Ok);
    expect(run.out).toContain("AI usage across");
    expect(run.out).toContain("By change");
    expect(run.out).toContain("By agent");
    expect(run.out).toContain("By model");
    expect(run.out).toContain("add-x");
    expect(run.out).toContain("quick-fix");
    expect(run.out).toContain("Retry overhead");
  });

  test("selects tables, filters and prints JSON", async () => {
    const day = await cli(fx.root, "usage", "--by", "day");
    expect(day.code).toBe(ExitCode.Ok);
    expect(day.out).toContain("By day");
    expect(day.out).not.toContain("By change");

    const filtered = await cli(fx.root, "usage", "--change", "quick-fix");
    expect(filtered.out).toContain("1 change");
    expect(filtered.out).toContain("quick-fix");
    expect(filtered.out).not.toContain("add-x");

    const since = await cli(fx.root, "usage", "--since", "2026-10-03");
    expect(since.out).toContain("2 sessions");

    const json = await cli(fx.root, "usage", "--json");
    const report = JSON.parse(json.out) as {
      version: number;
      totalTokens: number;
      sessions: number;
      byChange: Record<string, unknown>;
      byDay: Record<string, unknown>;
    };
    expect(report.version).toBe(1);
    expect(report.totalTokens).toBe(1960);
    expect(report.sessions).toBe(4);
    expect(Object.keys(report.byChange).sort()).toEqual(["add-x", "quick-fix"]);
    expect(Object.keys(report.byDay)).toContain("2026-10-01");
  });

  test("validates dates and dimensions, and handles an empty or missing workspace", async () => {
    expect((await cli(fx.root, "usage", "--since", "yesterday")).code).toBe(ExitCode.Usage);
    expect((await cli(fx.root, "usage", "--until", "2026-02-30")).code).toBe(ExitCode.Usage);
    expect((await cli(fx.root, "usage", "--since", "2026-13-01")).code).toBe(ExitCode.Usage);
    expect((await cli(fx.root, "usage", "--by", "nope")).code).toBe(ExitCode.Usage);
    const local = mkdtempSync(join(tmpdir(), "ai-factory-usage-empty-"));
    try {
      expect((await cli(local, "usage")).code).toBe(ExitCode.Precondition);
    } finally {
      rmSync(local, { recursive: true, force: true });
    }

    const empty = await createSingleRepoFixture();
    try {
      const run = await cli(empty.root, "usage");
      expect(run.code).toBe(ExitCode.Ok);
      expect(run.out).toBe("no usage recorded yet");
    } finally {
      empty.cleanup();
    }
  });

  test("reports unreadable ledgers on stderr", async () => {
    writeFiles(fx.root, { ".factory/usage/bad.json": "{not json" });
    const run = await cli(fx.root, "usage");
    expect(run.code).toBe(ExitCode.Ok);
    expect(run.err).toContain("skipped unreadable ledgers");
  });
});

describe("status usage summary", () => {
  let fx: Fixture;
  beforeEach(async () => {
    fx = await createSingleRepoFixture();
    writeFiles(fx.root, ledgers);
  });
  afterEach(() => fx.cleanup());

  test("shows the workspace total and includes it in JSON", async () => {
    const status = await cli(fx.root, "status");
    expect(status.code).toBe(ExitCode.Ok);
    expect(status.out).toContain("usage:");
    expect(status.out).toContain("across 2 changes, 4 sessions");
    const json = await cli(fx.root, "status", "--json");
    const report = JSON.parse(json.out) as { workspaceUsage: { sessions: number } };
    expect(report.workspaceUsage.sessions).toBe(4);
  });
});
