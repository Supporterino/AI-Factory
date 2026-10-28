import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ExitCode } from "../src/cli/exit-codes.ts";
import { runCli } from "../src/cli/main.ts";
import type { DoctorReport } from "../src/doctor/doctor.ts";
import { gateExecutables } from "../src/doctor/doctor.ts";
import { claimActive } from "../src/state/active.ts";
import {
  createSingleRepoFixture,
  createSubmoduleFixture,
  type Fixture,
  fixtureGit,
} from "./fixtures/workspaces.ts";
import { cli, gitOut } from "./helpers.ts";

describe("gateExecutables", () => {
  test("finds the programs a gate command runs, not builtins, keywords or variables", () => {
    expect(gateExecutables("npm run --silent lint")).toEqual(["npm"]);
    expect(
      gateExecutables('out="$(gofmt -l .)"; [ -z "$out" ] || { echo "needs gofmt:"; exit 1; }'),
    ).toEqual(["gofmt"]);
    expect(
      gateExecutables(
        'for c in charts/app; do helm template "$c" | kubeconform -strict || exit 1; done',
      ),
    ).toEqual(["helm", "kubeconform"]);
    expect(gateExecutables("FOO=1 ./bin/check && true")).toEqual(["./bin/check"]);
    expect(gateExecutables("echo 'unterminated")).toEqual([]);
  });
});

