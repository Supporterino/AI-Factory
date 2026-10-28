import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ExitCode } from "../src/cli/exit-codes.ts";
import { parseJsonc } from "../src/config/jsonc.ts";
import { loadConfig } from "../src/config/load.ts";
import { DEFAULT_GRAPH_EXCLUDE } from "../src/config/schema.ts";
import { readLock } from "../src/lock/lock.ts";
import {
  graphExcludeDefaults,
  V1_GRAPH_EXCLUDE,
} from "../src/migrations/001-graph-exclude-defaults.ts";
import { artifactsV4 } from "../src/migrations/003-artifacts.ts";
import { migrateConfigText } from "../src/migrations/index.ts";
import { claimActive, releaseActive } from "../src/state/active.ts";
import { loadRun } from "../src/state/run.ts";
import { FACTORY_VERSION } from "../src/version.ts";
import { factoryScript, type ScriptedTask } from "./fixtures/factory-script.ts";
import { ScriptedRuntime } from "./fixtures/scripted-runtime.ts";
import { fixtureGit } from "./fixtures/workspaces.ts";
import { cli, cliWith, gitOut } from "./helpers.ts";

const SNAPSHOT = JSON.parse(
  readFileSync(join(import.meta.dir, "fixtures/install-0.1.0.json"), "utf8"),
) as {
  version: string;
  files: Record<string, string>;
};

describe("config migrations", () => {
  const v1 = `// my comment
{
  "schemaVersion": 1,
  "graph": { "exclude": ${JSON.stringify(V1_GRAPH_EXCLUDE)} }
}
`;

  test("001 replaces the old default excludes, keeps comments, bumps the version", () => {
    const out = graphExcludeDefaults.migrate(v1);
    expect(out).toContain("// my comment");
    expect(parseJsonc(out).value).toEqual({
      schemaVersion: 2,
      graph: { exclude: [...DEFAULT_GRAPH_EXCLUDE] },
    });
  });

  test("001 keeps a customised exclude list", () => {
    const custom = v1.replace('"graphify-out/**"', '"graphify-out/**", "legacy/**"');
    expect(
      (parseJsonc(graphExcludeDefaults.migrate(custom)).value as { graph: { exclude: string[] } })
        .graph.exclude,
    ).toContain("legacy/**");
  });

  test("003 adds the artifacts block and keeps records out of the graph", () => {
    const v3 = `{
  // keep this comment
  "schemaVersion": 3,
  "graph": { "exclude": ["**/node_modules/**"] }
}
`;
    const out = artifactsV4.migrate(v3);
    const value = parseJsonc(out).value as {
      schemaVersion: number;
      artifacts: Record<string, unknown>;
      graph: { exclude: string[] };
    };
    expect(value.schemaVersion).toBe(4);
    expect(value.artifacts).toEqual({
      mode: "local",
      reports: true,
      approvals: true,
      usage: true,
    });
    expect(value.graph.exclude).toEqual(["**/node_modules/**", "factory-records/**"]);
    expect(out).toContain("// keep this comment");

    const twice = artifactsV4.migrate(
      `{"schemaVersion": 3, "graph": { "exclude": ["factory-records/**"] }}`,
    );
    expect((parseJsonc(twice).value as { graph: { exclude: string[] } }).graph.exclude).toEqual([
      "factory-records/**",
    ]);
  });

  test("the runner applies pending migrations in order and refuses newer configs", () => {
    expect(migrateConfigText(v1)).toMatchObject({
      from: 1,
      to: 4,
      applied: ["001-graph-exclude-defaults", "002-config-v3", "003-artifacts"],
    });
    const current = migrateConfigText(migrateConfigText(v1).text);
    expect(current.applied).toEqual([]);
    expect(() => migrateConfigText('{ "schemaVersion": 99 }')).toThrow("newer than this factory");
  });
});

