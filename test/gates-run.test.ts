import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ExitCode } from "../src/cli/exit-codes.ts";
import { FactoryConfig, type FactoryConfigInput } from "../src/config/schema.ts";
import { installDeps } from "../src/gates/install.ts";
import { runGates } from "../src/gates/run.ts";
import {
  createSingleRepoFixture,
  createSubmoduleFixture,
  type Fixture,
  fixtureGit,
} from "./fixtures/workspaces.ts";
import { cli, gitOut } from "./helpers.ts";

const M = "a/b";
function singleConfig(overrides: Record<string, string>): FactoryConfig {
  const input: FactoryConfigInput = {
    schemaVersion: 2,
    layout: "single",
    repos: [{ name: "app", path: ".", languages: ["typescript"] }],
    models: { orchestrator: M, architect: M, reviewer: M, implementer: M, tester: M, explorer: M },
    gates: { overrides: { app: overrides } },
  };
  return FactoryConfig.parse(input);
}

const hasGo = Bun.which("go") !== null;

describe("runGates (single repo, override commands)", () => {
  let fx: Fixture;
  let base: string;
  beforeEach(async () => {
    fx = await createSingleRepoFixture();
    base = await gitOut(fx.root, "rev-parse", "HEAD");
    // The agent's uncommitted work.
    writeFileSync(
      join(fx.root, "src/sum.ts"),
      "export const sum = (a: number, b: number) => a + b;\n",
    );
  });
  afterEach(() => fx.cleanup());

  const run = (overrides: Record<string, string>) =>
    runGates({
      root: fx.root,
      config: singleConfig(overrides),
      repo:
        singleConfig(overrides).repos[0] ??
        (() => {
          throw new Error("no repo");
        })(),
      worktree: fx.root,
      mode: "task",
      base,
    });

  test("passes, fails with compacted output, and skips tests after a failure", async () => {
    const ok = await run({
      format: "true",
      lint: "true",
      types: "true",
      testAffected: "echo testing {files}",
    });
    expect(ok.passed).toBe(true);
    expect(ok.changed).toEqual(["src/sum.ts"]);
    expect(ok.results.map((r) => `${r.type}:${r.status}`)).toEqual([
      "format:pass",
      "lint:pass",
      "types:pass",
      "testAffected:pass",
    ]);

    const bad = await run({
      format: "true",
      lint: "printf 'src/sum.ts:1:7 error  prefer function declaration\\n' >&2; exit 1",
      types: "true",
      testAffected: "true",
    });
    expect(bad.passed).toBe(false);
    const lint = bad.results.find((r) => r.type === "lint");
    expect(lint?.status).toBe("fail");
    expect(lint?.output).toBe("src/sum.ts:1:7 error  prefer function declaration");
    expect(bad.results.find((r) => r.type === "testAffected")?.status).toBe("skipped");
  });

  test("a gate that modifies files fails as not check-only and is undone", async () => {
    const agentWork = readFileSync(join(fx.root, "src/sum.ts"), "utf8");
    const report = await run({
      format: "echo '// reformatted' >> src/sum.ts; echo junk > new.txt; echo x >> src/sum.test.ts",
      lint: "true",
      types: "true",
      testAffected: "true",
    });
    const format = report.results.find((r) => r.type === "format");
    expect(format?.status).toBe("not-check-only");
    expect(format?.modified).toEqual(["new.txt", "src/sum.test.ts", "src/sum.ts"]);
    expect(format?.output).toContain("gate is not check-only");
    // The agent's work is back exactly; the clean file and the new file are restored too.
    expect(readFileSync(join(fx.root, "src/sum.ts"), "utf8")).toBe(agentWork);
    expect(existsSync(join(fx.root, "new.txt"))).toBe(false);
    expect(await gitOut(fx.root, "status", "--porcelain")).toBe("M src/sum.ts");
  });

  test("a gate that commits is undone too", async () => {
    const head = await gitOut(fx.root, "rev-parse", "HEAD");
    const report = await run({
      format: "git commit -qam sneaky",
      lint: "true",
      types: "true",
      testAffected: "true",
    });
    expect(report.results.find((r) => r.type === "format")?.status).toBe("not-check-only");
    expect(await gitOut(fx.root, "rev-parse", "HEAD")).toBe(head);
    expect(await gitOut(fx.root, "status", "--porcelain")).toBe("M src/sum.ts");
  });

  test("timeouts fail the gate", async () => {
    const report = await runGates({
      root: fx.root,
      config: singleConfig({
        format: "sleep 5",
        lint: "skip",
        types: "skip",
        testAffected: "skip",
      }),
      repo:
        singleConfig({}).repos[0] ??
        (() => {
          throw new Error("no repo");
        })(),
      worktree: fx.root,
      mode: "task",
      base,
      timeoutMs: 200,
    });
    expect(report.results.map((r) => r.status)).toEqual([
      "timeout",
      "skipped",
      "skipped",
      "skipped",
    ]);
  });
});

