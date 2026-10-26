import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as toYaml } from "yaml";
import { ExitCode } from "../src/cli/exit-codes.ts";
import { loadConfig } from "../src/config/load.ts";
import type { ContractConfig } from "../src/config/schema.ts";
import { checkContract } from "../src/contracts/gate.ts";
import { loadRun } from "../src/state/run.ts";
import { factoryScript, type ScriptedTask } from "./fixtures/factory-script.ts";
import { ScriptedRuntime } from "./fixtures/scripted-runtime.ts";
import {
  BACKEND_FILES,
  createSubmoduleFixture,
  type Fixture,
  fixtureGit,
} from "./fixtures/workspaces.ts";
import { cli, cliWith, gitOut } from "./helpers.ts";

const OPENAPI = BACKEND_FILES["api/openapi.yaml"] ?? "";

describe("contract gate (submodule fixture)", () => {
  let fx: Fixture;
  let bases: Record<string, string>;
  beforeEach(async () => {
    fx = await createSubmoduleFixture();
    expect((await cli(fx.root, "init")).code).toBe(ExitCode.Ok);
    bases = {};
    for (const repo of ["backend", "deploy"]) {
      const dir = join(fx.root, "repos", repo);
      bases[repo] = await gitOut(dir, "rev-parse", "HEAD");
      await fixtureGit(dir, "switch", "-q", "-c", "change/x");
    }
  });
  afterEach(() => fx.cleanup());

  async function commit(repo: string, file: string, content: string): Promise<void> {
    const dir = join(fx.root, "repos", repo);
    writeFileSync(join(dir, file), content);
    await fixtureGit(dir, "commit", "-q", "-am", "change");
  }

  const contract = (kind: ContractConfig["kind"]): ContractConfig => {
    const found = loadConfig(fx.root).config.contracts.find((c) => c.kind === kind);
    if (!found) throw new Error(`no ${kind} contract`);
    return found;
  };
  const check = (c: ContractConfig) =>
    checkContract(
      { root: fx.root, config: loadConfig(fx.root).config, id: "x", bases, gateOutputMaxLines: 40 },
      c,
    );

  test("a compatible OpenAPI change passes", async () => {
    const doc = parseYaml(OPENAPI) as { paths: Record<string, unknown>; info: { version: string } };
    doc.paths["/version"] = { get: { responses: { "200": { description: "version" } } } };
    await commit("backend", "api/openapi.yaml", toYaml(doc));
    const result = await check(contract("openapi"));
    expect(result).toMatchObject({ passed: true, breaking: [], consumerIssues: [] });
  });

  test("a breaking OpenAPI change fails, and consumers still using the path are named", async () => {
    await commit("backend", "api/openapi.yaml", OPENAPI.replace(/paths:[\s\S]*/, "paths: {}\n"));
    writeFileSync(
      join(fx.root, "repos/frontend/src/api.ts"),
      'export const health = () => fetch("/health");\n',
    );
    const result = await check(contract("openapi"));
    expect(result.passed).toBe(false);
    expect(result.breaking.map((b) => `${b.at}: ${b.message}`)).toEqual([
      "GET /health: operation was removed",
    ]);
    expect(result.consumerIssues).toEqual([
      "frontend still references /health, which the new contract no longer has",
    ]);

    const allowed = await check({ ...contract("openapi"), allowBreaking: true });
    expect(allowed.passed).toBe(false); // the consumer still breaks
    writeFileSync(join(fx.root, "repos/frontend/src/api.ts"), "export {};\n");
    const accepted = await check({ ...contract("openapi"), allowBreaking: true });
    expect(accepted.passed).toBe(true);
    expect(accepted.notes).toContain("1 breaking change(s) accepted (allowBreaking)");
  });

  test("Helm values: a new required value breaks the chart's own values.yaml", async () => {
    const schema = JSON.parse(
      readFileSync(join(fx.root, "repos/deploy/charts/app/values.schema.json"), "utf8"),
    ) as {
      required: string[];
      properties: Record<string, unknown>;
    };
    schema.required.push("resources");
    schema.properties.resources = { type: "object" };
    await commit("deploy", "charts/app/values.schema.json", JSON.stringify(schema, null, 2));
    const result = await check(contract("helm-values"));
    expect(result.passed).toBe(false);
    expect(result.breaking.map((b) => `${b.at}: ${b.message}`)).toEqual([
      "/resources: is now required",
    ]);
    expect(result.consumerIssues).toEqual([
      "deploy:charts/app/values.yaml (root) must have required property 'resources'",
    ]);
  });

  test("consumer validate commands run against the new contract and must be check-only", async () => {
    const base = contract("openapi");
    expect((await check({ ...base, validate: { frontend: "test -f {contract}" } })).passed).toBe(
      true,
    );
    const failing = await check({
      ...base,
      validate: { frontend: "echo 'type error in src/api.ts' >&2; exit 2" },
    });
    expect(failing.consumerIssues[0]).toContain("type error in src/api.ts");
    const writing = await check({ ...base, validate: { frontend: "echo x > generated.ts" } });
    expect(writing.consumerIssues[0]).toContain("is not check-only");
  });
});

