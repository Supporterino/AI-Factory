import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isChangeSpecPath, isSpecPath } from "../src/approval/approval.ts";
import { ExitCode } from "../src/cli/exit-codes.ts";
import type { Finding } from "../src/handoff/schema.ts";
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

const TASKS: ScriptedTask[] = [
  {
    id: "1.1",
    title: "Add a multiply helper",
    repo: "app",
    deps: [],
    touches: ["src/mul.ts"],
    file: "src/mul.ts",
    content: "export const mul = (a: number, b: number) => a * b;\n",
  },
];

const passAll = { format: "true", lint: "true", types: "true", test: "true", testAffected: "true" };
const SPEC = `openspec/changes/${ID}/specs/health/spec.md`;
const TASKS_MD = `openspec/changes/${ID}/tasks.md`;

const specFinding: Finding = {
  severity: "must",
  file: SPEC,
  line: 5,
  what: "The requirement says the body carries `status`.",
  problem: "The handler returns a bare 200 and the spec does not say what the body is.",
  fix: "State the response body explicitly.",
  impact: "Tests cannot agree on the response shape.",
};

async function configureGates(root: string): Promise<void> {
  const file = join(root, "factory.config.jsonc");
  const text = readFileSync(file, "utf8").replace(
    '"overrides": {}',
    `"overrides": ${JSON.stringify({ app: passAll })}`,
  );
  writeFileSync(file, text);
  await fixtureGit(root, "commit", "-q", "-am", "chore: configure the factory");
}

describe("approval path helpers", () => {
  test("recognise the change's spec in relative, dotted, absolute and Windows paths", () => {
    expect(isChangeSpecPath(ID, `openspec/changes/${ID}/proposal.md`)).toBe(true);
    expect(isChangeSpecPath(ID, `./openspec/changes/${ID}/specs/x/spec.md`)).toBe(true);
    expect(isChangeSpecPath(ID, `/tmp/ws/openspec/changes/${ID}/design.md`)).toBe(true);
    expect(isChangeSpecPath(ID, `openspec\\changes\\${ID}\\tasks.md`)).toBe(true);
    expect(isChangeSpecPath(ID, `openspec/changes/other/spec.md`)).toBe(false);
    expect(isChangeSpecPath(ID, `src/openspec/changes/${ID}/x.md`)).toBe(false);
    expect(isSpecPath(`openspec/specs/health/spec.md`)).toBe(true);
    expect(isSpecPath(`src/health.ts`)).toBe(false);
    expect(isSpecPath(undefined)).toBe(false);
  });
});