describe(`update from a ${SNAPSHOT.version} install`, () => {
  let base: string;
  let root: string;

  beforeEach(async () => {
    base = mkdtempSync(join(tmpdir(), "ai-factory-update-"));
    root = join(base, "app");
    for (const [rel, content] of Object.entries(SNAPSHOT.files)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), content);
    }
    await fixtureGit(root, "init", "-q", "-b", "main");
    await fixtureGit(root, "add", "-A");
    await fixtureGit(root, "commit", "-q", "-m", `chore(factory): init v${SNAPSHOT.version}`);
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  const read = (rel: string): string => readFileSync(join(root, rel), "utf8");
  const edit = (rel: string, f: (t: string) => string): void =>
    writeFileSync(join(root, rel), f(read(rel)));
  async function commit(message: string): Promise<void> {
    await fixtureGit(root, "add", "-A");
    await fixtureGit(root, "commit", "-q", "-m", message);
  }
  async function trackedContents(): Promise<Record<string, string>> {
    const files = (await gitOut(root, "ls-files")).split("\n");
    return Object.fromEntries(files.map((f) => [f, read(f)]));
  }

  test("the old config is refused until update migrates it", async () => {
    expect(() => loadConfig(root)).toThrow("uses config schemaVersion 1; this factory needs 4");
    const res = await cli(root, "detect");
    expect(res.err).toContain("run `ai-factory update` to migrate it");
  });

  test("keeps your edits, migrates the config, regenerates agents, one commit, rollback restores exactly", async () => {
    edit("factory.config.jsonc", (t) => `// team note: models agreed on 2026-10-01\n${t}`);
    edit(".opencode/agents/tester.md", (t) => `${t}\nAlways run \`bun test\` before you finish.\n`);
    edit(".opencode/agents/implementer-app.md", (t) =>
      t.replace(
        "# Role: implementer for repo `app`",
        "# Role: implementer for repo `app` (our team)",
      ),
    );
    edit("AGENTS.md", (t) => `${t}\n# House rules\nUse tabs.\n`);
    rmSync(join(root, ".opencode/standards/rust.md"));
    await commit("chore: customise the factory");
    const before = await trackedContents();
    const head = await gitOut(root, "rev-parse", "HEAD");

    const dry = await cli(root, "update", "--dry-run");
    expect(dry.code).toBe(ExitCode.Ok);
    expect(dry.out).toContain(`update ${SNAPSHOT.version} → ${FACTORY_VERSION}`);
    expect(dry.out).toContain("config migrations: 001-graph-exclude-defaults, 002-config-v3");
    expect(dry.out).toContain("merge with your edits: .opencode/agents/implementer-app.md");
    // JSON lists what changes, not every file's whole content (audit G9).
    const json = await cli(root, "update", "--dry-run", "--json");
    const plan = JSON.parse(json.out) as { changes: { path: string; action: string }[] };
    expect(plan.changes.some((c) => c.path === ".opencode/agents/implementer-app.md")).toBe(true);
    expect(json.out).not.toContain("# Role: implementer");
    expect(json.out.length).toBeLessThan(20_000);
    expect(await gitOut(root, "rev-parse", "HEAD")).toBe(head);
    expect(await gitOut(root, "status", "--porcelain")).toBe("");

    const run = await cli(root, "update");
    expect(run.err).toBe("");
    expect(run.code).toBe(ExitCode.Ok);
    expect(await gitOut(root, "log", "-1", "--format=%s")).toBe(
      `chore(factory): update to v${FACTORY_VERSION}`,
    );
    expect(await gitOut(root, "rev-parse", "HEAD~1")).toBe(head);
    expect(await gitOut(root, "status", "--porcelain")).toBe("");

    // User edits survive, new template text arrives, deletions are respected.
    expect(read(".opencode/agents/tester.md")).toContain(
      "Always run `bun test` before you finish.",
    );
    const impl = read(".opencode/agents/implementer-app.md");
    expect(impl).toContain("(our team)");
    expect(impl).toContain("When the task message is about merge conflicts");
    expect(existsSync(join(root, ".opencode/standards/rust.md"))).toBe(false);
    expect(read("AGENTS.md")).toContain("Query the workspace graph before reading files");
    expect(read("AGENTS.md")).toContain("# House rules\nUse tabs.");
    // Config migrated with comments intact; lock rewritten for this version.
    expect(read("factory.config.jsonc")).toContain("// team note: models agreed on 2026-10-01");
    const config = loadConfig(root).config;
    expect(config.schemaVersion).toBe(4);
    expect(config.graph.exclude).toContain("**/vendor/**");
    const lock = readLock(root);
    expect(lock?.factoryVersion).toBe(FACTORY_VERSION);
    expect(lock?.managed[".opencode/agents/implementer-app.md"]?.templateVersion).toBe(
      FACTORY_VERSION,
    );

    expect((await cli(root, "update")).out).toContain("already up to date");

    const rollback = await cli(root, "rollback");
    expect(rollback.code).toBe(ExitCode.Ok);
    expect(await trackedContents()).toEqual(before);
    expect(await gitOut(root, "status", "--porcelain")).toBe("");
  });

  test("a conflicting edit gets markers, nothing is committed, rollback restores", async () => {
    edit(".opencode/agents/implementer-app.md", (t) =>
      t.replace(
        "- On a retry, fix exactly what the gate output reports.",
        "- On a retry, fix exactly what the gate output reports, nothing more.",
      ),
    );
    await commit("chore: tweak retries");
    const head = await gitOut(root, "rev-parse", "HEAD");
    const before = await trackedContents();

    const run = await cli(root, "update");
    expect(run.code).toBe(ExitCode.Precondition);
    expect(run.err).toContain(".opencode/agents/implementer-app.md");
    expect(read(".opencode/agents/implementer-app.md")).toContain("<<<<<<< yours");
    expect(await gitOut(root, "rev-parse", "HEAD")).toBe(head);

    expect((await cli(root, "rollback")).out).toContain("nothing to commit");
    expect(await trackedContents()).toEqual(before);
    expect(await gitOut(root, "status", "--porcelain")).toBe("");
  });

  test("warns when detection differs from the config, without applying it (audit T)", async () => {
    writeFileSync(join(root, "go.mod"), "module example.com/app\n\ngo 1.22\n");
    writeFileSync(join(root, "main.go"), "package main\n\nfunc main() {}\n");
    await commit("chore: a Go tool");
    const dry = await cli(root, "update", "--dry-run");
    expect(dry.code).toBe(ExitCode.Ok);
    expect(dry.out).toContain(
      "detection differs from the config (not applied; see `ai-factory detect`)",
    );
    expect(dry.out).toContain("go");
  });

  test("never commits onto a change branch, even forced (audit P17)", async () => {
    await claimActive(root, "add-x");
    await gitOut(root, "switch", "-q", "-c", "change/add-x");
    const refused = await cli(root, "update", "--force");
    expect(refused.code).toBe(ExitCode.Precondition);
    expect(refused.err).toContain("the AI repo is on change/add-x");
    expect(refused.err).toContain("git switch");
    expect((await cli(root, "update", "--force", "--dry-run")).code).toBe(ExitCode.Ok);
    expect(await gitOut(root, "log", "-1", "--format=%s")).not.toContain("chore(factory): update");
  });

  test("refuses while a change is in progress unless forced; --restore and --tools", async () => {
    await claimActive(root, "busy-change");
    const refused = await cli(root, "update");
    expect(refused.code).toBe(ExitCode.Precondition);
    expect(refused.err).toContain("changes in progress: busy-change");
    expect((await cli(root, "update", "--force")).code).toBe(ExitCode.Ok);
    await releaseActive(root, "busy-change");

    rmSync(join(root, ".opencode/standards/go.md"));
    await commit("chore: drop go standard");
    expect((await cli(root, "update")).code).toBe(ExitCode.Ok);
    expect(existsSync(join(root, ".opencode/standards/go.md"))).toBe(false);
    const restored = await cli(root, "update", "--restore");
    expect(restored.out).toContain("create: .opencode/standards/go.md");
    expect(existsSync(join(root, ".opencode/standards/go.md"))).toBe(true);

    edit("factory.lock.json", (t) => t.replace('"schemaVersion": 1', '"schemaVersion": 0'));
    await commit("chore: pretend an old graph format");
    const tools = await cli(root, "update", "--tools");
    expect(tools.code).toBe(ExitCode.Ok);
    expect(tools.out).toContain("tools: OpenSpec's opencode files regenerated");
    expect(tools.out).toContain("graph: rebuilt");
    expect(readLock(root)?.graph.schemaVersion).toBe(1);
  });
});

