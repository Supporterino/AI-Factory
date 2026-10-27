import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ExitCode } from "../src/cli/exit-codes.ts";
import { loadConfig } from "../src/config/load.ts";
import { OpencodeRuntime } from "../src/runtime/opencode.ts";
import { type StubServer, startStubModel } from "./fixtures/stub-model.ts";
import { createSingleRepoFixture, type Fixture } from "./fixtures/workspaces.ts";
import { cli } from "./helpers.ts";

/**
 * Opt-in: drives the real opencode binary (supported 2.1.2–2.2.x) with a stub model. No real
 * model, isolated HOME/XDG. Run with AI_FACTORY_E2E=1 (and opencode installed).
 */
const REAL_OPENCODE = Bun.which("opencode") ?? join(homedir(), ".opencode/bin/opencode");
const enabled = process.env.AI_FACTORY_E2E === "1" && existsSync(REAL_OPENCODE);

describe.skipIf(!enabled)("OpencodeRuntime against real opencode", () => {
  let fx: Fixture;
  let stub: StubServer;
  let runtime: OpencodeRuntime;
  const saved = process.env.AI_FACTORY_OPENCODE_BIN;

  beforeAll(async () => {
    stub = startStubModel([
      { tool: "shell", input: { command: "sh -c 'git push origin main'" } },
      { tool: "shell", input: { command: "echo $AI_FACTORY_GRAPH" } },
      { tool: "shell", input: { command: "echo pw=[$OPENCODE_PASSWORD]" } },
      {
        tool: "shell",
        input: {
          command: `python3 -c "open('.factory/tamper.json','w').write('x')"; echo exit=$?`,
        },
      },
      {
        text: 'Done.\n```json\n{"status":"done","task":"1.1","filesChanged":[],"decisions":["probe"],"risks":[],"openQuestions":[]}\n```',
      },
    ]);
    fx = await createSingleRepoFixture();
    expect((await cli(fx.root, "init")).code).toBe(ExitCode.Ok);
    // Project-level provider for the stub (the managed .opencode config stays untouched).
    writeFileSync(
      join(fx.root, "opencode.jsonc"),
      JSON.stringify({
        providers: {
          stub: {
            package: "@opencode/ai/providers/anthropic-compatible",
            settings: { baseURL: stub.baseURL, apiKey: "x" },
            models: { "claude-stub": { limit: { context: 200000, output: 8000 } } },
          },
        },
      }),
    );
    const home = join(fx.base, "home");
    for (const d of ["config", "data", "state", "cache"])
      mkdirSync(join(home, d), { recursive: true });
    process.env.AI_FACTORY_OPENCODE_BIN = REAL_OPENCODE;
    const config = loadConfig(fx.root).config;
    runtime = new OpencodeRuntime({
      root: fx.root,
      config: { ...config, models: { ...config.models, implementer: "stub/claude-stub" } },
      changeId: "add-x",
      baseEnv: {
        PATH: process.env.PATH,
        HOME: home,
        XDG_CONFIG_HOME: join(home, "config"),
        XDG_DATA_HOME: join(home, "data"),
        XDG_STATE_HOME: join(home, "state"),
        XDG_CACHE_HOME: join(home, "cache"),
      },
    });
  }, 120_000);

  afterAll(async () => {
    await runtime?.close();
    stub?.stop();
    fx?.cleanup();
    process.env.AI_FACTORY_OPENCODE_BIN = saved;
  });

  test("opens a session with the role's model, the plugin blocks a push, the turn returns the handoff and usage", async () => {
    const session = await runtime.open({
      agent: "implementer-app",
      model: "stub/claude-stub",
      title: "e2e",
      context: {
        changeId: "add-x",
        role: "implementer",
        directory: fx.root,
        workspace: fx.root,
        repo: "app",
        task: "1.1",
        touches: ["src/**"],
      },
    });
    const turn = await session.prompt("Task 1.1: probe");
    expect(turn.outcome).toBe("succeeded");
    expect(turn.text).toContain('"decisions":["probe"]');
    expect(turn.usage.input).toBeGreaterThan(0);
    expect(turn.usage.cacheRead).toBeGreaterThan(0);

    const logDir = join(fx.root, ".factory/logs/add-x");
    const log = readdirSync(logDir)
      .map((f) => readFileSync(join(logDir, f), "utf8"))
      .join("");
    expect(log).toContain('"kind":"blocked"');
    expect(log).toContain("git push is not allowed");
    // The shell saw the factory env; the stub received the tool result.
    expect(JSON.stringify(stub.requests)).toContain("graphify-out/graph.json");
    // Shells lose the server password; on macOS they run sandboxed (no writes to .factory).
    expect(JSON.stringify(stub.requests)).toContain("pw=[]");
    if (process.platform === "darwin") {
      expect(existsSync(join(fx.root, ".factory/tamper.json"))).toBe(false);
      expect(JSON.stringify(stub.requests)).toContain("exit=1");
    }
    // The model came from the session create call, not the agent frontmatter default.
    expect(JSON.stringify(stub.requests.at(-1))).toContain("claude-stub");
  }, 120_000);
  test("a crashed server is restarted for the next session (audit P5)", async () => {
    const pid = runtime.serverPid;
    expect(pid).toBeDefined();
    process.kill(pid ?? 0, "SIGKILL");
    await Bun.sleep(500);
    expect(runtime.serverPid).toBeUndefined();
    const session = await runtime.open({
      agent: "implementer-app",
      model: "stub/claude-stub",
      title: "after crash",
      context: {
        changeId: "add-x",
        role: "implementer",
        directory: fx.root,
        workspace: fx.root,
        repo: "app",
        task: "1.1",
        touches: ["src/**"],
      },
    });
    expect((await session.prompt("Task 1.1: probe again")).outcome).toBe("succeeded");
    expect(runtime.serverPid).not.toBe(pid);
  }, 120_000);
});