describe("contract phase in the pipeline", () => {
  let fx: Fixture;
  beforeEach(async () => {
    fx = await createSubmoduleFixture();
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
        `"overrides": ${JSON.stringify({ backend: pass, frontend: pass })}`,
      ),
    );
    await fixtureGit(fx.root, "commit", "-q", "-am", "chore: gates");
  });
  afterEach(() => fx.cleanup());

  test("a breaking provider change gets one fix round, then the contract review runs", async () => {
    const tasks: ScriptedTask[] = [
      {
        id: "1.1",
        title: "Rework the API contract",
        repo: "backend",
        deps: [],
        touches: ["api/**"],
        file: "api/openapi.yaml",
        content: OPENAPI.replace(/paths:[\s\S]*/, "paths: {}\n"),
      },
    ];
    const base = factoryScript({
      changeId: "rework-api",
      summary: "Rework",
      repos: ["backend"],
      tasks,
    });
    const runtime = new ScriptedRuntime(async (call) => {
      if (
        call.agent === "implementer-backend" &&
        call.prompt.startsWith("Task contract-backend-1-1:")
      ) {
        expect(call.prompt).toContain("GET /health: operation was removed");
        return {
          edits: { "api/openapi.yaml": OPENAPI },
          handoff: { task: "contract-backend-1-1" },
        };
      }
      return base(call);
    });
    expect((await cliWith(runtime, fx.root, "run", "Rework the API")).code).toBe(ExitCode.Ok);
    const approve = await cliWith(runtime, fx.root, "approve", "rework-api");
    expect(approve.out).toContain("✗ openapi:backend:api/openapi.yaml");
    expect(approve.out).toContain("✓ openapi:backend:api/openapi.yaml");
    expect(approve.code).toBe(ExitCode.Ok);
    const run = loadRun(fx.root, "rework-api");
    expect(run?.phase).toBe("done");
    expect(run?.contractRounds).toBe(1);
    expect(run?.contractReviewed).toBe(true);
    expect(run?.tasks.map((t) => [t.id, t.kind, t.status])).toContainEqual([
      "contract-backend-1-1",
      "contract-fix",
      "merged",
    ]);
    expect(runtime.calls.filter((c) => c.agent === "contract-reviewer")).toHaveLength(1);
  });

  test("a contract review without a result pauses, and resume reviews again (audit P13)", async () => {
    const tasks: ScriptedTask[] = [
      {
        id: "1.1",
        title: "Document the health endpoint",
        repo: "backend",
        deps: [],
        touches: ["api/**"],
        file: "api/openapi.yaml",
        content: OPENAPI.replace("title: Backend API", "title: Backend API (documented)"),
      },
    ];
    const base = factoryScript({ changeId: "doc-api", summary: "Doc", repos: ["backend"], tasks });
    let broken = true;
    const runtime = new ScriptedRuntime(async (call) =>
      call.agent === "contract-reviewer" && broken ? { text: "timed out" } : base(call),
    );
    await cliWith(runtime, fx.root, "run", "Document the API");
    expect((await cliWith(runtime, fx.root, "approve", "doc-api")).code).toBe(ExitCode.Paused);
    const paused = loadRun(fx.root, "doc-api");
    expect(paused?.pausedReason).toContain("the contract review produced no result");
    expect(paused?.contractReviewed).toBe(false);

    broken = false;
    expect((await cliWith(runtime, fx.root, "resume", "doc-api")).code).toBe(ExitCode.Ok);
    expect(loadRun(fx.root, "doc-api")?.contractReviewed).toBe(true);
  });
});
