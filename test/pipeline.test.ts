import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ExitCode } from "../src/cli/exit-codes.ts";
import { readActive } from "../src/state/active.ts";
import { loadRun } from "../src/state/run.ts";
import { factoryScript, type ScriptedTask } from "./fixtures/factory-script.ts";
import { ScriptedRuntime } from "./fixtures/scripted-runtime.ts";
import {
  BACKEND_FILES,
  createSingleRepoFixture,
  createSubmoduleFixture,
  type Fixture,
  fixtureGit,
} from "./fixtures/workspaces.ts";
import { cli, cliWith, gitOut } from "./helpers.ts";

const ID = "add-health";

const SUB_TASKS: ScriptedTask[] = [
  {
    id: "1.1",
    title: "Add the health path to the OpenAPI contract",
    repo: "backend",
    deps: [],
    touches: ["api/openapi.yaml"],
    file: "api/openapi.yaml",
    // Compatible: same paths, new version.
    content: (BACKEND_FILES["api/openapi.yaml"] ?? "").replace("version: 1.0.0", "version: 1.1.0"),
  },
  {
    id: "1.2",
    title: "Add the health handler",
    repo: "backend",
    deps: ["1.1"],
    touches: ["internal/http/**"],
    file: "internal/http/health.go",
    content: "package http\n",
  },
  {
    id: "1.3",
    title: "Add a readiness metric",
    repo: "backend",
    deps: ["1.1"],
    touches: ["internal/metrics/**"],
    file: "internal/metrics/ready.go",
    content: "package metrics\n",
  },
  {
    id: "2.1",
    title: "Show the health badge",
    repo: "frontend",
    deps: ["1.1"],
    touches: ["src/components/**"],
    file: "src/components/HealthBadge.tsx",
    content: "export const HealthBadge = () => null;\n",
  },
];

/** Rewrites part of factory.config.jsonc and commits it (the AI repo must be clean to branch). */
async function configure(root: string, edit: (text: string) => string): Promise<void> {
  const file = join(root, "factory.config.jsonc");
  writeFileSync(file, edit(readFileSync(file, "utf8")));
  await fixtureGit(root, "commit", "-q", "-am", "chore: configure the factory");
}

const passAll = { format: "true", lint: "true", types: "true", test: "true", testAffected: "true" };