describe("ai-factory gate (submodules)", () => {
  let fx: Fixture;
  beforeEach(async () => {
    fx = await createSubmoduleFixture();
    expect((await cli(fx.root, "init")).code).toBe(ExitCode.Ok);
  });
  afterEach(() => fx.cleanup());

  async function setOverrides(repo: string, overrides: Record<string, string>): Promise<void> {
    const file = join(fx.root, "factory.config.jsonc");
    const text = readFileSync(file, "utf8").replace(
      /"overrides": \{.*\}\n/,
      `"overrides": ${JSON.stringify({ [repo]: overrides })}\n`,
    );
    writeFileSync(file, text);
  }

  test("requires the change branch", async () => {
    const run = await cli(fx.root, "gate", "add-x", "--repo", "backend");
    expect(run.code).toBe(ExitCode.Precondition);
    expect(run.err).toContain("not change/add-x");
  });

  test("gates a task worktree against change/<id>, JSON output and exit codes", async () => {
    await setOverrides("backend", {
      format: "true",
      lint: "true",
      types: "true",
      testAffected: "test -f {files}",
    });
    const backend = join(fx.root, "repos/backend");
    await fixtureGit(backend, "switch", "-q", "-c", "change/add-x");
    const wt = join(fx.root, ".factory/worktrees/add-x/backend/1.1");
    await fixtureGit(
      backend,
      "worktree",
      "add",
      "-q",
      "-b",
      "change/add-x--1.1",
      wt,
      "change/add-x",
    );
    writeFileSync(join(wt, "x.go"), "package main\n");

    const run = await cli(fx.root, "gate", "add-x", "--task", "1.1", "--json");
    expect(run.code).toBe(ExitCode.Ok);
    const json = JSON.parse(run.out) as {
      passed: boolean;
      reports: { repo: string; mode: string; changed: string[] }[];
    };
    expect(json.passed).toBe(true);
    expect(json.reports[0]).toMatchObject({ repo: "backend", mode: "task", changed: ["x.go"] });

    await setOverrides("backend", {
      format: "true",
      lint: "exit 3",
      types: "true",
      testAffected: "true",
    });
    const failed = await cli(fx.root, "gate", "add-x", "--task", "1.1");
    expect(failed.code).toBe(ExitCode.GateFailed);
    expect(failed.out).toContain("✗ lint exit 3");
  });

  test.skipIf(!hasGo)(
    "real Go gates on the backend: full suite, then a formatting failure",
    async () => {
      await setOverrides("backend", { lint: "skip" });
      const backend = join(fx.root, "repos/backend");
      await fixtureGit(backend, "switch", "-q", "-c", "change/go");

      const full = await cli(fx.root, "gate", "go", "--repo", "backend", "--full");
      expect(full.out).toContain("✓ format");
      expect(full.out).toContain("✓ types go vet ./...");
      expect(full.out).toContain("✓ test go test -race ./...");
      expect(full.code).toBe(ExitCode.Ok);

      writeFileSync(join(backend, "bad.go"), "package main\nfunc   bad( ) {}\n");
      const task = await cli(fx.root, "gate", "go", "--repo", "backend", "--json");
      const report = (
        JSON.parse(task.out) as {
          reports: { results: { type: string; status: string; output: string }[] }[];
        }
      ).reports[0];
      expect(report?.results.find((r) => r.type === "format")).toMatchObject({ status: "fail" });
      expect(report?.results.find((r) => r.type === "format")?.output).toContain("bad.go");
      expect(task.code).toBe(ExitCode.GateFailed);
      // The shared Go caches live under .factory/cache.
      expect(existsSync(join(fx.root, ".factory/cache/go/build"))).toBe(true);
    },
    120_000,
  );

  test.skipIf(!hasGo)(
    "worktree installs run from the lockfile with shared caches",
    async () => {
      const backend = join(fx.root, "repos/backend");
      const repo = {
        name: "backend",
        path: "repos/backend",
        role: "code" as const,
        languages: ["go" as const],
      };
      expect(await installDeps(fx.root, backend, repo)).toEqual([
        { dir: ".", status: "skipped", detail: "no lockfile for Go (go.sum)", durationMs: 0 },
      ]);
      writeFileSync(join(backend, "go.sum"), "");
      const [step] = await installDeps(fx.root, backend, repo);
      expect(step).toMatchObject({ dir: ".", command: "go mod download", status: "ok" });
      expect(existsSync(join(fx.root, ".factory/cache/go/mod"))).toBe(true);
    },
    120_000,
  );
});
