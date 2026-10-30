import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ExitCode } from "../src/cli/exit-codes.ts";
import { loadRun } from "../src/state/run.ts";
import { ScriptedRuntime } from "./fixtures/scripted-runtime.ts";
import {
  createSingleRepoFixture,
  type Fixture,
  fixtureGit,
  writeFiles,
} from "./fixtures/workspaces.ts";
import { cli, cliWith, gitOut } from "./helpers.ts";

const ID = "existing-change";
const TASKS = `## 1. app

- [ ] 1.1 Add the endpoint
  - repo: app
  - deps: none
  - touches: src/**
`;

const CHECKED_TASKS = `## 1. app

- [x] 1.1 Add the endpoint
  - repo: app
  - deps: none
  - touches: src/**
- [ ] 1.2 Add the test
  - repo: app
  - deps: 1.1
  - touches: src/**
`;

const BARE_TASKS = `## 1. app

- [ ] 1.1 Add the endpoint
- [ ] 1.2 Add the test
`;

function changeFiles(tasks = TASKS): Record<string, string> {
  return {
    [`openspec/changes/${ID}/.openspec.yaml`]: "schema: spec-driven\n",
    [`openspec/changes/${ID}/proposal.md`]:
      "## Why\nExisting teams already use OpenSpec and want the factory to finish their changes.\n\n## What Changes\n- Add the endpoint\n",
    [`openspec/changes/${ID}/design.md`]:
      "## Context\nSmall change.\n\n## Decisions\n- Reuse the existing server.\n",
    [`openspec/changes/${ID}/specs/health/spec.md`]:
      "## ADDED Requirements\n\n### Requirement: Health endpoint\nThe service SHALL expose GET /health.\n\n#### Scenario: Healthy\n- **WHEN** a client calls GET /health\n- **THEN** the response is 200\n",
    [`openspec/changes/${ID}/tasks.md`]: tasks,
  };
}

async function commit(root: string, message: string): Promise<void> {
  await fixtureGit(root, "add", "-A");
  await fixtureGit(root, "commit", "-q", "-m", message);
}

async function setup(): Promise<Fixture> {
  const fx = await createSingleRepoFixture();
  expect((await cli(fx.root, "init", "--no-graph")).code).toBe(ExitCode.Ok);
  await fixtureGit(fx.root, "config", "user.email", "fixture@example.com");
  await fixtureGit(fx.root, "config", "user.name", "Fixture");
  return fx;
}