describe("pipeline: AI repo with submodules", () => {
  let fx: Fixture;
  beforeEach(async () => {
    fx = await createSubmoduleFixture();
    expect((await cli(fx.root, "init")).code).toBe(ExitCode.Ok);
    await configure(fx.root, (t) =>
      t.replace(
        '"overrides": {}',
        `"overrides": ${JSON.stringify({ backend: passAll, frontend: passAll })}`,
      ),
    );
  });
  afterEach(() => fx.cleanup());

  test("run → approve → three repos, parallel tasks, ordered commits, provisional pointers, no push", async () => {
    let aiBranchAtDesign = "";
    const runtime = new ScriptedRuntime(
      factoryScript({
        changeId: ID,
        summary: "Add a health endpoint and show it in the UI",
        repos: ["backend", "frontend"],
        tasks: SUB_TASKS,
        delayMs: 150,
        testFiles: {
          backend: "internal/http/health_test.go",
          frontend: "src/components/HealthBadge.test.tsx",
        },
        onCall: (call) => {
          if (call.agent === "architect" && aiBranchAtDesign === "") {
            aiBranchAtDesign = spawnSync("git", ["branch", "--show-current"], { cwd: fx.root })
              .stdout.toString()
              .trim();
          }
        },
      }),
    );

    const run = await cliWith(
      runtime,
      fx.root,
      "run",
      "Add a health endpoint and show it in the UI",
    );
    expect(run.err).toBe("");
    expect(run.code).toBe(ExitCode.Ok);
    expect(run.out).toContain(`${ID}: awaiting approval`);
    // §7 step 1: the AI repo branched before design.
    expect(aiBranchAtDesign).toBe(`change/${ID}`);
    expect(loadRun(fx.root, ID)?.phase).toBe("awaiting-approval");
    const remotesBefore = await Promise.all(
      ["backend", "frontend", "deploy"].map((r) =>
        gitOut(fx.base, "ls-remote", join(fx.base, `remotes/${r}.git`)),
      ),
    );

    const approve = await cliWith(runtime, fx.root, "approve", ID);
    expect(approve.err).toBe("");
    expect(approve.out).toContain(`${ID}: done`);
    expect(approve.code).toBe(ExitCode.Ok);

    // 1.2, 1.3 (backend) and 2.1 (frontend) ran at the same time, within maxAgents (4).
    expect(runtime.maxByAgent.get("implementer")).toBe(3);
    expect(runtime.maxRunning).toBeLessThanOrEqual(4);

    // change/<id> in the AI repo and both touched submodules; deploy untouched.
    for (const repo of ["repos/backend", "repos/frontend"]) {
      expect(await gitOut(join(fx.root, repo), "branch", "--show-current")).toBe(`change/${ID}`);
    }
    expect(await gitOut(join(fx.root, "repos/deploy"), "branch", "--list", `change/${ID}`)).toBe(
      "",
    );
    const backendLog = (
      await gitOut(
        join(fx.root, "repos/backend"),
        "log",
        "--format=%s|%(trailers:key=Change-Id,valueonly,separator=)",
        `main..change/${ID}`,
      )
    ).split("\n");
    expect(backendLog).toContain(`feat: add the health handler|${ID}`);
    expect(backendLog).toContain(`test: ensure every scenario of backend has a test|${ID}`);

    // AI repo commit order: spec, provisional pointers, archive.
    expect((await gitOut(fx.root, "log", "--format=%s", "-3")).split("\n")).toEqual([
      `chore(spec): archive ${ID}`,
      `chore(submodules): bump for ${ID} [provisional]`,
      `docs(spec): ${ID}`,
    ]);
    expect(await gitOut(fx.root, "rev-parse", "HEAD:repos/backend")).toBe(
      await gitOut(join(fx.root, "repos/backend"), "rev-parse", `change/${ID}`),
    );
    expect(await gitOut(fx.root, "status", "--porcelain")).toBe("");

    // Archived spec, merged main spec, report, no worktrees left, lock released, nothing pushed.
    expect(readdirSync(join(fx.root, "openspec/changes/archive")).some((d) => d.endsWith(ID))).toBe(
      true,
    );
    expect(existsSync(join(fx.root, "openspec/specs/health/spec.md"))).toBe(true);
    const report = readFileSync(join(fx.root, ".factory/reports", `${ID}.md`), "utf8");
    expect(report).toContain(`ai-factory repoint ${ID}`);
    expect(report).toContain("nothing was pushed");
    expect(existsSync(join(fx.root, ".factory/worktrees", ID))).toBe(false);
    const logDir = join(fx.root, ".factory/logs", ID);
    const log = readdirSync(logDir)
      .map((f) => readFileSync(join(logDir, f), "utf8"))
      .join("");
    expect(log).toContain('"kind":"gates","repo":"backend","mode":"full","passed":true');
    expect(readActive(fx.root)).toBeUndefined();
    const remotesAfter = await Promise.all(
      ["backend", "frontend", "deploy"].map((r) =>
        gitOut(fx.base, "ls-remote", join(fx.base, `remotes/${r}.git`)),
      ),
    );
    expect(remotesAfter).toEqual(remotesBefore);
    expect(runtime.closed).toBe(true);
  });
});

const SINGLE_TASKS: ScriptedTask[] = [
  {
    id: "1.1",
    title: "Add a multiply helper",
    repo: "app",
    deps: [],
    touches: ["src/mul.ts"],
    file: "src/mul.ts",
    content: "export const mul = (a: number, b: number) => a * b;\n",
  },
  {
    id: "1.2",
    title: "Add a divide helper",
    repo: "app",
    deps: [],
    touches: ["src/div.ts"],
    file: "src/div.ts",
    content: "export const div = (a: number, b: number) => a / b;\n",
  },
];

