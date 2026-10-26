import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FactoryConfig, type FactoryConfigInput } from "../src/config/schema.ts";
import { resolveGates } from "../src/gates/resolve.ts";
import { runGates } from "../src/gates/run.ts";
import { createSingleRepoFixture, type Fixture } from "./fixtures/workspaces.ts";
import { gitOut } from "./helpers.ts";

const M = "a/b";
const base = (extra: FactoryConfigInput["gates"] = {}): FactoryConfigInput => ({
  schemaVersion: 3,
  layout: "single",
  repos: [{ name: "app", path: ".", languages: ["typescript"] }],
  models: { orchestrator: M, architect: M, reviewer: M, implementer: M, tester: M, explorer: M },
  gates: {
    overrides: {
      app: { format: "skip", lint: "skip", types: "skip", test: "skip", testAffected: "skip" },
    },
    ...extra,
  },
});

describe("extra gates", () => {
  test("resolve only when their changed-path condition matches", () => {
    const cfg = FactoryConfig.parse(
      base({
        extra: [
          {
            name: "ios-compile",
            type: "types",
            phases: ["task"],
            when: { changed: ["src-tauri/**"] },
            command: "cargo check --target aarch64-apple-ios",
            env: { CARGO_TARGET_DIR: "target-ios" },
            setup: "test -d src-tauri",
            outputs: ["src-tauri/gen/ios/**"],
          },
        ],
      }),
    );
    const repo = cfg.repos[0];
    if (repo === undefined) throw new Error("no repo");
    const files = ["package.json", "tsconfig.json", "src-tauri/tauri.conf.json"];
    const unrelated = resolveGates({
      config: cfg,
      repo,
      worktree: "/tmp",
      mode: "task",
      base: "abc",
      changed: ["src/app.ts"],
      files,
    });
    expect(unrelated.gates.some((g) => g.name === "ios-compile")).toBe(false);
    expect(unrelated.skipped.some((g) => g.reason.includes("ios-compile"))).toBe(true);

    const matching = resolveGates({
      config: cfg,
      repo,
      worktree: "/tmp",
      mode: "task",
      base: "abc",
      changed: ["src-tauri/tauri.conf.json"],
      files,
    });
    const gate = matching.gates.find((g) => g.name === "ios-compile");
    expect(gate).toMatchObject({
      source: "extra",
      cwd: ".",
      env: { CARGO_TARGET_DIR: "target-ios" },
      setup: "test -d src-tauri",
      outputs: ["src-tauri/gen/ios/**"],
    });
  });

  test("extra gates run in full mode without a changed-path match", () => {
    const cfg = FactoryConfig.parse(
      base({ extra: [{ name: "docs", command: "true", phases: ["full"] }] }),
    );
    const repo = cfg.repos[0];
    if (repo === undefined) throw new Error("no repo");
    const plan = resolveGates({
      config: cfg,
      repo,
      worktree: "/tmp",
      mode: "full",
      base: "abc",
      changed: [],
      files: ["package.json"],
    });
    expect(plan.gates.some((g) => g.name === "docs")).toBe(true);
  });
});

describe("generated gates", () => {
  let fx: Fixture;
  beforeEach(async () => {
    fx = await createSingleRepoFixture();
  });
  afterEach(() => fx.cleanup());

  const cfg = (extra: FactoryConfigInput["gates"] = {}): FactoryConfig =>
    FactoryConfig.parse(base(extra));

  test("drift fails, the worktree is restored, and the agent's work survives", async () => {
    const agentWork = "export const sum = (a: number, b: number) => a + b;\n";
    writeFileSync(join(fx.root, "src/sum.ts"), agentWork);
    const baseRev = await gitOut(fx.root, "rev-parse", "HEAD");
    const config = cfg({
      extra: [
        {
          name: "bindings",
          type: "test",
          phases: ["task"],
          command: `node -e "require('fs').writeFileSync('src/sum.ts', 'generated')"`,
          outputs: ["src/sum.ts"],
        },
      ],
    });
    const repo = config.repos[0];
    if (repo === undefined) throw new Error("no repo");
    const report = await runGates({
      root: fx.root,
      config,
      repo,
      worktree: fx.root,
      mode: "task",
      base: baseRev,
    });
    const gate = report.results.find((r) => r.name === "bindings");
    expect(gate?.status).toBe("fail");
    expect(gate?.output).toContain("generated artifacts are stale");
    expect(readFileSync(join(fx.root, "src/sum.ts"), "utf8")).toBe(agentWork);
  });

  test("a checkOnly:false gate may write; a non-check-only base gate still fails", async () => {
    const config = cfg({
      extra: [
        {
          name: "write-allowed",
          type: "test",
          phases: ["task"],
          command: "printf x > generated.txt",
          checkOnly: false,
        },
      ],
    });
    const repo = config.repos[0];
    if (repo === undefined) throw new Error("no repo");
    const baseRev = await gitOut(fx.root, "rev-parse", "HEAD");
    const report = await runGates({
      root: fx.root,
      config,
      repo,
      worktree: fx.root,
      mode: "task",
      base: baseRev,
    });
    expect(report.results.find((r) => r.name === "write-allowed")?.status).toBe("pass");
    expect(existsSync(join(fx.root, "generated.txt"))).toBe(true);
  });
});