describe("spec findings, reword and reapprove", () => {
  let fx: Fixture;
  beforeEach(async () => {
    fx = await createSingleRepoFixture();
    expect((await cli(fx.root, "init")).code).toBe(ExitCode.Ok);
    await configureGates(fx.root);
  });
  afterEach(() => fx.cleanup());

  const approval = () =>
    JSON.parse(readFileSync(join(fx.root, `.factory/approvals/${ID}.json`), "utf8")) as {
      hash: string;
      specCommit: string;
      history?: { hash: string; reason: string }[];
    };

  /** A team that reports one spec finding and (optionally) rewrites the spec. */
  const team = (reword?: (directory: string) => Record<string, string | null>) =>
    new ScriptedRuntime(
      factoryScript({
        changeId: ID,
        summary: "Math helpers",
        repos: ["app"],
        tasks: TASKS,
        findings: { app: [specFinding] },
        reword: (call) =>
          reword === undefined
            ? { handoff: { task: "reword" } }
            : {
                edits: reword(call.directory),
                handoff: { task: "reword" },
              },
      }),
    );

  /** A team with no review findings, for the reapprove paths. */
  const plainTeam = () =>
    new ScriptedRuntime(
      factoryScript({
        changeId: ID,
        summary: "Math helpers",
        repos: ["app"],
        tasks: TASKS,
      }),
    );

  const rewritten = (directory: string): Record<string, string> => ({
    [SPEC]: readFileSync(join(directory, SPEC), "utf8").replace(
      "returning 200 with status ok.",
      "returning 200 with a body that carries `status`.",
    ),
  });

  test("a spec finding pauses instead of creating an implementer task, and reword applies it", async () => {
    const runtime = team(rewritten);
    await cliWith(runtime, fx.root, "run", "Add math helpers");
    expect((await cliWith(runtime, fx.root, "approve", ID)).code).toBe(ExitCode.Paused);

    const paused = loadRun(fx.root, ID);
    expect(paused?.phase).toBe("paused");
    expect(paused?.specFindings).toHaveLength(1);
    expect(paused?.tasks.some((t) => t.kind === "review-fix")).toBe(false);
    expect(paused?.pausedReason).toContain(`ai-factory reword ${ID}`);

    const status = await cliWith(runtime, fx.root, "status", ID);
    expect(status.out).toContain("spec findings (1)");
    expect(status.out).toContain(`ai-factory reword ${ID}`);

    // Resuming without resolving the findings stays paused (repos are already reviewed).
    const blocked = await cliWith(runtime, fx.root, "resume", ID);
    expect(blocked.code).toBe(ExitCode.Paused);
    expect(loadRun(fx.root, ID)?.phase).toBe("paused");

    const before = approval();
    const reword = await cliWith(runtime, fx.root, "reword", ID);
    expect(reword.err).toBe("");
    expect(reword.code).toBe(ExitCode.Ok);
    expect(reword.out).toContain(`reworded ${ID}`);

    const after = approval();
    expect(after.hash).not.toBe(before.hash);
    expect(after.history?.[0]?.hash).toBe(before.hash);
    expect(loadRun(fx.root, ID)?.specFindings).toHaveLength(0);
    expect(await gitOut(fx.root, "log", "-1", "--format=%s")).toBe(`docs(spec): reword ${ID}`);
    expect(readFileSync(join(fx.root, SPEC), "utf8")).toContain("carries `status`");

    const done = await cliWith(runtime, fx.root, "resume", ID);
    expect(done.code).toBe(ExitCode.Ok);
    expect(loadRun(fx.root, ID)?.phase).toBe("done");
  });

  test("reword refuses a task-DAG change and restores the spec", async () => {
    const runtime = team((directory) => ({
      ...rewritten(directory),
      [TASKS_MD]: `${readFileSync(join(directory, TASKS_MD), "utf8")}\n- [ ] 9.9 Sneak in a task\n  - repo: app\n  - deps: none\n  - touches: src/sneak.ts\n`,
    }));
    await cliWith(runtime, fx.root, "run", "Add math helpers");
    expect((await cliWith(runtime, fx.root, "approve", ID)).code).toBe(ExitCode.Paused);

    const before = approval();
    const beforeTasks = readFileSync(join(fx.root, TASKS_MD), "utf8");
    const reword = await cliWith(runtime, fx.root, "reword", ID);
    expect(reword.code).toBe(ExitCode.Precondition);
    expect(reword.err).toContain("task DAG");
    expect(readFileSync(join(fx.root, TASKS_MD), "utf8")).toBe(beforeTasks);
    expect(approval().hash).toBe(before.hash);
    expect(loadRun(fx.root, ID)?.specFindings).toHaveLength(1);
  });

  test("a blocked reword restores the spec and keeps the findings", async () => {
    const runtime = new ScriptedRuntime(
      factoryScript({
        changeId: ID,
        summary: "Math helpers",
        repos: ["app"],
        tasks: TASKS,
        findings: { app: [specFinding] },
        reword: () => ({
          edits: { [SPEC]: "not a spec\n" },
          handoff: { status: "blocked", openQuestions: ["the requirement is ambiguous"] },
        }),
      }),
    );
    await cliWith(runtime, fx.root, "run", "Add math helpers");
    expect((await cliWith(runtime, fx.root, "approve", ID)).code).toBe(ExitCode.Paused);
    const before = readFileSync(join(fx.root, SPEC), "utf8");
    const hash = approval().hash;

    const reword = await cliWith(runtime, fx.root, "reword", ID);
    expect(reword.code).toBe(ExitCode.Precondition);
    expect(reword.err).toContain("could not reword");
    expect(readFileSync(join(fx.root, SPEC), "utf8")).toBe(before);
    expect(approval().hash).toBe(hash);
    expect(loadRun(fx.root, ID)?.specFindings).toHaveLength(1);
  });

  test("a reword that changes nothing keeps the findings", async () => {
    const runtime = team();
    await cliWith(runtime, fx.root, "run", "Add math helpers");
    expect((await cliWith(runtime, fx.root, "approve", ID)).code).toBe(ExitCode.Paused);
    const reword = await cliWith(runtime, fx.root, "reword", ID);
    expect(reword.code).toBe(ExitCode.Ok);
    expect(reword.out).toContain("no spec changes");
    expect(loadRun(fx.root, ID)?.specFindings).toHaveLength(1);
  });

  test("--finding applies one finding and reapprove can accept the rest", async () => {
    const runtime = new ScriptedRuntime(
      factoryScript({
        changeId: ID,
        summary: "Math helpers",
        repos: ["app"],
        tasks: TASKS,
        findings: {
          app: [specFinding, { ...specFinding, problem: "A second spec issue." }],
        },
        reword: (call) => ({ edits: rewritten(call.directory), handoff: { task: "reword" } }),
      }),
    );
    await cliWith(runtime, fx.root, "run", "Add math helpers");
    expect((await cliWith(runtime, fx.root, "approve", ID)).code).toBe(ExitCode.Paused);

    const reword = await cliWith(runtime, fx.root, "reword", ID, "--finding", "1");
    expect(reword.err).toBe("");
    expect(reword.code).toBe(ExitCode.Ok);
    expect(loadRun(fx.root, ID)?.specFindings).toHaveLength(1);
    expect((await cliWith(runtime, fx.root, "resume", ID)).code).toBe(ExitCode.Paused);

    const re = await cliWith(runtime, fx.root, "reapprove", ID);
    expect(re.code).toBe(ExitCode.Ok);
    expect(re.out).toContain("cleared 1 spec finding");
    expect(loadRun(fx.root, ID)?.specFindings).toHaveLength(0);
    expect((await cliWith(runtime, fx.root, "resume", ID)).code).toBe(ExitCode.Ok);
    expect(loadRun(fx.root, ID)?.phase).toBe("done");
  });

  test("a nice spec finding is report-only: no task, no pause", async () => {
    const runtime = new ScriptedRuntime(
      factoryScript({
        changeId: ID,
        summary: "Math helpers",
        repos: ["app"],
        tasks: TASKS,
        findings: { app: [{ ...specFinding, severity: "nice" }] },
      }),
    );
    await cliWith(runtime, fx.root, "run", "Add math helpers");
    expect((await cliWith(runtime, fx.root, "approve", ID)).code).toBe(ExitCode.Ok);
    const done = loadRun(fx.root, ID);
    expect(done?.phase).toBe("done");
    expect(done?.specFindings).toHaveLength(0);
    expect(done?.tasks.some((t) => t.kind === "review-fix")).toBe(false);
  });

  test("reapprove accepts a hand edit and keeps task progress", async () => {
    const runtime = plainTeam();
    await cliWith(runtime, fx.root, "run", "Add math helpers");
    expect((await cliWith(runtime, fx.root, "approve", ID, "--no-continue")).code).toBe(
      ExitCode.Ok,
    );
    const proposal = join(fx.root, `openspec/changes/${ID}/proposal.md`);
    writeFileSync(proposal, `${readFileSync(proposal, "utf8")}\n- Also mention the dashboard.\n`);
    await fixtureGit(fx.root, "commit", "-q", "-am", "docs: manual spec edit");
    expect((await cliWith(runtime, fx.root, "resume", ID)).code).toBe(ExitCode.Precondition);

    const before = approval();
    const re = await cliWith(runtime, fx.root, "reapprove", ID);
    expect(re.err).toBe("");
    expect(re.code).toBe(ExitCode.Ok);
    expect(re.out).toContain(`re-approved ${ID}`);
    const after = approval();
    expect(after.hash).not.toBe(before.hash);
    expect(after.history?.[0]?.hash).toBe(before.hash);

    const done = await cliWith(runtime, fx.root, "resume", ID);
    expect(done.code).toBe(ExitCode.Ok);
    expect(loadRun(fx.root, ID)?.phase).toBe("done");
  });

  test("reapprove refuses a task-plan change", async () => {
    const runtime = plainTeam();
    await cliWith(runtime, fx.root, "run", "Add math helpers");
    expect((await cliWith(runtime, fx.root, "approve", ID, "--no-continue")).code).toBe(
      ExitCode.Ok,
    );
    const tasksFile = join(fx.root, TASKS_MD);
    writeFileSync(
      tasksFile,
      `${readFileSync(tasksFile, "utf8")}\n- [ ] 1.9 Sneak in a task\n  - repo: app\n  - deps: none\n  - touches: src/sneak.ts\n`,
    );
    await fixtureGit(fx.root, "commit", "-q", "-am", "docs: add a task after approval");
    const re = await cliWith(runtime, fx.root, "reapprove", ID);
    expect(re.code).toBe(ExitCode.Precondition);
    expect(re.err).toContain("cannot change the task plan");
  });

  test("reapprove refuses a change that was never approved or is already closed", async () => {
    const runtime = plainTeam();
    await cliWith(runtime, fx.root, "run", "Add math helpers");
    const early = await cliWith(runtime, fx.root, "reapprove", ID);
    expect(early.code).toBe(ExitCode.Precondition);
    expect(early.err).toContain("not approved yet");

    expect((await cliWith(runtime, fx.root, "approve", ID)).code).toBe(ExitCode.Ok);
    const closed = await cliWith(runtime, fx.root, "reapprove", ID);
    expect(closed.code).toBe(ExitCode.Precondition);
    expect(closed.err).toContain("is closed");
  });
});