describe("pipeline: single repo", () => {
  let fx: Fixture;
  beforeEach(async () => {
    fx = await createSingleRepoFixture();
    expect((await cli(fx.root, "init")).code).toBe(ExitCode.Ok);
  });
  afterEach(() => fx.cleanup());

  const withGates = (gates: Record<string, string>) =>
    configure(fx.root, (t) =>
      t.replace('"overrides": {}', `"overrides": ${JSON.stringify({ app: gates })}`),
    );

  test("a gate failure retries 3× with feedback, pauses with a report, and retry + resume finish it", async () => {
    await withGates({ ...passAll, lint: "! grep -rq BROKEN src" });
    let fixed = false;
    const runtime = new ScriptedRuntime(
      factoryScript({
        changeId: ID,
        summary: "Math helpers",
        repos: ["app"],
        tasks: SINGLE_TASKS,
        implement: (task) =>
          task.id === "1.1" && !fixed
            ? { edits: { [task.file]: "// BROKEN\n" }, handoff: { task: task.id } }
            : undefined,
      }),
    );
    expect((await cliWith(runtime, fx.root, "run", "Add math helpers")).code).toBe(ExitCode.Ok);

    const approve = await cliWith(runtime, fx.root, "approve", ID);
    expect(approve.code).toBe(ExitCode.Paused);
    const state = loadRun(fx.root, ID);
    expect(state?.tasks.map((t) => [t.id, t.status, t.failures])).toEqual([
      ["1.1", "failed", 4],
      ["1.2", "merged", 0],
    ]);
    const attempts = runtime.calls.filter(
      (c) => c.agent === "implementer-app" && c.prompt.startsWith("Task 1.1:"),
    );
    expect(attempts).toHaveLength(4);
    expect(attempts[1]?.prompt).toContain("The previous attempt failed with");
    expect(attempts[1]?.prompt).toContain("[lint]");
    const report = readFileSync(join(fx.root, ".factory/reports", `${ID}-paused.md`), "utf8");
    expect(report).toContain("- Failed: 1.1");
    expect(report).toContain(`ai-factory retry ${ID} --task <task>`);

    fixed = true;
    expect((await cli(fx.root, "retry", ID, "--task", "1.1")).code).toBe(ExitCode.Ok);
    const resume = await cliWith(runtime, fx.root, "resume", ID);
    expect(resume.out).toContain(`${ID}: done`);
    expect(resume.code).toBe(ExitCode.Ok);
    expect(await gitOut(fx.root, "log", "-1", "--format=%s")).toBe(`chore(spec): archive ${ID}`);
    expect(await gitOut(fx.root, "show", `change/${ID}:src/mul.ts`)).toContain("mul");
  });

  test("edits outside a task's touches are reverted and counted", async () => {
    await withGates(passAll);
    const runtime = new ScriptedRuntime(
      factoryScript({
        changeId: ID,
        summary: "Math helpers",
        repos: ["app"],
        tasks: SINGLE_TASKS,
        implement: (task, call) =>
          task.id === "1.2" && !call.prompt.includes("previous attempt failed")
            ? {
                edits: { [task.file]: task.content, "README.md": "sneaky\n" },
                handoff: { task: task.id },
              }
            : undefined,
      }),
    );
    await cliWith(runtime, fx.root, "run", "Add math helpers");
    expect((await cliWith(runtime, fx.root, "approve", ID)).code).toBe(ExitCode.Ok);
    const task = loadRun(fx.root, ID)?.tasks.find((t) => t.id === "1.2");
    expect(task?.failures).toBe(1);
    expect(await gitOut(fx.root, "log", `change/${ID}`, "--format=%H", "--", "README.md")).toBe("");
  });

  test("the approval is voided by a spec edit and survives checkbox ticks", async () => {
    await withGates(passAll);
    const runtime = new ScriptedRuntime(
      factoryScript({ changeId: ID, summary: "Math", repos: ["app"], tasks: SINGLE_TASKS }),
    );
    await cliWith(runtime, fx.root, "run", "Add math helpers");
    expect((await cliWith(runtime, fx.root, "approve", ID, "--no-continue")).code).toBe(
      ExitCode.Ok,
    );

    const tasksFile = join(fx.root, "openspec/changes", ID, "tasks.md");
    writeFileSync(tasksFile, readFileSync(tasksFile, "utf8").replace("- [ ] 1.1", "- [x] 1.1"));
    await fixtureGit(fx.root, "commit", "-q", "-am", "chore: tick");
    const proposal = join(fx.root, "openspec/changes", ID, "proposal.md");
    writeFileSync(proposal, `${readFileSync(proposal, "utf8")}\n- also delete the database\n`);
    await fixtureGit(fx.root, "commit", "-q", "-am", "docs: sneaky spec edit");

    const resume = await cliWith(runtime, fx.root, "resume", ID);
    expect(resume.code).toBe(ExitCode.Precondition);
    expect(resume.err).toContain("changed after approval");

    writeFileSync(
      proposal,
      readFileSync(proposal, "utf8").replace("\n- also delete the database\n", ""),
    );
    await fixtureGit(fx.root, "commit", "-q", "-am", "docs: revert");
    expect((await cliWith(runtime, fx.root, "resume", ID)).code).toBe(ExitCode.Ok);
  });

  test("a second approved change queues behind the active one and starts after it closes", async () => {
    await withGates(passAll);
    const second = "add-mod";
    const secondTasks: ScriptedTask[] = [
      {
        id: "1.1",
        title: "Add a modulo helper",
        repo: "app",
        deps: [],
        touches: ["src/mod.ts"],
        file: "src/mod.ts",
        content: "export const mod = (a: number, b: number) => a % b;\n",
      },
    ];
    let queuedOutput = "";
    const scripts = {
      first: factoryScript({
        changeId: ID,
        summary: "Math",
        repos: ["app"],
        tasks: SINGLE_TASKS,
        onCall: async (call) => {
          // While the first change implements, the second one gets approved.
          if (call.agent === "implementer-app" && queuedOutput === "") {
            queuedOutput = "pending";
            const res = await cliWith(
              new ScriptedRuntime(scripts.second),
              fx.root,
              "approve",
              second,
            );
            queuedOutput = res.out;
          }
        },
      }),
      second: factoryScript({
        changeId: second,
        summary: "Modulo",
        repos: ["app"],
        tasks: secondTasks,
      }),
    };
    const firstRuntime = new ScriptedRuntime(scripts.first);
    expect((await cliWith(firstRuntime, fx.root, "run", "Add math helpers")).code).toBe(
      ExitCode.Ok,
    );
    const secondRun = await cliWith(
      new ScriptedRuntime(scripts.second),
      fx.root,
      "run",
      "Add modulo",
    );
    expect(secondRun.out).toContain(`change ${second} (drafted in .factory/drafts/${second}`);

    // The first approval drives both: the second change is queued, then starts after close.
    const approve = await cliWith(
      new ScriptedRuntime(async (c) =>
        c.agent === "implementer-app" && c.prompt.includes("modulo")
          ? scripts.second(c)
          : scripts.first(c),
      ),
      fx.root,
      "approve",
      ID,
    );
    expect(queuedOutput).toContain(`${second} is queued behind ${ID}`);
    expect(approve.out).toContain(`▶ starting queued change ${second}`);
    expect(approve.out).toContain(`${second}: done`);
    expect(loadRun(fx.root, ID)?.phase).toBe("done");
    expect(loadRun(fx.root, second)?.phase).toBe("done");
    expect(await gitOut(fx.root, "branch", "--show-current")).toBe(`change/${second}`);
    expect(existsSync(join(fx.root, ".factory/drafts", second))).toBe(false);
  });
});