describe("adopt: existing OpenSpec changes", () => {
  let fx: Fixture;
  beforeEach(async () => {
    fx = await setup();
  });
  afterEach(() => fx.cleanup());

  test("lists pending changes and a dry run writes no state", async () => {
    writeFiles(fx.root, changeFiles());
    const list = await cli(fx.root, "adopt");
    expect(list.code).toBe(ExitCode.Ok);
    expect(list.out).toContain(ID);
    expect(list.out).toContain("not adopted");
    expect(existsSync(join(fx.root, ".factory", "runs", `${ID}.json`))).toBe(false);

    const dry = await cli(fx.root, "adopt", ID, "--dry-run");
    expect(dry.code).toBe(ExitCode.Ok);
    expect(dry.out).toContain("would adopt");
    expect(existsSync(join(fx.root, ".factory", "runs", `${ID}.json`))).toBe(false);
  });

  test("adopts a valid change and approve creates the branch lazily", async () => {
    writeFiles(fx.root, changeFiles());
    await commit(fx.root, "docs(spec): add existing change");

    const adopt = await cli(fx.root, "adopt", ID);
    expect(adopt.code).toBe(ExitCode.Ok);
    expect(adopt.out).toContain("awaiting-approval");

    const run = loadRun(fx.root, ID);
    expect(run?.origin).toBe("openspec");
    expect(run?.adoptedAt).toBeString();
    expect(run?.preserveProgress).toBe(false);
    expect(run?.branches["."]).toBeUndefined();
    expect(await gitOut(fx.root, "branch", "--show-current")).toBe("main");

    const approve = await cli(fx.root, "approve", ID, "--no-continue");
    expect(approve.code).toBe(ExitCode.Ok);
    expect(await gitOut(fx.root, "branch", "--show-current")).toBe(`change/${ID}`);
    const after = loadRun(fx.root, ID);
    expect(after?.phase).toBe("queued");
    expect(after?.tasks.map((task) => task.status)).toEqual(["pending"]);
    expect(after?.branches["."]?.branch).toBe(`change/${ID}`);
  });

  test("is idempotent", async () => {
    writeFiles(fx.root, changeFiles());
    await commit(fx.root, "docs(spec): add existing change");
    expect((await cli(fx.root, "adopt", ID)).code).toBe(ExitCode.Ok);
    const again = await cli(fx.root, "adopt", ID);
    expect(again.code).toBe(ExitCode.Ok);
    expect(again.out).toContain("already adopted");
  });

  test("--json reports the result", async () => {
    writeFiles(fx.root, changeFiles());
    await commit(fx.root, "docs(spec): add existing change");
    const run = await cli(fx.root, "adopt", "--all", "--json");
    expect(run.code).toBe(ExitCode.Ok);
    const parsed = JSON.parse(run.out) as {
      results: { id: string; action: string; phase: string }[];
    };
    expect(parsed.results).toEqual([
      expect.objectContaining({ id: ID, action: "adopted", phase: "awaiting-approval" }),
    ]);
    expect(existsSync(join(fx.root, ".factory", "runs", `${ID}.json`))).toBe(true);
  });

  test("partial progress needs --preserve-progress and keeps checked tasks merged", async () => {
    writeFiles(fx.root, changeFiles(CHECKED_TASKS));
    await commit(fx.root, "docs(spec): add existing change");

    const refused = await cli(fx.root, "adopt", ID);
    expect(refused.code).toBe(ExitCode.Precondition);
    expect(refused.out).toContain("--preserve-progress");
    expect(existsSync(join(fx.root, ".factory", "runs", `${ID}.json`))).toBe(false);

    const adopt = await cli(fx.root, "adopt", ID, "--preserve-progress");
    expect(adopt.code).toBe(ExitCode.Ok);
    expect(loadRun(fx.root, ID)?.preserveProgress).toBe(true);

    const approve = await cli(fx.root, "approve", ID, "--no-continue");
    expect(approve.code).toBe(ExitCode.Ok);
    const after = loadRun(fx.root, ID);
    expect(after?.tasks.map((task) => [task.id, task.status])).toEqual([
      ["1.1", "merged"],
      ["1.2", "pending"],
    ]);
    expect(after?.tasks[0]?.history.some((entry) => entry.event.includes("adopted"))).toBe(true);
  });

  test("a fully checked change is left for openspec archive", async () => {
    writeFiles(fx.root, changeFiles(CHECKED_TASKS.replace("- [ ] 1.2", "- [x] 1.2")));
    await commit(fx.root, "docs(spec): add existing change");
    const run = await cli(fx.root, "adopt", "--all");
    expect(run.code).toBe(ExitCode.Ok);
    expect(run.out).toContain("archive");
    expect(existsSync(join(fx.root, ".factory", "runs", `${ID}.json`))).toBe(false);
  });

  test("an invalid change is registered paused", async () => {
    writeFiles(fx.root, changeFiles(BARE_TASKS));
    await commit(fx.root, "docs(spec): add existing change");
    const run = await cli(fx.root, "adopt", ID);
    expect(run.code).toBe(ExitCode.Paused);
    expect(run.out).toContain("missing `repo:` line");
    const state = loadRun(fx.root, ID);
    expect(state?.phase).toBe("paused");
    expect(state?.pausedReason).toContain("missing `repo:` line");
  });

  test("--normalize lets the architect add the factory metadata", async () => {
    writeFiles(fx.root, changeFiles(BARE_TASKS));
    await commit(fx.root, "docs(spec): add existing change");

    const runtime = new ScriptedRuntime(async (call) => {
      if (call.agent === "explorer")
        return { handoff: { task: "explore", decisions: ["entry point: src/sum.ts"] } };
      if (
        call.agent === "architect" &&
        call.prompt.startsWith("Adopt the existing OpenSpec change")
      )
        return {
          edits: { [`openspec/changes/${ID}/tasks.md`]: TASKS },
          handoff: { task: "adopt" },
        };
      return { handoff: {} };
    });

    const run = await cliWith(runtime, fx.root, "adopt", ID, "--normalize");
    expect(run.code).toBe(ExitCode.Ok);
    expect(run.out).toContain("normalized");
    const state = loadRun(fx.root, ID);
    expect(state?.phase).toBe("awaiting-approval");
    expect(state?.origin).toBe("openspec");
    expect(
      runtime.calls.some(
        (call) =>
          call.agent === "architect" &&
          call.prompt.startsWith("Adopt the existing OpenSpec change"),
      ),
    ).toBe(true);
    expect(readFileSync(join(fx.root, "openspec", "changes", ID, "tasks.md"), "utf8")).toContain(
      "repo: app",
    );
  });
});

describe("adopt: adoption hint", () => {
  test("init points at pending changes on a first install", async () => {
    const fx = await createSingleRepoFixture();
    try {
      writeFiles(fx.root, changeFiles());
      const run = await cli(fx.root, "init", "--no-graph");
      expect(run.code).toBe(ExitCode.Ok);
      expect(run.out).toContain("pending OpenSpec change");
      expect(run.out).toContain("ai-factory adopt --all");
    } finally {
      fx.cleanup();
    }
  });
});
