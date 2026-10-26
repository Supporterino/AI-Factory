import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ExitCode } from "../src/cli/exit-codes.ts";
import { parseConfigText } from "../src/config/load.ts";
import { PRE_PUSH_HOOK } from "../src/git/hooks.ts";
import { LOCK_FILE, readLock } from "../src/lock/lock.ts";
import { PROFILES, renderStandard } from "../src/profiles/index.ts";
import { FACTORY_VERSION } from "../src/version.ts";
import {
  bareRepo,
  createSingleRepoFixture,
  createSubmoduleFixture,
  type Fixture,
  fixtureGit,
} from "./fixtures/workspaces.ts";
import { cli, gitOut } from "./helpers.ts";

const read = (root: string, rel: string): string => readFileSync(join(root, rel), "utf8");

async function commitAll(root: string, message: string): Promise<void> {
  await fixtureGit(root, "add", "-A");
  await fixtureGit(root, "commit", "-q", "-m", message);
}

describe("init: AI repo with submodules", () => {
  let fx: Fixture;
  beforeEach(async () => {
    fx = await createSubmoduleFixture();
  });
  afterEach(() => fx.cleanup());

  test("installs, commits once, touches no submodule tree, installs hooks everywhere", async () => {
    const run = await cli(fx.root, "init");
    expect(run.err).toBe("");
    expect(run.code).toBe(ExitCode.Ok);

    expect(await gitOut(fx.root, "log", "-1", "--format=%s")).toBe(
      `chore(factory): init v${FACTORY_VERSION}`,
    );
    expect(await gitOut(fx.root, "status", "--porcelain")).toBe("");

    for (const rel of [
      "factory.config.jsonc",
      LOCK_FILE,
      ".opencode/opencode.jsonc",
      ".opencode/agents/orchestrator.md",
      ".opencode/agents/contract-reviewer.md",
      ".opencode/agents/implementer-backend.md",
      ".opencode/agents/implementer-frontend.md",
      ".opencode/agents/implementer-deploy.md",
      ".opencode/standards/go.md",
      ".opencode/schemas/handoff.schema.json",
      ".opencode/commands/opsx-propose.md", // from openspec init
      "openspec/config.yaml",
      ".graphifyignore",
    ]) {
      expect(existsSync(join(fx.root, rel))).toBe(true);
    }
    expect(existsSync(join(fx.root, ".opencode/agents/implementer-ai.md"))).toBe(false);

    const cfg = parseConfigText(read(fx.root, "factory.config.jsonc"), "f");
    expect(cfg.layout).toBe("submodules");
    expect(cfg.contracts.map((c) => c.kind)).toEqual(["helm-values", "openapi"]);

    // Implementers stack their repo's profiles.
    const frontend = read(fx.root, ".opencode/agents/implementer-frontend.md");
    expect(frontend).toContain("# TypeScript / JavaScript standard");
    expect(frontend).toContain("# React standard");
    expect(frontend).not.toContain("# Go standard");

    expect(read(fx.root, ".gitignore")).toContain(".factory/\ngraphify-out/");
    expect(read(fx.root, "openspec/config.yaml")).toContain(
      "- frontend (repos/frontend): typescript, react",
    );

    for (const repo of [".", "repos/backend", "repos/frontend", "repos/deploy"]) {
      const hooks = await gitOut(
        join(fx.root, repo),
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        "hooks",
      );
      expect(read(hooks, "pre-push")).toBe(PRE_PUSH_HOOK);
      if (repo !== ".") expect(await gitOut(join(fx.root, repo), "status", "--porcelain")).toBe("");
    }
  });

  test("an uninitialised submodule is reported, not fatal (audit T)", async () => {
    await fixtureGit(fx.root, "submodule", "deinit", "-q", "-f", "repos/deploy");
    const run = await cli(fx.root, "init");
    expect(run.err).toBe("");
    expect(run.code).toBe(ExitCode.Ok);
    expect(run.out).toContain("note: submodule repos/deploy is not initialised");
    expect(run.out).toContain("hook deploy: skipped (not a checked-out git repository)");
    const config = parseConfigText(read(fx.root, "factory.config.jsonc"), "f");
    expect(config.repos.map((r) => r.name)).toContain("deploy");
  });

  test("--plan writes nothing; init archives a replaced custom agent setup", async () => {
    mkdirSync(join(fx.root, ".opencode", "agents"), { recursive: true });
    mkdirSync(join(fx.root, ".opencode", "skills", "mine"), { recursive: true });
    writeFileSync(join(fx.root, ".opencode", "agents", "mine.md"), "custom agent\n");
    writeFileSync(join(fx.root, ".opencode", "skills", "mine", "SKILL.md"), "custom skill\n");
    await commitAll(fx.root, "chore: custom setup");

    const plan = await cli(fx.root, "init", "--plan");
    expect(plan.code).toBe(ExitCode.Ok);
    expect(plan.out).toContain("would write factory.config.jsonc");
    expect(existsSync(join(fx.root, ".opencode/agents/mine.md"))).toBe(true);
    expect(existsSync(join(fx.root, LOCK_FILE))).toBe(false);

    const run = await cli(fx.root, "init");
    expect(run.code).toBe(ExitCode.Ok);
    expect(run.out).toContain("legacy setup archived");
    expect(existsSync(join(fx.root, ".opencode/agents/mine.md"))).toBe(false);
    expect(existsSync(join(fx.root, ".opencode/agents/orchestrator.md"))).toBe(true);
    expect(existsSync(join(fx.root, ".opencode/skills/mine/SKILL.md"))).toBe(false);
    const stamps = readdirSync(join(fx.root, ".factory", "legacy"));
    expect(stamps.length).toBe(1);
    expect(
      existsSync(join(fx.root, ".factory", "legacy", stamps[0] ?? "", ".opencode/agents/mine.md")),
    ).toBe(true);
  });

  test("is idempotent: a second run changes nothing", async () => {
    await cli(fx.root, "init");
    const head = await gitOut(fx.root, "rev-parse", "HEAD");
    const lock = read(fx.root, LOCK_FILE);

    const again = await cli(fx.root, "init");
    expect(again.code).toBe(ExitCode.Ok);
    expect(again.out).toContain("managed files: up to date");
    expect(again.out).toContain("nothing to commit");
    expect(await gitOut(fx.root, "rev-parse", "HEAD")).toBe(head);
    expect(await gitOut(fx.root, "status", "--porcelain")).toBe("");
    expect(read(fx.root, LOCK_FILE)).toBe(lock);
  });

  test("the lock records hashes and a retrievable blob for each managed file", async () => {
    await cli(fx.root, "init");
    const lock = readLock(fx.root);
    const entry = lock?.managed[".opencode/agents/reviewer.md"];
    expect(entry?.template).toBe("agents/reviewer");
    expect(await gitOut(fx.root, "cat-file", "-p", entry?.blob ?? "")).toBe(
      read(fx.root, ".opencode/agents/reviewer.md").trimEnd(),
    );
    expect(lock?.managed["AGENTS.md"]?.mode).toBe("block");
    expect(lock?.managed["factory.config.jsonc"]).toBeUndefined();
  });

  test("detect --apply adds an implementer, its scope and a hook for a new submodule", async () => {
    await cli(fx.root, "init");
    const remote = await bareRepo(fx.base, "worker", {
      "pyproject.toml": '[project]\nname = "worker"\n',
      "worker/main.py": "x = 1\n",
    });
    await fixtureGit(fx.root, "submodule", "add", "-q", remote, "repos/worker");
    await fixtureGit(fx.root, "commit", "-q", "-m", "chore: add worker");

    const apply = await cli(fx.root, "detect", "--apply");
    expect(apply.code).toBe(ExitCode.Ok);
    expect(apply.out).toContain("+ repo worker (repos/worker) languages [python]");
    expect(await gitOut(fx.root, "log", "-1", "--format=%s")).toBe(
      `chore(factory): apply detected changes (v${FACTORY_VERSION})`,
    );
    expect(read(fx.root, ".opencode/agents/implementer-worker.md")).toContain("# Python standard");
    expect(read(fx.root, "openspec/config.yaml")).toContain("- worker (repos/worker): python");
    expect(read(fx.root, "AGENTS.md")).toContain("| worker | `repos/worker` | code | python |");
    const hooks = await gitOut(
      join(fx.root, "repos/worker"),
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "hooks",
    );
    expect(read(hooks, "pre-push")).toBe(PRE_PUSH_HOOK);
    expect(await gitOut(fx.root, "status", "--porcelain")).toBe("");

    // Removing the repo again removes its (unedited) implementer.
    await fixtureGit(fx.root, "rm", "-q", "-f", "repos/worker");
    await fixtureGit(fx.root, "commit", "-q", "-m", "chore: drop worker");
    expect((await cli(fx.root, "detect", "--apply")).code).toBe(ExitCode.Ok);
    expect(existsSync(join(fx.root, ".opencode/agents/implementer-worker.md"))).toBe(false);
    expect((await cli(fx.root, "init")).out).toContain("nothing to commit");
  });
});

