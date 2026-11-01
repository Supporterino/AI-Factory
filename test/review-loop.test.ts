import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ExitCode } from "../src/cli/exit-codes.ts";
import type { Finding } from "../src/handoff/schema.ts";
import { loadRun } from "../src/state/run.ts";
import { factoryScript, type ScriptedTask } from "./fixtures/factory-script.ts";
import { ScriptedRuntime } from "./fixtures/scripted-runtime.ts";
import {
  createSingleRepoFixture,
  createSubmoduleFixture,
  type Fixture,
  fixtureGit,
} from "./fixtures/workspaces.ts";
import { cli, cliWith } from "./helpers.ts";

const ID = "add-loop";
const passAll = { format: "true", lint: "true", types: "true", test: "true", testAffected: "true" };

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

const finding: Finding = {
  severity: "must",
  file: "src/mul.ts",
  line: 1,
  what: "The helper has no zero case.",
  problem: "Multiplying by zero is not covered.",
  fix: "Add a zero case and a test.",
  impact: "A regression would go unnoticed.",
};

async function configure(
  root: string,
  options: { reviewRounds?: number; gates?: Record<string, unknown> },
): Promise<void> {
  const file = join(root, "factory.config.jsonc");
  const before = readFileSync(file, "utf8");
  let text = before;
  if (options.reviewRounds !== undefined)
    text = text.replace(/"reviewRounds": \d+/, `"reviewRounds": ${options.reviewRounds}`);
  if (options.gates !== undefined)
    text = text.replace('"overrides": {}', `"overrides": ${JSON.stringify(options.gates)}`);
  if (text === before) return;
  writeFileSync(file, text);
  await fixtureGit(root, "commit", "-q", "-am", "chore: configure the factory");
}

/** Counts reviewer/tester calls per repo and lets each round choose the findings. */
function looped(
  findingsFor: (repo: string, round: number) => Finding[],
  opts: { tasks?: ScriptedTask[]; repos?: string[] } = {},
) {
  const team = factoryScript({
    changeId: ID,
    summary: "Math helpers",
    repos: opts.repos ?? ["app"],
    tasks: opts.tasks ?? TASKS,
  });
  const reviews = new Map<string, number>();
  const tests = new Map<string, number>();
  const runtime = new ScriptedRuntime((call) => {
    if (call.agent === "reviewer") {
      const repo = call.spec.context.repo ?? "";
      const round = (reviews.get(repo) ?? 0) + 1;
      reviews.set(repo, round);
      return { handoff: { task: `review:${repo}`, findings: findingsFor(repo, round) } };
    }
    if (call.agent === "tester") {
      const repo = call.spec.context.repo ?? "";
      tests.set(repo, (tests.get(repo) ?? 0) + 1);
    }
    return team(call);
  });
  return { runtime, reviews, tests };
}

describe("review loop: single repo", () => {
  let fx: Fixture;
  beforeEach(async () => {
    fx = await createSingleRepoFixture();
    expect((await cli(fx.root, "init")).code).toBe(ExitCode.Ok);
    await configure(fx.root, { reviewRounds: 3, gates: { app: passAll } });
  });
  afterEach(() => fx.cleanup());

  test("re-reviews after a fix round and stops when the pass is clean", async () => {
    const { runtime, reviews, tests } = looped((_repo, round) => (round === 1 ? [finding] : []));
    expect((await cliWith(runtime, fx.root, "run", "Add math helpers")).code).toBe(ExitCode.Ok);
    const approve = await cliWith(runtime, fx.root, "approve", ID);
    expect(approve.code).toBe(ExitCode.Ok);
    expect(approve.out).toContain("review round 1/3");
    expect(approve.out).toContain("review round 2/3");

    const run = loadRun(fx.root, ID);
    expect(run?.phase).toBe("done");
    expect(run?.reviewRound).toBe(2);
    expect(run?.reReview).toEqual([]);
    expect(reviews.get("app")).toBe(2);
    expect(tests.get("app")).toBe(1);
    expect(run?.tasks.find((t) => t.id === "fix-app-1-1")?.status).toBe("merged");
    expect(run?.tasks.find((t) => t.id === "test-app")?.status).toBe("merged");
  });

  test("the cap stops the loop but still runs the last fix round", async () => {
    await configure(fx.root, { reviewRounds: 2 });
    const { runtime, reviews } = looped(() => [finding]);
    await cliWith(runtime, fx.root, "run", "Add math helpers");
    const approve = await cliWith(runtime, fx.root, "approve", ID);
    expect(approve.code).toBe(ExitCode.Ok);
    expect(approve.out).toContain("review round cap (2)");

    const run = loadRun(fx.root, ID);
    expect(run?.phase).toBe("done");
    expect(run?.reviewRound).toBe(2);
    expect(run?.reReview).toEqual([]);
    expect(reviews.get("app")).toBe(2);
    expect(run?.tasks.find((t) => t.id === "fix-app-1-1")?.status).toBe("merged");
    expect(run?.tasks.find((t) => t.id === "fix-app-2-1")?.status).toBe("merged");
  });

  test("reviewRounds: 1 keeps the single pass", async () => {
    await configure(fx.root, { reviewRounds: 1 });
    const { runtime, reviews, tests } = looped(() => [finding]);
    await cliWith(runtime, fx.root, "run", "Add math helpers");
    expect((await cliWith(runtime, fx.root, "approve", ID)).code).toBe(ExitCode.Ok);
    const run = loadRun(fx.root, ID);
    expect(run?.phase).toBe("done");
    expect(run?.reviewRound).toBe(1);
    expect(reviews.get("app")).toBe(1);
    expect(tests.get("app")).toBe(1);
    expect(run?.tasks.some((t) => t.kind === "review-fix")).toBe(true);
  });
});

describe("review loop: every touched repo", () => {
  let fx: Fixture;
  const tasks: ScriptedTask[] = [
    {
      id: "1.1",
      title: "Add a backend helper",
      repo: "backend",
      deps: [],
      touches: ["cmd/helper.go"],
      file: "cmd/helper.go",
      content: "package main\n",
    },
    {
      id: "2.1",
      title: "Add a frontend helper",
      repo: "frontend",
      deps: [],
      touches: ["src/helper.ts"],
      file: "src/helper.ts",
      content: "export const helper = 1;\n",
    },
  ];

  beforeEach(async () => {
    fx = await createSubmoduleFixture();
    expect((await cli(fx.root, "init")).code).toBe(ExitCode.Ok);
    await configure(fx.root, {
      reviewRounds: 2,
      gates: { backend: passAll, frontend: passAll },
    });
  });
  afterEach(() => fx.cleanup());

  test("a finding in one repo re-reviews both, and testers still run once", async () => {
    const { runtime, reviews, tests } = looped(
      (repo, round) => (repo === "backend" && round === 1 ? [finding] : []),
      { tasks, repos: ["backend", "frontend"] },
    );
    await cliWith(runtime, fx.root, "run", "Add helpers");
    const approve = await cliWith(runtime, fx.root, "approve", ID);
    expect(approve.code).toBe(ExitCode.Ok);

    const run = loadRun(fx.root, ID);
    expect(run?.phase).toBe("done");
    expect(run?.reviewRound).toBe(2);
    expect(run?.reReview).toEqual([]);
    expect(reviews.get("backend")).toBe(2);
    expect(reviews.get("frontend")).toBe(2);
    expect(tests.get("backend")).toBe(1);
    expect(tests.get("frontend")).toBe(1);
    expect(run?.tasks.some((t) => t.id === "fix-backend-1-1")).toBe(true);
  });
});
