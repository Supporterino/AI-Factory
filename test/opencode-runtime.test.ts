import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FactoryConfig } from "../src/config/schema.ts";
import { OpencodeRuntime } from "../src/runtime/opencode.ts";

/**
 * A turn longer than the `/wait` poll bound must keep polling. Regression test for the
 * 2026-10-27 incident: one long `/wait` request hit Node's 300 s fetch timeout and the
 * run paused with "opencode server unreachable" even though the server was healthy.
 */
describe("OpencodeRuntime long-poll bounds", () => {
  const stub = join(import.meta.dir, "fixtures/bin/opencode-serve-stub.ts");
  const saved = process.env.AI_FACTORY_OPENCODE_BIN;
  let root: string;
  let runtime: OpencodeRuntime;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "factory-opencode-"));
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

  test("a turn outliving the poll bound succeeds and polls again", async () => {
    const session = await runtime.open({
      agent: "implementer-app",
      model: "stub/model",
      title: "slow turn",
      context: {
        changeId: "add-x",
        role: "implementer",
        directory: root,
        workspace: root,
        repo: "app",
        task: "1.1",
        touches: ["src/**"],
      },
    });
    const turn = await session.prompt("Task 1.1");
    expect(turn.outcome).toBe("succeeded");
    expect(turn.text).toBe("done");
    const polls = readFileSync(join(root, ".factory", "wait.log"), "utf8")
      .split("\n")
      .filter(Boolean);
    expect(polls.length).toBeGreaterThanOrEqual(2);
  }, 30_000);
});
