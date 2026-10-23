import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ExitCode } from "../src/cli/exit-codes.ts";
import { FactoryConfig } from "../src/config/schema.ts";
import { resolveGates } from "../src/gates/resolve.ts";
import { worktreeFiles } from "../src/gates/targets.ts";
import { dependentFiles, graphFile, graphStatus, updateGraph } from "../src/graph/graph.ts";
import { GraphUpdater } from "../src/graph/updater.ts";
import { loadRun } from "../src/state/run.ts";
import { factoryScript, type ScriptedTask } from "./fixtures/factory-script.ts";
import { ScriptedRuntime } from "./fixtures/scripted-runtime.ts";
import {
  createSingleRepoFixture,
  createSubmoduleFixture,
  type Fixture,
  fixtureGit,
  writeFiles,
} from "./fixtures/workspaces.ts";
import { cli, cliWith } from "./helpers.ts";

describe("GraphUpdater", () => {
  test("serialises and coalesces updates; waiters see a graph that covers their merge", async () => {
    let running = 0;
    let maxRunning = 0;
    let runs = 0;
    const covered: number[] = [];
    const updater = new GraphUpdater(
      async () => {
        runs++;
        running++;
        maxRunning = Math.max(maxRunning, running);
        await Bun.sleep(30);
        running--;
      },
      0,
      (seq) => {
        covered.push(seq);
      },
    );
    updater.request(1);
    updater.request(2);
    updater.request(3);
    await updater.waitFor(3);
    expect(updater.covered).toBe(3);
    expect(runs).toBe(2); // 1, then 2 and 3 coalesced
    expect(maxRunning).toBe(1);
    expect(covered).toEqual([1, 3]);
    await updater.waitFor(2); // already covered: immediate
    await updater.idle();
  });

  test("a failed update still counts as covered (agents fall back to grep, no deadlock)", async () => {
    const updater = new GraphUpdater(async () => {
      throw new Error("graphify crashed");
    });
    await updater.waitFor(1).catch(() => undefined);
    expect(updater.covered).toBe(1);
  });
});