describe("init: single repo", () => {
  let fx: Fixture;
  beforeEach(async () => {
    fx = await createSingleRepoFixture();
  });
  afterEach(() => fx.cleanup());

  test("one implementer whose rules exclude factory files", async () => {
    expect((await cli(fx.root, "init")).code).toBe(ExitCode.Ok);
    const impl = read(fx.root, ".opencode/agents/implementer-app.md");
    for (const path of [
      "factory.config.jsonc",
      "factory.lock.json",
      ".opencode/*",
      "openspec/specs/*",
      "AGENTS.md",
    ]) {
      expect(impl).toContain(`{ action: edit, resource: ${path}, effect: deny }`);
    }
    expect(read(fx.root, ".opencode/agents/implementer-app.md")).toContain(
      "model: anthropic/claude-sonnet-5-5",
    );
  });

  test("keeps the user's AGENTS.md content around the managed block", async () => {
    writeFileSync(join(fx.root, "AGENTS.md"), "# House rules\n\nUse tabs.\n");
    await commitAll(fx.root, "docs: agents");
    await cli(fx.root, "init");
    const text = read(fx.root, "AGENTS.md");
    expect(text).toStartWith("# House rules\n\nUse tabs.\n\n<!-- ai-factory:start");
    expect((await cli(fx.root, "init")).out).toContain("nothing to commit");
  });

  test("a user edit is kept, a deletion is respected", async () => {
    await cli(fx.root, "init");
    const lockBefore = readLock(fx.root);
    writeFileSync(join(fx.root, ".opencode/agents/tester.md"), "my own tester\n");
    rmSync(join(fx.root, ".opencode/standards/rust.md"));
    await commitAll(fx.root, "chore: customise");

    const run = await cli(fx.root, "init");
    expect(run.out).toContain(
      "kept your edit (run `ai-factory update` to merge): .opencode/agents/tester.md",
    );
    expect(read(fx.root, ".opencode/agents/tester.md")).toBe("my own tester\n");
    expect(existsSync(join(fx.root, ".opencode/standards/rust.md"))).toBe(false);
    // The old entries stay as the merge base.
    const lockAfter = readLock(fx.root);
    expect(lockAfter?.managed[".opencode/agents/tester.md"]).toEqual(
      lockBefore?.managed[".opencode/agents/tester.md"],
    );
    expect(lockAfter?.managed[".opencode/standards/rust.md"]).toBeDefined();
  });

  test("OpenSpec's opencode files are managed: edits kept, deletions respected (audit P19)", async () => {
    await cli(fx.root, "init");
    const skill = ".opencode/skills/openspec-propose/SKILL.md";
    const command = ".opencode/commands/opsx-explore.md";
    expect(readLock(fx.root)?.managed[skill]?.template).toBe("openspec-tools");
    writeFileSync(
      join(fx.root, skill),
      `${read(fx.root, skill)}\nOur team writes specs in German.\n`,
    );
    rmSync(join(fx.root, command));
    await commitAll(fx.root, "chore: customise openspec skills");

    expect((await cli(fx.root, "init")).code).toBe(ExitCode.Ok);
    expect(read(fx.root, skill)).toContain("Our team writes specs in German.");
    expect(existsSync(join(fx.root, command))).toBe(false);

    expect((await cli(fx.root, "update", "--tools")).code).toBe(ExitCode.Ok);
    expect(read(fx.root, skill)).toContain("Our team writes specs in German.");
    expect(existsSync(join(fx.root, command))).toBe(false);
    // A plain update keeps them too (they are only regenerated with --tools).
    expect((await cli(fx.root, "update")).code).toBe(ExitCode.Ok);
    expect(read(fx.root, skill)).toContain("Our team writes specs in German.");
    expect(readLock(fx.root)?.managed[skill]).toBeDefined();
  });

  test("an older CLI refuses to downgrade a newer install unless told to", async () => {
    await cli(fx.root, "init");
    const lockFile = join(fx.root, LOCK_FILE);
    writeFileSync(
      lockFile,
      readFileSync(lockFile, "utf8").replace(
        /"factoryVersion": "[^"]+"/,
        '"factoryVersion": "9.9.9"',
      ),
    );
    await commitAll(fx.root, "chore: installed by a newer factory");
    const head = await gitOut(fx.root, "rev-parse", "HEAD");

    for (const argv of [["init"], ["update"], ["detect", "--apply"]]) {
      const res = await cli(fx.root, ...argv);
      expect(res.code).toBe(ExitCode.Precondition);
      expect(res.err).toContain("installed by ai-factory 9.9.9");
      expect(res.err).toContain("npx @supporterino/ai-factory@9.9.9");
    }
    expect(await gitOut(fx.root, "rev-parse", "HEAD")).toBe(head);

    expect((await cli(fx.root, "init", "--allow-downgrade")).code).toBe(ExitCode.Ok);
    expect(readLock(fx.root)?.factoryVersion).toBe(FACTORY_VERSION);
  });

  test("unmanaged files are left alone", async () => {
    await cli(fx.root, "init");
    const cfgPath = join(fx.root, "factory.config.jsonc");
    writeFileSync(
      cfgPath,
      read(fx.root, "factory.config.jsonc").replace(
        '"unmanaged": []',
        '"unmanaged": ["AGENTS.md"]',
      ),
    );
    writeFileSync(join(fx.root, "AGENTS.md"), "mine\n");
    await commitAll(fx.root, "chore: own AGENTS.md");
    await cli(fx.root, "init");
    expect(read(fx.root, "AGENTS.md")).toBe("mine\n");
    expect(readLock(fx.root)?.managed["AGENTS.md"]).toBeUndefined();
  });

  test("refuses to overwrite files it did not create, before writing anything", async () => {
    writeFileSync(join(fx.root, ".graphifyignore"), "custom\n");
    await commitAll(fx.root, "chore: graphifyignore");
    const run = await cli(fx.root, "init");
    expect(run.code).toBe(ExitCode.Precondition);
    expect(run.err).toContain(".graphifyignore");
    expect(existsSync(join(fx.root, "factory.config.jsonc"))).toBe(false);
    expect(existsSync(join(fx.root, ".opencode"))).toBe(false);

    const forced = await cli(fx.root, "init", "--force");
    expect(forced.code).toBe(ExitCode.Ok);
    expect(forced.out).toContain("overwritten (--force): .graphifyignore");
  });

  test("keeps a team's existing openspec/config.yaml and marks it unmanaged (audit G2)", async () => {
    const team = "schema: spec-driven\ncontext: |\n  Our team's OpenSpec context.\n";
    mkdirSync(join(fx.root, "openspec"), { recursive: true });
    writeFileSync(join(fx.root, "openspec/config.yaml"), team);
    await commitAll(fx.root, "chore: openspec config");
    const run = await cli(fx.root, "init");
    expect(run.err).toBe("");
    expect(run.code).toBe(ExitCode.Ok);
    expect(run.out).toContain("kept your openspec/config.yaml");
    expect(read(fx.root, "openspec/config.yaml")).toBe(team);
    const config = parseConfigText(read(fx.root, "factory.config.jsonc"), "f");
    expect(config.unmanaged).toContain("openspec/config.yaml");
    // A second run leaves it alone too.
    expect((await cli(fx.root, "init")).code).toBe(ExitCode.Ok);
    expect(read(fx.root, "openspec/config.yaml")).toBe(team);
  });

  test("detect --apply merges a language change into an edited implementer (audit G3)", async () => {
    expect((await cli(fx.root, "init", "--no-graph")).code).toBe(ExitCode.Ok);
    const agent = join(fx.root, ".opencode/agents/implementer-app.md");
    writeFileSync(
      agent,
      `${read(fx.root, ".opencode/agents/implementer-app.md")}\nTeam rule: keep functions small.\n`,
    );
    writeFileSync(join(fx.root, "go.mod"), "module example.com/app\n\ngo 1.22\n");
    writeFileSync(join(fx.root, "main.go"), "package main\n\nfunc main() {}\n");
    await commitAll(fx.root, "chore: team rule and a Go tool");
    const applied = await cli(fx.root, "detect", "--apply");
    expect(applied.code).toBe(ExitCode.Ok);
    const text = read(fx.root, ".opencode/agents/implementer-app.md");
    expect(text).toContain("Team rule: keep functions small.");
    expect(text).toContain(renderStandard(PROFILES.go, { comments: false }).slice(0, 200));
    expect(await gitOut(fx.root, "status", "--porcelain")).toBe("");
  });

  test("refuses when files it commits have uncommitted changes", async () => {
    writeFileSync(join(fx.root, ".gitignore"), "node_modules/\n");
    const run = await cli(fx.root, "init");
    expect(run.code).toBe(ExitCode.Precondition);
    expect(run.err).toContain(".gitignore");
    expect((await cli(fx.root, "init", "--no-commit")).code).toBe(ExitCode.Ok);
    expect(read(fx.root, ".gitignore")).toStartWith("node_modules/\n\n# ai-factory:start");
  });

  test("reports missing tools with the install command", async () => {
    const saved = process.env.AI_FACTORY_GRAPHIFY_BIN;
    process.env.AI_FACTORY_GRAPHIFY_BIN = "/nonexistent/graphify";
    try {
      const run = await cli(fx.root, "init");
      expect(run.code).toBe(ExitCode.Precondition);
      expect(run.err).toContain("graphify: not found → uv tool install graphifyy==0.9.93");
    } finally {
      process.env.AI_FACTORY_GRAPHIFY_BIN = saved;
    }
  });
});