describe("doctor", () => {
  let fx: Fixture;
  afterEach(() => fx.cleanup());

  const passAll = {
    format: "true",
    lint: "true",
    types: "true",
    test: "true",
    testAffected: "true",
  };
  async function installed(
    make: () => Promise<Fixture>,
    overrides: Record<string, unknown>,
  ): Promise<string> {
    fx = await make();
    expect((await cli(fx.root, "init", "--no-graph")).code).toBe(ExitCode.Ok);
    const file = join(fx.root, "factory.config.jsonc");
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace(
        '"overrides": {}',
        `"overrides": ${JSON.stringify(overrides)}`,
      ),
    );
    await fixtureGit(fx.root, "commit", "-q", "-am", "chore: gate overrides");
    return fx.root;
  }
  async function report(root: string): Promise<DoctorReport> {
    const res = await cli(root, "doctor", "--json");
    return JSON.parse(res.out) as DoctorReport;
  }
  const find = (r: DoctorReport, name: string) => r.checks.find((c) => c.name === name);

  test("reports corrupt run files and a corrupt active lock (audit P15)", async () => {
    const root = await installed(createSingleRepoFixture, { app: passAll });
    mkdirSync(join(root, ".factory/runs"), { recursive: true });
    writeFileSync(join(root, ".factory/runs/broken.json"), "{not json");
    writeFileSync(join(root, ".factory/active.lock"), '{"changeId": 3}');
    const res = await cli(root, "doctor", "--json");
    expect(res.err).toBe("");
    const json = JSON.parse(res.out) as DoctorReport;
    expect(find(json, "active")).toMatchObject({ status: "fail" });
    expect(find(json, "active")?.detail).toContain(".factory/active.lock is corrupt");
    expect(find(json, "run broken")).toMatchObject({ status: "fail" });
  });

  test("warns about proxy variables and checks the graphify env (audit C)", async () => {
    const root = await installed(createSingleRepoFixture, { app: passAll });
    process.env.HTTPS_PROXY = "http://proxy.example:3128";
    try {
      const json = await report(root);
      expect(find(json, "proxy")).toMatchObject({ status: "warn" });
      expect(find(json, "graphify env")).toMatchObject({ status: "ok" });
    } finally {
      delete process.env.HTTPS_PROXY;
    }
    expect(find(await report(root), "proxy")).toBeUndefined();
  });

  test("warns when tsc runs without strict (audit G8)", async () => {
    const root = await installed(createSingleRepoFixture, { app: passAll });
    writeFileSync(
      join(root, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { noEmit: true } }),
    );
    await fixtureGit(root, "commit", "-q", "-am", "chore: loose tsconfig");
    const json = await report(root);
    expect(find(json, "app strict")).toMatchObject({ status: "warn" });
    writeFileSync(
      join(root, "tsconfig.json"),
      '{\n  // comments are fine\n  "compilerOptions": { "strict": true }\n}\n',
    );
    await fixtureGit(root, "commit", "-q", "-am", "chore: strict");
    expect(find(await report(root), "app strict")).toBeUndefined();
  });

  test("a healthy install passes, with the resolved gate table", async () => {
    const root = await installed(createSingleRepoFixture, { app: passAll });
    const res = await cli(root, "doctor");
    expect(res.code).toBe(ExitCode.Ok);
    expect(res.out).toContain("✓ AI repo pre-push hook: installed");
    expect(res.out).toContain("✓ reviewer: anthropic/claude-opus-5-5");
    expect(res.out).toContain("! graph: not built yet");
    expect(res.out).toMatch(/app format\s+true {2}\(override\)/);
    expect(res.out).toContain("0 problem(s)");

    const json = await report(root);
    expect(json.gates.map((g) => g.type)).toEqual(["format", "lint", "types", "test"]);
    expect(json.checks.filter((c) => c.status === "fail")).toEqual([]);
  });

  test("reports committed records and warns when the directory is gitignored", async () => {
    const root = await installed(createSingleRepoFixture, { app: passAll });
    expect(find(await report(root), "records")?.detail).toContain("local");

    const file = join(root, "factory.config.jsonc");
    writeFileSync(file, readFileSync(file, "utf8").replace('"mode": "local"', '"mode": "git"'));
    await fixtureGit(root, "commit", "-q", "-am", "chore: artifacts git");
    expect(find(await report(root), "records")?.status).toBe("warn"); // directory missing

    mkdirSync(join(root, "factory-records/reports"), { recursive: true });
    writeFileSync(join(root, "factory-records/reports/add-x.md"), "# add-x\n");
    await fixtureGit(root, "add", "-A");
    await fixtureGit(root, "commit", "-q", "-m", "docs(factory): record add-x");
    const ok = find(await report(root), "records");
    expect(ok?.status).toBe("ok");
    expect(ok?.detail).toContain("1 file(s)");

    writeFileSync(
      join(root, ".gitignore"),
      `${readFileSync(join(root, ".gitignore"), "utf8")}factory-records/\n`,
    );
    const ignored = find(await report(root), "records");
    expect(ignored?.status).toBe("warn");
    expect(ignored?.detail).toContain("gitignored");
  });

  test("reports missing gates, toolchains, hooks, models, drift and stale state", async () => {
    const root = await installed(createSingleRepoFixture, {
      app: { ...passAll, lint: "not-a-real-linter-xyz .", format: "skip" },
    });
    const file = join(root, "factory.config.jsonc");
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace(
        '"reviewer": "anthropic/claude-opus-5-5"',
        '"reviewer": "nowhere/model-x"',
      ),
    );
    await fixtureGit(root, "commit", "-q", "-am", "chore: model");
    rmSync(join(root, ".git/hooks/pre-push"));
    const lockFile = join(root, "factory.lock.json");
    writeFileSync(
      lockFile,
      readFileSync(lockFile, "utf8").replace(
        /"factoryVersion": "[^"]+"/,
        '"factoryVersion": "0.0.1"',
      ),
    );
    writeFileSync(join(root, "scratch.txt"), "wip\n");
    await claimActive(root, "ghost", 2 ** 22 + 17);
    await cli(root, "graph");

    const res = await cli(root, "doctor");
    expect(res.code).toBe(ExitCode.Precondition);
    const json = await report(root);
    expect(find(json, "app toolchain")).toMatchObject({
      status: "fail",
      detail: "not found: not-a-real-linter-xyz",
    });
    expect(find(json, "AI repo pre-push hook")).toMatchObject({
      status: "fail",
      detail: "missing",
    });
    expect(find(json, "reviewer")).toMatchObject({
      status: "fail",
      detail: "nowhere/model-x is not available to opencode",
    });
    expect(find(json, "factory")).toMatchObject({ status: "warn", fix: "ai-factory update" });
    expect(find(json, "AI repo working tree")).toMatchObject({ status: "warn" });
    expect(find(json, "active")).toMatchObject({ status: "warn", fix: "ai-factory resume ghost" });
    expect(find(json, "graph")).toMatchObject({ status: "ok" });
    expect(json.gates.find((g) => g.type === "format")?.problem).toContain("skip");

    // Factory commits leave the graph fresh; a code commit makes it stale.
    await fixtureGit(root, "commit", "-q", "--allow-empty", "-m", "chore: nothing");
    expect(find(await report(root), "graph")).toMatchObject({ status: "ok" });
    writeFileSync(join(root, "src/more.ts"), "export const more = 1;\n");
    await fixtureGit(root, "add", "src/more.ts");
    await fixtureGit(root, "commit", "-q", "-m", "feat: more");
    expect(find(await report(root), "graph")).toMatchObject({
      status: "warn",
      fix: "ai-factory graph",
    });
    expect(find(await report(root), "graph")?.detail).toContain("src/more.ts");

    // An edited managed file is reported as kept, a stale one as drift.
    writeFileSync(join(root, ".opencode/agents/tester.md"), "mine\n");
    const edited = await report(root);
    expect(find(edited, "your edits")?.detail).toContain(".opencode/agents/tester.md");
    writeFileSync(join(root, ".opencode/plugins/factory.js"), "export default {};\n");
    expect(find(await report(root), "guard plugin")).toMatchObject({ status: "fail" });
  });

  test("offers to initialise missing submodules", async () => {
    const root = await installed(createSubmoduleFixture, {
      backend: passAll,
      frontend: passAll,
      deploy: passAll,
    });
    await fixtureGit(root, "submodule", "deinit", "-q", "-f", "repos/deploy");
    const res = await cli(root, "doctor", "--json");
    const json = JSON.parse(res.out) as DoctorReport;
    expect(json.uninitialised).toEqual(["repos/deploy"]);
    expect(find(json, "repos/deploy")).toMatchObject({
      status: "warn",
      fix: "git submodule update --init repos/deploy",
    });

    const out: string[] = [];
    const questions: string[] = [];
    const code = await runCli(["doctor"], {
      cwd: root,
      out: (t) => out.push(t),
      err: (t) => out.push(t),
      confirm: async (q) => {
        questions.push(q);
        return true;
      },
    });
    expect(questions[0]).toContain("repos/deploy");
    expect(out.join("\n")).toContain("initialised repos/deploy");
    expect(await gitOut(join(root, "repos/deploy"), "rev-parse", "--is-inside-work-tree")).toBe(
      "true",
    );
    // Its hooks live in .git/modules and survived the deinit.
    expect(code).toBe(ExitCode.Ok);
    expect(out.join("\n")).toContain("✓ deploy pre-push hook: installed");
  });
});
