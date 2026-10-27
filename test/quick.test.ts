import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ExitCode } from "../src/cli/exit-codes.ts";
import { ScriptedRuntime } from "./fixtures/scripted-runtime.ts";
import { createSingleRepoFixture, type Fixture, fixtureGit } from "./fixtures/workspaces.ts";
import { cli, cliWith, gitOut } from "./helpers.ts";

let fx: Fixture;
beforeEach(async () => {
  fx = await createSingleRepoFixture();
  expect((await cli(fx.root, "init")).code).toBe(ExitCode.Ok);
  writeFileSync(
    join(fx.root, "factory.config.jsonc"),
    JSON.stringify({
      schemaVersion: 3,
      layout: "single",
      repos: [{ name: "app", path: ".", languages: ["typescript"] }],
      models: {
        orchestrator: "test/model",
        architect: "test/model",
        reviewer: "test/model",
        implementer: "test/model",
        tester: "test/model",
        explorer: "test/model",
      },
      gates: {
        overrides: {
          app: { format: "true", lint: "true", types: "true", test: "true", testAffected: "true" },
        },
      },
    }),
  );
  await fixtureGit(fx.root, "add", "-A");
  await fixtureGit(fx.root, "commit", "-q", "-m", "chore: quick test config");
});
afterEach(() => fx.cleanup());

describe("quick task", () => {
  test("branch, implement, gate, review, one commit", async () => {
    let implementer = 0;
    const runtime = new ScriptedRuntime((call) => {
      if (call.agent.startsWith("implementer")) {
        implementer++;
        return {
          edits: { "src/quick.ts": `export const quick = ${implementer};\n` },
          handoff: { task: "quick" },
        };
      }
      if (call.agent === "reviewer") {
        return { handoff: { task: "quick-review", findings: [] } };
      }
      return { handoff: { task: call.agent } };
    });
    const res = await cliWith(runtime, fx.root, "quick", "add quick file", "--repo", "app");
    expect(res.code).toBe(ExitCode.Ok);
    expect(res.out).toContain("task/add-quick-file");
    expect(res.out).toContain("  ▶ [quick] add quick file · implementer-app");
    expect(res.out).toContain("  ⚙ [quick] gates:");
    expect(res.out).toContain("  ✓ [quick] gates passed in");
    expect(await gitOut(fx.root, "branch", "--show-current")).toBe("task/add-quick-file");
    expect(readFileSync(join(fx.root, "src/quick.ts"), "utf8")).toContain("quick = 1");
    expect(await gitOut(fx.root, "log", "-1", "--format=%s")).toBe("feat: add quick file");
    expect(await gitOut(fx.root, "status", "--porcelain")).toBe("");
  });

  test("review findings are fixed before the commit", async () => {
    let implementer = 0;
    let reviews = 0;
    const runtime = new ScriptedRuntime((call) => {
      if (call.agent.startsWith("implementer")) {
        implementer++;
        return {
          edits: { "src/quick.ts": `export const quick = ${implementer};\n` },
          handoff: { task: "quick" },
        };
      }
      reviews++;
      return {
        handoff: {
          task: "quick-review",
          findings:
            reviews === 1
              ? [
                  {
                    severity: "must",
                    file: "src/quick.ts",
                    line: 1,
                    what: "wrong value",
                    problem: "quick is 1",
                    fix: "make it 2",
                    impact: "wrong",
                  },
                ]
              : [],
        },
      };
    });
    const res = await cliWith(runtime, fx.root, "quick", "fix quick value", "--repo", "app");
    expect(res.code).toBe(ExitCode.Ok);
    expect(reviews).toBe(2);
    expect(readFileSync(join(fx.root, "src/quick.ts"), "utf8")).toContain("quick = 2");
  });
});