describe("activation snapshot", () => {
  test("a resumed change keeps the agent and gate definitions it started with", async () => {
    const { createSingleRepoFixture } = await import("./fixtures/workspaces.ts");
    const fx = await createSingleRepoFixture();
    try {
      expect((await cli(fx.root, "init", "--no-graph")).code).toBe(ExitCode.Ok);
      const file = join(fx.root, "factory.config.jsonc");
      const pass = {
        format: "true",
        lint: "true",
        types: "true",
        test: "true",
        testAffected: "true",
      };
      writeFileSync(
        file,
        readFileSync(file, "utf8").replace(
          '"overrides": {}',
          `"overrides": ${JSON.stringify({ app: pass })}`,
        ),
      );
      await fixtureGit(fx.root, "commit", "-q", "-am", "chore: gates");
      const tasks: ScriptedTask[] = [
        {
          id: "1.1",
          title: "Add a helper",
          repo: "app",
          deps: [],
          touches: ["src/**"],
          file: "src/h.ts",
          content: "export const h = 1;\n",
        },
      ];
      let blocked = true;
      const runtime = new ScriptedRuntime(
        factoryScript({
          changeId: "snap-x",
          summary: "Helper",
          repos: ["app"],
          tasks,
          implement: () =>
            blocked
              ? { handoff: { status: "blocked", openQuestions: ["which file?"] } }
              : undefined,
        }),
      );
      await cliWith(runtime, fx.root, "run", "Helper");
      expect((await cliWith(runtime, fx.root, "approve", "snap-x")).code).toBe(ExitCode.Paused);
      expect(
        existsSync(join(fx.root, ".factory/worktrees/snap-x/.opencode/agents/implementer-app.md")),
      ).toBe(true);
      expect(existsSync(join(fx.root, ".factory/runs/snap-x/snapshot/gates.json"))).toBe(true);

      // The config changes under the paused change: its gates must not follow.
      writeFileSync(
        file,
        readFileSync(file, "utf8").replace('"testAffected":"true"', '"testAffected":"false"'),
      );
      expect(readFileSync(file, "utf8")).toContain('"testAffected":"false"');
      blocked = false;
      await cli(fx.root, "retry", "snap-x", "--task", "1.1");
      expect((await cliWith(runtime, fx.root, "resume", "snap-x")).code).toBe(ExitCode.Ok);
      expect(loadRun(fx.root, "snap-x")?.phase).toBe("done");
      // Closing drops the agent snapshot with the change's worktree folders.
      expect(existsSync(join(fx.root, ".factory/worktrees/snap-x"))).toBe(false);
    } finally {
      fx.cleanup();
    }
  });
});
