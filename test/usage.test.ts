import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExitCode } from "../src/cli/exit-codes.ts";
import type { Usage } from "../src/runtime/types.ts";
import {
  formatTokens,
  loadUsage,
  recordUsage,
  summarizeUsage,
  totalTokens,
  usageReport,
} from "../src/usage/usage.ts";
import { factoryScript, type ScriptedTask } from "./fixtures/factory-script.ts";
import { ScriptedRuntime, USAGE_PER_TURN } from "./fixtures/scripted-runtime.ts";
import {
  createSingleRepoFixture,
  type Fixture,
  fixtureGit,
  writeFiles,
} from "./fixtures/workspaces.ts";
import { cli, cliWith } from "./helpers.ts";

const u = (input: number, cost = 0): Usage => ({
  input,
  output: 10,
  reasoning: 0,
  cacheRead: 5,
  cacheWrite: 0,
  cost,
});

describe("usage ledger", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ai-factory-usage-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("aggregates per agent, step and model; retries and conflicts are overhead; waste comes from logs", async () => {
    const base = { at: "t", sessionId: "s", model: "a/fast" };
    await recordUsage(root, "x", {
      ...base,
      agent: "architect",
      model: "a/strong",
      step: "design",
      kind: "step",
      usage: u(1000, 0.5),
    });
    await recordUsage(root, "x", {
      ...base,
      agent: "implementer-api",
      step: "1.1",
      kind: "attempt",
      attempt: 1,
      usage: u(300),
    });
    await recordUsage(root, "x", {
      ...base,
      agent: "implementer-api",
      step: "1.1",
      kind: "attempt",
      attempt: 2,
      usage: u(200),
    });
    await recordUsage(root, "x", {
      ...base,
      agent: "implementer-api",
      step: "1.1",
      kind: "conflict",
      usage: u(100),
    });
    writeFiles(root, {
      ".factory/logs/x/2026-10-23.jsonl": '{"kind":"waste"}\n{"kind":"tool"}\n{"kind":"waste"}\n',
    });

    expect(loadUsage(root, "x").entries).toHaveLength(4);
    const s = summarizeUsage(root, "x");
    expect(s.sessions).toBe(4);
    expect(s.total.input).toBe(1600);
    expect(s.total.cost).toBe(0.5);
    expect(totalTokens(s.byAgent["implementer-api"] ?? u(0))).toBe(600 + 45);
    expect(s.byModel["a/strong"]?.input).toBe(1000);
    expect(s.retryOverhead.input).toBe(300);
    expect(s.top.map((t) => t.step)).toEqual(["design", "1.1"]);
    expect(s.wastedReads).toBe(2);
    // The report lists every task and step, not only the top consumers (audit G4).
    const report = usageReport(s).join("\n");
    expect(report).toContain("| Task or step | Tokens | Share | Cost |");
    expect(report).toMatch(/\| 1\.1 \| [^|]+ \| \d+% \|/);
    expect(report).toMatch(/\| design \| [^|]+ \| \d+% \|/);
  });

  test("formats token counts", () => {
    expect([formatTokens(950), formatTokens(12_345), formatTokens(3_456_789)]).toEqual([
      "950",
      "12.3k",
      "3.46M",
    ]);
  });
});

describe("usage in the pipeline, status and report", () => {
  let fx: Fixture;
  beforeEach(async () => {
    fx = await createSingleRepoFixture();
    expect((await cli(fx.root, "init")).code).toBe(ExitCode.Ok);
    const file = join(fx.root, "factory.config.jsonc");
    const gates = {
      format: "true",
      lint: "! grep -rq BROKEN src",
      types: "true",
      test: "true",
      testAffected: "true",
    };
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace(
        '"overrides": {}',
        `"overrides": ${JSON.stringify({ app: gates })}`,
      ),
    );
    await fixtureGit(fx.root, "commit", "-q", "-am", "chore: gates");
  });
  afterEach(() => fx.cleanup());

  test("every session is recorded; retries show up as overhead", async () => {
    const tasks: ScriptedTask[] = [
      {
        id: "1.1",
        title: "Add a multiply helper",
        repo: "app",
        deps: [],
        touches: ["src/mul.ts"],
        file: "src/mul.ts",
        content: "export const mul = 1;\n",
      },
    ];
    let first = true;
    const runtime = new ScriptedRuntime(
      factoryScript({
        changeId: "use-x",
        summary: "Math",
        repos: ["app"],
        tasks,
        implement: (task) => {
          if (!first) return undefined;
          first = false;
          return { edits: { [task.file]: "// BROKEN\n" }, handoff: { task: task.id } };
        },
      }),
    );
    await cliWith(runtime, fx.root, "run", "Math");
    expect((await cliWith(runtime, fx.root, "approve", "use-x")).code).toBe(ExitCode.Ok);

    const ledger = loadUsage(fx.root, "use-x");
    expect(ledger.entries).toHaveLength(runtime.calls.length);
    expect(ledger.entries.map((e) => e.step)).toEqual(
      expect.arrayContaining([
        "intake",
        "explore:app",
        "design",
        "context-packs",
        "1.1",
        "review:app",
        "test-app",
      ]),
    );
    const perTurn = totalTokens({ ...USAGE_PER_TURN });
    const s = summarizeUsage(fx.root, "use-x");
    expect(totalTokens(s.total)).toBe(perTurn * runtime.calls.length);
    expect(totalTokens(s.retryOverhead)).toBe(perTurn);

    const report = readFileSync(join(fx.root, ".factory/reports/use-x.md"), "utf8");
    expect(report).toContain("## Usage");
    expect(report).toContain(`Retry overhead: ${formatTokens(perTurn)} tokens`);
    expect(report).toContain("| implementer-app |");

    const status = await cli(fx.root, "status", "use-x");
    expect(status.out).toContain(`usage: ${formatTokens(totalTokens(s.total))} tokens`);
    expect(status.out).toContain(`retry overhead: ${formatTokens(perTurn)}`);
    expect(status.out).toMatch(/1\.1\s+app Add a multiply helper — merged \w+ · [\d.]+k tok/);
    const json = JSON.parse((await cli(fx.root, "status", "use-x", "--json")).out) as {
      runs: { usage: { sessions: number } }[];
    };
    expect(json.runs[0]?.usage.sessions).toBe(runtime.calls.length);
  });
});
