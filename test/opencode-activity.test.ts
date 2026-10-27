import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FactoryConfig } from "../src/config/schema.ts";
import { OpencodeRuntime } from "../src/runtime/opencode.ts";
import type { SessionActivity } from "../src/runtime/types.ts";

/** The runtime turns opencode's event stream into display progress for exactly its sessions. */
describe("OpencodeRuntime activity", () => {
  const stub = join(import.meta.dir, "fixtures/bin/opencode-serve-events-stub.ts");
  const saved = process.env.AI_FACTORY_OPENCODE_BIN;
  let root: string;
  let runtime: OpencodeRuntime;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "factory-opencode-events-"));
    mkdirSync(join(root, ".factory"), { recursive: true });
    process.env.AI_FACTORY_OPENCODE_BIN = stub;
    runtime = new OpencodeRuntime({
      root,
      config: FactoryConfig.parse({
        schemaVersion: 3,
        layout: "single",
        repos: [{ name: "app", path: ".", languages: ["typescript"] }],
        models: {
          orchestrator: "stub/model",
          architect: "stub/model",
          reviewer: "stub/model",
          implementer: "stub/model",
          tester: "stub/model",
          explorer: "stub/model",
        },
      }),
      changeId: "add-x",
      waitPollMs: 100,
      baseEnv: { PATH: process.env.PATH, HOME: join(root, "home") },
    });
  });

  afterAll(async () => {
    await runtime?.close();
    if (saved === undefined) delete process.env.AI_FACTORY_OPENCODE_BIN;
    else process.env.AI_FACTORY_OPENCODE_BIN = saved;
    rmSync(root, { recursive: true, force: true });
  });

  test("maps tool, step and usage events to the session's callback", async () => {
    const activities: SessionActivity[] = [];
    const session = await runtime.open({
      agent: "implementer-app",
      model: "stub/model",
      title: "activity",
      context: {
        changeId: "add-x",
        role: "implementer",
        directory: root,
        workspace: root,
        repo: "app",
        task: "1.1",
        touches: ["src/**"],
      },
      onActivity: (activity) => activities.push(activity),
    });
    const turn = await session.prompt("Task 1.1");
    expect(turn.outcome).toBe("succeeded");
    // The events are written while the turn runs; give the stream reader a moment.
    await Bun.sleep(200);
    expect(activities.map((a) => a.kind)).toEqual([
      "step-started",
      "tool",
      "step-done",
      "tool-done",
    ]);
    expect(activities[0]).toMatchObject({ kind: "step-started", model: "stub/claude-stub" });
    expect(activities[1]).toMatchObject({
      kind: "tool",
      tool: "bash",
      input: { command: "bun test" },
    });
    expect(activities[2]).toMatchObject({
      kind: "step-done",
      usage: { input: 10, output: 2, reasoning: 1, cacheRead: 5, cacheWrite: 1, cost: 0.01 },
    });
    expect(activities[3]).toMatchObject({ kind: "tool-done", tool: "bash", status: "ok" });
    // A foreign session and malformed/unknown events never reach this callback.
    expect(activities.some((a) => JSON.stringify(a).includes("rm -rf"))).toBe(false);
  }, 30_000);
});
