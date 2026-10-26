import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { ExitCode } from "../src/cli/exit-codes.ts";
import { loadConfig } from "../src/config/load.ts";
import { approve } from "../src/pipeline/approve.ts";
import { Pipeline } from "../src/pipeline/context.ts";
import { readActive, readQueue } from "../src/state/active.ts";
import { loadRun, updateRun } from "../src/state/run.ts";
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

  test("one failing explorer does not sink the design (audit P20)", async () => {
    const team = factoryScript({
      changeId: ID,
      summary: "Add a health endpoint and show it in the UI",
      repos: ["backend", "frontend"],
      tasks: SUB_TASKS,
    });
    const runtime = new ScriptedRuntime(async (call) => {
      if (call.agent === "explorer" && call.directory.endsWith("repos/backend"))
        throw new Error("explorer crashed");
      return team(call);
    });
    const run = await cliWith(runtime, fx.root, "run", "Add a health endpoint");
    expect(run.err).toBe("");
    expect(loadRun(fx.root, ID)?.phase).toBe("awaiting-approval");
    const design = runtime.calls.find(
      (c) => c.agent === "architect" && c.prompt.includes("explor"),
    );
    expect(design?.prompt).toContain("(explorer failed: explorer crashed)");
  });

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
    // Acceptance (audit T): the contract gate ran and passed, the graph covers every merge,
    // and both code repos passed their full suites.
    const done = loadRun(fx.root, ID);
    expect(Object.keys(done?.contractResults ?? {}).length).toBeGreaterThan(0);
    expect(Object.values(done?.contractResults ?? {}).every((r) => r.passed)).toBe(true);
    expect(done?.mergeSeq).toBeGreaterThan(0);
    expect(done?.graphSeq).toBe(done?.mergeSeq);
    expect(done?.fullSuite).toMatchObject({
      backend: { passed: true },
      frontend: { passed: true },
    });
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
    // Every attempt is a fresh session: each one needs the real gate output (audit P1).
    for (const a of attempts.slice(1)) expect(a.prompt).toContain("[lint]");
    expect(attempts[2]?.prompt).toContain("same failures as the previous attempt");
    const report = readFileSync(join(fx.root, ".factory/reports", `${ID}-paused.md`), "utf8");
    expect(report).toContain("- Failed: 1.1");
    expect(report).toContain("[lint]");
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

  test("an agent that commits cannot slip out-of-scope files past the audit", async () => {
    await withGates(passAll);
    const runtime = new ScriptedRuntime(
      factoryScript({
        changeId: ID,
        summary: "Math helpers",
        repos: ["app"],
        tasks: SINGLE_TASKS,
        implement: (task, call) => {
          if (task.id !== "1.2" || call.prompt.includes("previous attempt failed"))
            return undefined;
          // The agent commits itself (an evasion of the blocked `git commit`).
          writeFileSync(join(call.directory, task.file), task.content);
          writeFileSync(join(call.directory, "README.md"), "sneaky\n");
          const git = (...args: string[]) =>
            spawnSync("git", args, { cwd: call.directory, encoding: "utf8" });
          git("add", "-A");
          git("-c", "user.name=a", "-c", "user.email=a@a", "commit", "-qm", "sneaky");
          return { handoff: { task: task.id } };
        },
      }),
    );
    await cliWith(runtime, fx.root, "run", "Add math helpers");
    expect((await cliWith(runtime, fx.root, "approve", ID)).code).toBe(ExitCode.Ok);
    const task = loadRun(fx.root, ID)?.tasks.find((t) => t.id === "1.2");
    expect(task?.failures).toBe(1);
    expect(await gitOut(fx.root, "log", `change/${ID}`, "--format=%s", "--", "README.md")).toBe("");
    expect(await gitOut(fx.root, "log", `change/${ID}`, "--format=%s")).not.toContain("sneaky");
  });

  test("a task that rewrites a gate script fails until it reverts it", async () => {
    await withGates({ format: "true", types: "true", testAffected: "true" }); // lint: package.json
    const runtime = new ScriptedRuntime(
      factoryScript({
        changeId: ID,
        summary: "Math helpers",
        repos: ["app"],
        tasks: SINGLE_TASKS.map((t) =>
          t.id === "1.2" ? { ...t, touches: [...t.touches, "package.json"] } : t,
        ),
        implement: (task, call) => {
          if (task.id !== "1.2" || call.prompt.includes("previous attempt failed"))
            return undefined;
          const pkg = JSON.parse(readFileSync(join(call.directory, "package.json"), "utf8"));
          pkg.scripts.lint = "true";
          return {
            edits: { [task.file]: task.content, "package.json": JSON.stringify(pkg, null, 2) },
            handoff: { task: task.id },
          };
        },
      }),
    );
    await cliWith(runtime, fx.root, "run", "Add math helpers");
    await cliWith(runtime, fx.root, "approve", ID);
    const attempts = runtime.calls.filter((c) => c.prompt.startsWith("Task 1.2:"));
    expect(attempts[1]?.prompt).toContain("revert these gate definitions");
    expect(attempts[1]?.prompt).toContain("package.json: lint");
  });

  test("if branching fails after intake, resume branches first and the spec never lands on main", async () => {
    await withGates(passAll);
    writeFileSync(join(fx.root, "dirty.txt"), "x\n");
    await fixtureGit(fx.root, "add", "dirty.txt");
    const runtime = new ScriptedRuntime(
      factoryScript({ changeId: ID, summary: "Math helpers", repos: ["app"], tasks: SINGLE_TASKS }),
    );
    expect((await cliWith(runtime, fx.root, "run", "Add math helpers")).code).toBe(
      ExitCode.Precondition,
    );
    await fixtureGit(fx.root, "commit", "-q", "-m", "chore: dirty");
    expect((await cliWith(runtime, fx.root, "resume", ID)).code).toBe(ExitCode.Ok);
    expect(await gitOut(fx.root, "branch", "--show-current")).toBe(`change/${ID}`);
    expect((await cliWith(runtime, fx.root, "approve", ID, "--no-continue")).code).toBe(
      ExitCode.Ok,
    );
    expect(await gitOut(fx.root, "log", "-1", "--format=%s", "main")).toBe("chore: dirty");
    expect(await gitOut(fx.root, "log", "-1", "--format=%s", `change/${ID}`)).toBe(
      `docs(spec): ${ID}`,
    );
  });

  test("abort works outside implementation too, and resume then finishes the change", async () => {
    await withGates(passAll);
    let aborted = false;
    const runtime = new ScriptedRuntime(
      factoryScript({
        changeId: ID,
        summary: "Math helpers",
        repos: ["app"],
        tasks: SINGLE_TASKS,
        onCall: async (call) => {
          if (call.agent === "reviewer" && !aborted) {
            aborted = true;
            expect((await cli(fx.root, "abort", ID)).code).toBe(ExitCode.Ok);
          }
        },
      }),
    );
    await cliWith(runtime, fx.root, "run", "Add math helpers");
    expect((await cliWith(runtime, fx.root, "approve", ID)).code).toBe(ExitCode.Paused);
    expect(loadRun(fx.root, ID)?.phase).toBe("aborted");
    expect(readActive(fx.root)).toBeUndefined();
    expect(await gitOut(fx.root, "log", "-1", "--format=%s", `change/${ID}`)).not.toContain(
      "archive",
    );

    const resume = await cliWith(runtime, fx.root, "resume", ID);
    expect(resume.code).toBe(ExitCode.Ok);
    expect(loadRun(fx.root, ID)).toMatchObject({ phase: "done", abortRequested: false });
  });

  test("a spec edit after approval stops a resumed change (audit P9)", async () => {
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
    await cliWith(runtime, fx.root, "run", "Add math helpers");
    expect((await cliWith(runtime, fx.root, "approve", ID)).code).toBe(ExitCode.Paused);
    const proposal = join(fx.root, "openspec/changes", ID, "proposal.md");
    writeFileSync(proposal, `${readFileSync(proposal, "utf8")}\n- also delete the database\n`);
    await fixtureGit(fx.root, "commit", "-q", "-am", "docs: spec edit after approval");
    fixed = true;
    await cli(fx.root, "retry", ID, "--task", "1.1");
    const resume = await cliWith(runtime, fx.root, "resume", ID);
    expect(resume.code).toBe(ExitCode.Precondition);
    expect(resume.err).toContain("changed after approval");
    expect(resume.err).toContain("git checkout");
    expect(loadRun(fx.root, ID)?.phase).not.toBe("done");
    expect(loadRun(fx.root, ID)?.tasks.find((t) => t.id === "1.1")?.status).not.toBe("merged");
  });

  test("a review without a result pauses the change instead of passing (audit P13)", async () => {
    await withGates(passAll);
    const team = factoryScript({
      changeId: ID,
      summary: "Math helpers",
      repos: ["app"],
      tasks: SINGLE_TASKS,
    });
    let broken = true;
    const runtime = new ScriptedRuntime(async (call) =>
      call.agent === "reviewer" && broken ? { text: "I ran out of time." } : team(call),
    );
    await cliWith(runtime, fx.root, "run", "Add math helpers");
    expect((await cliWith(runtime, fx.root, "approve", ID)).code).toBe(ExitCode.Paused);
    const paused = loadRun(fx.root, ID);
    expect(paused?.phase).toBe("paused");
    expect(paused?.pausedReason).toContain("review of app produced no result");
    expect(paused?.reviewed).not.toContain("app");
    expect(paused?.tasks.some((t) => t.id === "test-app")).toBe(false);

    broken = false;
    expect((await cliWith(runtime, fx.root, "resume", ID)).code).toBe(ExitCode.Ok);
    expect(loadRun(fx.root, ID)?.phase).toBe("done");
  });

  test("serial mode: a failed task's leftovers are set aside, not charged to the next task (audit P10)", async () => {
    await configure(fx.root, (t) =>
      t
        .replace('"withinRepo": "worktrees"', '"withinRepo": "serial"')
        .replace(
          '"overrides": {}',
          `"overrides": ${JSON.stringify({ app: { ...passAll, lint: "! grep -rq BROKEN src" } })}`,
        ),
    );
    const runtime = new ScriptedRuntime(
      factoryScript({
        changeId: ID,
        summary: "Math helpers",
        repos: ["app"],
        tasks: SINGLE_TASKS,
        implement: (task) =>
          task.id === "1.1"
            ? { edits: { [task.file]: "// BROKEN\n" }, handoff: { task: task.id } }
            : undefined,
      }),
    );
    await cliWith(runtime, fx.root, "run", "Add math helpers");
    expect((await cliWith(runtime, fx.root, "approve", ID)).code).toBe(ExitCode.Paused);
    expect(loadRun(fx.root, ID)?.tasks.map((t) => [t.id, t.status, t.failures])).toEqual([
      ["1.1", "failed", 4],
      ["1.2", "merged", 0],
    ]);
    // The evidence is kept in a stash, and the checkout is clean.
    expect(await gitOut(fx.root, "stash", "list")).toContain(`ai-factory ${ID} 1.1`);
    expect(await gitOut(fx.root, "status", "--porcelain")).toBe("");
  });

  test("a failed dependency install pauses without spending budget and is retried (audit P12)", async () => {
    await withGates(passAll);
    writeFileSync(join(fx.root, "package-lock.json"), "{}\n");
    await fixtureGit(fx.root, "add", "package-lock.json");
    await fixtureGit(fx.root, "commit", "-q", "-m", "chore: lockfile");
    const bin = join(fx.root, "..", "fake-bin");
    mkdirSync(bin, { recursive: true });
    const flag = join(fx.root, "..", "registry-down");
    writeFileSync(flag, "");
    writeFileSync(
      join(bin, "npm"),
      `#!/bin/sh\nif [ -e '${flag}' ]; then echo 'ETIMEDOUT registry' >&2; exit 1; fi\nexit 0\n`,
    );
    chmodSync(join(bin, "npm"), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    try {
      const runtime = new ScriptedRuntime(
        factoryScript({
          changeId: ID,
          summary: "Math helpers",
          repos: ["app"],
          tasks: SINGLE_TASKS,
        }),
      );
      await cliWith(runtime, fx.root, "run", "Add math helpers");
      expect((await cliWith(runtime, fx.root, "approve", ID)).code).toBe(ExitCode.Paused);
      const paused = loadRun(fx.root, ID);
      expect(paused?.pausedReason).toContain("dependency install failed");
      expect(paused?.tasks.map((t) => [t.id, t.status, t.failures])).toEqual([
        ["1.1", "pending", 0],
        ["1.2", "pending", 0],
      ]);
      rmSync(flag);
      // The kept worktrees install again on resume.
      expect((await cliWith(runtime, fx.root, "resume", ID)).code).toBe(ExitCode.Ok);
      expect(loadRun(fx.root, ID)?.phase).toBe("done");
    } finally {
      process.env.PATH = path;
    }
  });

  test("a queued change resumed by hand leaves the queue (audit P11)", async () => {
    await withGates(passAll);
    const queued: string[][] = [];
    const runtime = new ScriptedRuntime(
      factoryScript({
        changeId: ID,
        summary: "Math helpers",
        repos: ["app"],
        tasks: SINGLE_TASKS,
        onCall: (call) => {
          if (call.agent === "implementer-app")
            queued.push(readQueue(fx.root).entries.map((e) => e.changeId));
        },
      }),
    );
    await cliWith(runtime, fx.root, "run", "Add math helpers");
    // Another change holds the workspace: the approved change waits in the queue.
    writeFileSync(
      join(fx.root, ".factory/active.lock"),
      JSON.stringify({ changeId: "other", pid: null, host: hostname(), since: "now" }),
    );
    expect((await cliWith(runtime, fx.root, "approve", ID)).out).toContain("queued behind other");
    expect(readQueue(fx.root).entries.map((e) => e.changeId)).toEqual([ID]);
    // The change's definitions are fixed at approval, not when it becomes active (audit P18).
    expect(existsSync(join(fx.root, ".factory/runs", ID, "snapshot/gates.json"))).toBe(true);
    expect(existsSync(join(fx.root, ".factory/worktrees", ID, ".opencode/agents"))).toBe(true);
    rmSync(join(fx.root, ".factory/active.lock"));
    const resumed = await cliWith(runtime, fx.root, "resume", ID);
    expect(resumed.code).toBe(ExitCode.Ok);
    expect(resumed.out).not.toContain("starting queued change");
    expect(queued.every((q) => !q.includes(ID))).toBe(true);
    expect(readQueue(fx.root).entries).toEqual([]);
  });

  test("an invalid handoff gets one repair turn, which costs no retry budget (audit T)", async () => {
    await withGates(passAll);
    const team = factoryScript({
      changeId: ID,
      summary: "Math helpers",
      repos: ["app"],
      tasks: SINGLE_TASKS,
    });
    let first = true;
    const runtime = new ScriptedRuntime(async (call) => {
      if (call.agent === "implementer-app" && first && call.prompt.startsWith("Task 1.1:")) {
        first = false;
        return { text: "Done, I think.", edits: { "src/mul.ts": SINGLE_TASKS[0]?.content ?? "" } };
      }
      if (call.prompt.startsWith("Your handoff is invalid")) return { handoff: { task: "1.1" } };
      return team(call);
    });
    await cliWith(runtime, fx.root, "run", "Add math helpers");
    expect((await cliWith(runtime, fx.root, "approve", ID)).code).toBe(ExitCode.Ok);
    const repairs = runtime.calls.filter((c) => c.prompt.startsWith("Your handoff is invalid"));
    expect(repairs).toHaveLength(1);
    expect(repairs[0]?.prompt).toContain("no ```json block");
    expect(loadRun(fx.root, ID)?.tasks.find((t) => t.id === "1.1")?.failures).toBe(0);
  });

  test("an approved spec commit missing from the change branch stops the change (audit T)", async () => {
    await withGates(passAll);
    const team = factoryScript({
      changeId: ID,
      summary: "Math helpers",
      repos: ["app"],
      tasks: SINGLE_TASKS,
    });
    let broken = true;
    const runtime = new ScriptedRuntime(async (call) =>
      call.agent === "reviewer" && broken ? { text: "I ran out of time." } : team(call),
    );
    await cliWith(runtime, fx.root, "run", "Add math helpers");
    expect((await cliWith(runtime, fx.root, "approve", ID)).code).toBe(ExitCode.Paused);
    broken = false;
    // The approval names a commit the change branch does not contain.
    const tree = await gitOut(fx.root, "rev-parse", "HEAD^{tree}");
    const stray = await gitOut(fx.root, "commit-tree", tree, "-m", "stray");
    const file = join(fx.root, ".factory/approvals", `${ID}.json`);
    const approval = JSON.parse(readFileSync(file, "utf8")) as { specCommit: string };
    writeFileSync(file, JSON.stringify({ ...approval, specCommit: stray }));
    await updateRun(fx.root, ID, (d) => {
      d.phase = "reviewing";
    });
    const resumed = await cliWith(runtime, fx.root, "resume", ID);
    expect(resumed.code).toBe(ExitCode.Precondition);
    expect(resumed.err).toContain(`is not on change/${ID}`);
  });

  test("a second driver cannot enter review, contracts or closing (audit P14)", async () => {
    await withGates(passAll);
    const team = factoryScript({
      changeId: ID,
      summary: "Math helpers",
      repos: ["app"],
      tasks: SINGLE_TASKS,
    });
    let broken = true;
    const runtime = new ScriptedRuntime(async (call) =>
      call.agent === "reviewer" && broken ? { text: "I ran out of time." } : team(call),
    );
    await cliWith(runtime, fx.root, "run", "Add math helpers");
    expect((await cliWith(runtime, fx.root, "approve", ID)).code).toBe(ExitCode.Paused);
    broken = false;

    // Another live process drives the change through its review.
    const other = Bun.spawn(["sleep", "60"]);
    try {
      writeFileSync(
        join(fx.root, ".factory/active.lock"),
        JSON.stringify({ changeId: ID, pid: other.pid, host: hostname(), since: "now" }),
      );
      for (const phase of ["reviewing", "contracts", "full-suite", "closing"] as const) {
        await updateRun(fx.root, ID, (d) => {
          d.phase = phase;
        });
        const calls = runtime.calls.length;
        const second = await cliWith(runtime, fx.root, "resume", ID);
        expect(second.code).toBe(ExitCode.Precondition);
        expect(second.err).toContain(`already being driven by pid ${other.pid}`);
        expect(runtime.calls.length).toBe(calls);
        expect(loadRun(fx.root, ID)?.phase).toBe(phase);
      }
    } finally {
      other.kill();
    }
  });

  test("approve re-checks the phase under the run lock (audit P14)", async () => {
    const runtime = new ScriptedRuntime(
      factoryScript({ changeId: ID, summary: "Math helpers", repos: ["app"], tasks: SINGLE_TASKS }),
    );
    await cliWith(runtime, fx.root, "run", "Add math helpers");
    const p = new Pipeline(fx.root, loadConfig(fx.root).config, {
      runtime,
      out: () => {},
      signal: new AbortController().signal,
    });
    // A concurrent approve + resume got there first, after this approve read the phase.
    const update = p.update.bind(p);
    p.update = async (id, mutate) => {
      await updateRun(fx.root, id, (d) => {
        d.phase = "implementing";
      });
      return update(id, mutate);
    };
    await expect(approve(p, ID)).rejects.toThrow("is past approval (phase implementing)");
    const run = loadRun(fx.root, ID);
    expect(run?.phase).toBe("implementing");
    expect(run?.tasks).toEqual([]);
  });

  test("`gate <id>` checks with the change's snapshot, not today's config (audit G9)", async () => {
    await withGates(passAll);
    const runtime = new ScriptedRuntime(
      factoryScript({ changeId: ID, summary: "Math helpers", repos: ["app"], tasks: SINGLE_TASKS }),
    );
    await cliWith(runtime, fx.root, "run", "Add math helpers");
    expect((await cliWith(runtime, fx.root, "approve", ID)).code).toBe(ExitCode.Ok);
    await configure(fx.root, (t) => t.replace('"lint":"true"', '"lint":"exit 7"'));
    const gate = await cli(fx.root, "gate", ID, "--repo", "app");
    expect(gate.out).not.toContain("exit 7");
    expect(gate.code).toBe(ExitCode.Ok);
  });

  test("close resumes after a crash, after or before the archive commit (audit P6)", async () => {
    await withGates(passAll);
    const runtime = new ScriptedRuntime(
      factoryScript({ changeId: ID, summary: "Math helpers", repos: ["app"], tasks: SINGLE_TASKS }),
    );
    await cliWith(runtime, fx.root, "run", "Add math helpers");
    expect((await cliWith(runtime, fx.root, "approve", ID)).code).toBe(ExitCode.Ok);
    const archive = await gitOut(fx.root, "rev-parse", `change/${ID}`);

    // Crash after the archive commit, before the run was marked done.
    await updateRun(fx.root, ID, (d) => {
      d.phase = "closing";
    });
    const again = await cliWith(runtime, fx.root, "resume", ID);
    expect(again.err).toBe("");
    expect(again.code).toBe(ExitCode.Ok);
    expect(loadRun(fx.root, ID)?.phase).toBe("done");
    expect(await gitOut(fx.root, "rev-parse", `change/${ID}`)).toBe(archive);

    // Crash between `openspec archive` and its commit.
    await updateRun(fx.root, ID, (d) => {
      d.phase = "closing";
      delete d.archivedAs;
      delete d.archiveCommit;
    });
    await fixtureGit(fx.root, "reset", "-q", "--soft", "HEAD~1");
    const resumed = await cliWith(runtime, fx.root, "resume", ID);
    expect(resumed.code).toBe(ExitCode.Ok);
    expect(await gitOut(fx.root, "log", "-1", "--format=%s", `change/${ID}`)).toBe(
      `chore(spec): archive ${ID}`,
    );
    expect(await gitOut(fx.root, "status", "--porcelain")).toBe("");
    expect(readFileSync(join(fx.root, ".factory/reports", `${ID}.md`), "utf8")).toContain(
      "Archived as",
    );
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
