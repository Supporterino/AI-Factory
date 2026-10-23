import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "../src/exec.ts";
import { agentGitEnv, CHAINED_HOOK, installPrePush, PRE_PUSH_HOOK } from "../src/git/hooks.ts";
import { createSubmoduleFixture, type Fixture, fixtureGit } from "./fixtures/workspaces.ts";
import { gitOut } from "./helpers.ts";

describe("pre-push hook and agent push block", () => {
  let fx: Fixture;
  let backend: string;
  beforeEach(async () => {
    fx = await createSubmoduleFixture();
    backend = join(fx.root, "repos/backend");
    await fixtureGit(backend, "switch", "-q", "-c", "change/x");
    writeFileSync(join(backend, "x.txt"), "x\n");
    await fixtureGit(backend, "add", "x.txt");
    await fixtureGit(backend, "commit", "-q", "-m", "feat: x");
  });
  afterEach(() => fx.cleanup());

  const push = (env: Record<string, string>, ...extra: string[]) =>
    git(["push", ...extra, "origin", "change/x"], { cwd: backend, env });

  test("blocks pushes from agents and lets humans push", async () => {
    expect((await installPrePush(backend)).status).toBe("installed");
    const agent = await push({ AI_FACTORY_AGENT: "1" });
    expect(agent.code).not.toBe(0);
    expect(agent.stderr).toContain("ai-factory: pushes are blocked for agents");
    expect((await push({})).code).toBe(0);
  });

  test("the agent git env blocks pushes even with --no-verify; fetch still works", async () => {
    const env = agentGitEnv({});
    const res = await push(env, "--no-verify");
    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain("ai-factory-push-blocked");
    expect((await git(["fetch", "-q", "origin"], { cwd: backend, env })).code).toBe(0);
  });

  test("agentGitEnv appends to existing GIT_CONFIG_* entries", () => {
    expect(agentGitEnv({ GIT_CONFIG_COUNT: "2" })).toMatchObject({
      GIT_CONFIG_COUNT: "3",
      GIT_CONFIG_KEY_2: "url.ai-factory-push-blocked://.pushInsteadOf",
    });
  });

  test("an existing pre-push hook is chained and still runs", async () => {
    const hooks = await gitOut(
      backend,
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "hooks",
    );
    const original = "#!/bin/sh\necho original-hook-ran >&2\nexit 0\n";
    writeFileSync(join(hooks, "pre-push"), original);
    chmodSync(join(hooks, "pre-push"), 0o755);

    expect((await installPrePush(backend)).status).toBe("chained");
    expect(readFileSync(join(hooks, CHAINED_HOOK), "utf8")).toBe(original);
    expect(readFileSync(join(hooks, "pre-push"), "utf8")).toBe(PRE_PUSH_HOOK);
    expect((await push({})).stderr).toContain("original-hook-ran");
    expect((await installPrePush(backend)).status).toBe("unchanged");
  });

  test("a hooksPath inside the working tree (husky) is skipped, not dirtied", async () => {
    await fixtureGit(backend, "config", "core.hooksPath", ".husky");
    const res = await installPrePush(backend);
    expect(res.status).toBe("skipped");
    expect(await gitOut(backend, "status", "--porcelain")).toBe("");
  });
});