describe("contract-review spec findings", () => {
  let fx: Fixture;
  beforeEach(async () => {
    fx = await createSubmoduleFixture();
    expect((await cli(fx.root, "init")).code).toBe(ExitCode.Ok);
    const file = join(fx.root, "factory.config.jsonc");
    const text = readFileSync(file, "utf8").replace(
      '"overrides": {}',
      `"overrides": ${JSON.stringify({ backend: passAll })}`,
    );
    writeFileSync(file, text);
    await fixtureGit(fx.root, "commit", "-q", "-am", "chore: configure the factory");
  });
  afterEach(() => fx.cleanup());

  test("a contract finding about the spec pauses without a contract-fix task", async () => {
    const runtime = new ScriptedRuntime(
      factoryScript({
        changeId: ID,
        summary: "Bump the API version",
        repos: ["backend"],
        tasks: [
          {
            id: "1.1",
            title: "Bump the OpenAPI version",
            repo: "backend",
            deps: [],
            touches: ["api/openapi.yaml"],
            file: "api/openapi.yaml",
            content: (BACKEND_FILES["api/openapi.yaml"] ?? "").replace(
              "version: 1.0.0",
              "version: 1.1.0",
            ),
          },
        ],
        contractFindings: [
          {
            ...specFinding,
            file: `openspec/changes/${ID}/proposal.md`,
          },
        ],
      }),
    );
    await cliWith(runtime, fx.root, "run", "Bump the API version");
    expect((await cliWith(runtime, fx.root, "approve", ID)).code).toBe(ExitCode.Paused);

    const paused = loadRun(fx.root, ID);
    expect(paused?.phase).toBe("paused");
    expect(paused?.specFindings).toHaveLength(1);
    expect(paused?.tasks.some((t) => t.kind === "contract-fix")).toBe(false);
    expect(paused?.pausedReason).toContain(`ai-factory reword ${ID}`);
  });
});