describe("workspace graph (stub graphify)", () => {
  let fx: Fixture;
  beforeEach(async () => {
    fx = await createSingleRepoFixture();
  });
  afterEach(() => fx.cleanup());

  test("init builds the graph; `graph` updates it; status and dependents read it", async () => {
    const init = await cli(fx.root, "init");
    expect(init.out).toContain("graph: built");
    expect(graphStatus(fx.root)).toMatchObject({ state: "ok" });

    writeFiles(fx.root, {
      "src/report.ts": 'import { sum } from "./sum";\nexport const total = sum(1, 2);\n',
    });
    const update = await cli(fx.root, "graph");
    expect(update.code).toBe(ExitCode.Ok);
    expect(update.out).toMatch(/^graph updated: \d+ nodes/);
    expect([...dependentFiles(fx.root, ["src/sum.ts"])].sort()).toEqual([
      "src/report.ts",
      "src/sum.test.ts",
    ]);
    expect((await cli(fx.root, "graph", "--full")).out).toMatch(/^graph built/);
  });

  test("graph dependents widen bun's affected tests", () => {
    writeFiles(fx.root, { "bun.lock": "", "src/report.ts": "x", "src/report.test.ts": "y" });
    const config = FactoryConfig.parse({
      schemaVersion: 2,
      layout: "single",
      repos: [{ name: "app", path: ".", languages: ["typescript"] }],
      models: {
        orchestrator: "a/b",
        architect: "a/b",
        reviewer: "a/b",
        implementer: "a/b",
        tester: "a/b",
        explorer: "a/b",
      },
    });
    const repo = config.repos[0];
    if (!repo) throw new Error("no repo");
    const plan = (related: string[]) =>
      resolveGates({
        config,
        repo,
        worktree: fx.root,
        mode: "task",
        base: "HEAD",
        changed: ["src/sum.ts"],
        files: worktreeFiles(fx.root),
        related,
      });
    expect(plan([]).gates.find((g) => g.type === "testAffected")?.command).toBe(
      "bun test src/sum.test.ts",
    );
    expect(
      plan(["src/report.ts", "src/report.test.ts"]).gates.find((g) => g.type === "testAffected")
        ?.command,
    ).toBe("bun test src/report.test.ts src/sum.test.ts");
  });

  test("the pipeline updates the graph after merges and dependents start on a covering graph", async () => {
    expect((await cli(fx.root, "init")).code).toBe(ExitCode.Ok);
    const file = join(fx.root, "factory.config.jsonc");
    const pass = {
      format: "true",
      lint: "true",
      types: "true",
      test: "true",
      testAffected: "true",
    };
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace(
        '"overrides": {}',
        `"overrides": ${JSON.stringify({ app: pass })}`,
      ),
    );
    await fixtureGit(fx.root, "commit", "-q", "-am", "chore: gates");
    const log = join(fx.base, "graphify.log");
    process.env.GRAPHIFY_STUB_LOG = log;
    process.env.GRAPHIFY_STUB_DELAY = "150";
    try {
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
        {
          id: "1.2",
          title: "Use the multiply helper",
          repo: "app",
          deps: ["1.1"],
          touches: ["src/use.ts"],
          file: "src/use.ts",
          content: 'import { mul } from "./mul";\n',
        },
      ];
      const seen: string[] = [];
      const runtime = new ScriptedRuntime(
        factoryScript({
          changeId: "graph-x",
          summary: "Math",
          repos: ["app"],
          tasks,
          onCall: (call) => {
            if (call.agent === "implementer-app" && call.prompt.startsWith("Task 1.2:")) {
              const run = loadRun(fx.root, "graph-x");
              const dep = run?.tasks.find((t) => t.id === "1.1");
              seen.push(`graphSeq=${run?.graphSeq} dep=${dep?.mergeSeq}`);
            }
          },
        }),
      );
      await cliWith(runtime, fx.root, "run", "Math");
      expect((await cliWith(runtime, fx.root, "approve", "graph-x")).code).toBe(ExitCode.Ok);
      expect(seen).toEqual(["graphSeq=1 dep=1"]);
      const run = loadRun(fx.root, "graph-x");
      expect(run?.graphSeq).toBe(run?.mergeSeq);
      const starts = readFileSync(log, "utf8")
        .split("\n")
        .filter((l) => l.startsWith("start")).length;
      expect(starts).toBeGreaterThanOrEqual(2);
      expect(starts).toBeLessThanOrEqual(run?.mergeSeq ?? 0);
    } finally {
      delete process.env.GRAPHIFY_STUB_LOG;
      delete process.env.GRAPHIFY_STUB_DELAY;
    }
  });
});

/** Opt-in: the real graphify over the submodule fixture (AI_FACTORY_E2E=1). */
const REAL_GRAPHIFY = Bun.which("graphify") ?? join(homedir(), ".local/bin/graphify");
describe.skipIf(process.env.AI_FACTORY_E2E !== "1" || !existsSync(REAL_GRAPHIFY))(
  "real graphify",
  () => {
    test("one graph over the AI repo and its submodules; incremental update", async () => {
      const fx = await createSubmoduleFixture();
      const saved = process.env.AI_FACTORY_GRAPHIFY_BIN;
      process.env.AI_FACTORY_GRAPHIFY_BIN = REAL_GRAPHIFY;
      try {
        const full = await updateGraph(fx.root, { full: true });
        expect(full.ok).toBe(true);
        const doc = JSON.parse(readFileSync(graphFile(fx.root), "utf8")) as {
          nodes: { source_file?: string }[];
        };
        const files = new Set(doc.nodes.map((n) => n.source_file ?? ""));
        expect([...files].some((f) => f.startsWith("repos/backend/"))).toBe(true);
        expect([...files].some((f) => f.startsWith("repos/frontend/"))).toBe(true);
        writeFileSync(
          join(fx.root, "repos/backend/extra.go"),
          "package main\n\nfunc extra() int { return 1 }\n",
        );
        const inc = await updateGraph(fx.root);
        expect(inc.ok).toBe(true);
        expect(inc.meta?.full).toBe(false);
        expect(graphStatus(fx.root)).toMatchObject({ state: "ok" });
        rmSync(join(fx.root, "graphify-out"), { recursive: true, force: true });
        expect(readdirSync(fx.root)).not.toContain("graphify-out");
      } finally {
        process.env.AI_FACTORY_GRAPHIFY_BIN = saved;
        fx.cleanup();
      }
    }, 300_000);
  },
);
