import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FactoryConfig, type FactoryConfigInput, modelFor } from "../src/config/schema.ts";
import { detectContracts } from "../src/detect/contracts.ts";
import { listFiles } from "../src/detect/walk.ts";
import { refineRequest, requestSlug } from "../src/pipeline/refine.ts";
import { renderWorkspace } from "../src/render/workspace.ts";
import { agentForTask } from "../src/tasks/routing.ts";
import { archiveLegacySetups } from "../src/workspace/legacy.ts";
import { fixtureGit } from "./fixtures/workspaces.ts";
import { gitOut } from "./helpers.ts";

const M = "anthropic/claude-sonnet-5-5";

function config(input: Partial<FactoryConfigInput> = {}): FactoryConfig {
  return FactoryConfig.parse({
    schemaVersion: 3,
    layout: "single",
    repos: [{ name: "app", path: ".", languages: ["typescript"] }],
    models: {
      orchestrator: M,
      architect: M,
      reviewer: M,
      implementer: M,
      tester: M,
      explorer: M,
      ...input.models,
    },
    ...input,
  });
}

describe("v3 context config", () => {
  test("applies context, workflow and release defaults", () => {
    const cfg = config();
    expect(cfg.instructions).toEqual({ workspace: [], repos: {} });
    expect(cfg.skills.sources).toEqual([".opencode/skills"]);
    expect(cfg.agents).toEqual([]);
    expect(cfg.routing).toEqual([]);
    expect(cfg.commits).toEqual({ style: "conventional", scopes: false });
    expect(cfg.workflow).toEqual({
      refine: true,
      clarifyRounds: 2,
      quick: { enabled: true, branchPrefix: "task/" },
    });
    expect(cfg.release).toEqual({ detect: true });
    expect(cfg.websearch).toEqual({ provider: "random" });
    expect(cfg.runtime).toEqual({ turnTimeoutMinutes: 60 });
  });

  test("clarifyRounds is bounded", () => {
    expect(() => config({ workflow: { clarifyRounds: 0 } })).toThrow();
    expect(() => config({ workflow: { clarifyRounds: 11 } })).toThrow();
    expect(config({ workflow: { clarifyRounds: 3 } }).workflow.clarifyRounds).toBe(3);
  });

  test("models resolve agent > repo > role > flat", () => {
    const cfg = config({
      models: {
        orchestrator: M,
        architect: M,
        reviewer: M,
        implementer: M,
        tester: M,
        explorer: M,
        roles: { implementer: "role/model" },
        repos: { app: { implementer: "repo/model" } },
        agents: { ui: "agent/model" },
      },
      agents: [
        {
          id: "ui",
          phase: "implementer",
          description: "UI",
          prompt: "You do UI.",
          edits: ["src/ui/**"],
        },
      ],
    });
    expect(modelFor(cfg, "implementer")).toBe("role/model");
    expect(modelFor(cfg, "implementer", { repo: "app" })).toBe("repo/model");
    expect(modelFor(cfg, "implementer", { repo: "app", agent: "ui" })).toBe("agent/model");
    expect(modelFor(cfg, "reviewer")).toBe(M);
  });

  test("instructions, skills and custom agents reach the rendered files", () => {
    const cfg = config({
      instructions: { workspace: ["docs/security.md"], repos: { app: ["AGENTS.md"] } },
      skills: { roles: { implementer: ["working-agreement"] } },
      agents: [
        {
          id: "ui",
          phase: "implementer",
          description: "UI specialist",
          prompt: "You build the UI.",
          edits: ["src/ui/**"],
          skills: ["design-system"],
        },
      ],
      routing: [{ paths: ["src/ui/**"], agent: "ui" }],
    });
    const files = renderWorkspace(cfg);
    const byPath = new Map(files.map((f) => [f.path, f.content]));
    expect(byPath.get(".opencode/opencode.jsonc")).toContain("docs/security.md");
    expect(byPath.get(".opencode/opencode.jsonc")).toContain("AGENTS.md");
    expect(byPath.get(".opencode/opencode.jsonc")).toContain('"websearch": {');
    expect(byPath.get(".opencode/opencode.jsonc")).toContain('"provider": "random"');
    const implementer = byPath.get(".opencode/agents/implementer-app.md") ?? "";
    expect(implementer).toContain("Load these skills first");
    expect(implementer).toContain("working-agreement");
    expect(implementer).toContain("## Project instructions");
    const ui = byPath.get(".opencode/agents/ui.md") ?? "";
    expect(ui).toContain("You build the UI.");
    expect(ui).toContain("design-system");
    expect(ui).toContain("resource: src/ui/**");
  });

  test("websearch can be disabled in the rendered opencode config", () => {
    const opencode =
      renderWorkspace(config({ websearch: false })).find(
        (f) => f.path === ".opencode/opencode.jsonc",
      )?.content ?? "";
    expect(opencode).toContain('"websearch": false');
  });

  test("submodule instructions are prefixed with the repo path", () => {
    const cfg = FactoryConfig.parse({
      schemaVersion: 3,
      layout: "submodules",
      repos: [
        { name: "ai", path: ".", role: "orchestration", languages: [] },
        { name: "backend", path: "repos/backend", languages: ["go"] },
      ],
      models: {
        orchestrator: M,
        architect: M,
        reviewer: M,
        implementer: M,
        tester: M,
        explorer: M,
      },
      instructions: { repos: { backend: ["docs/security.md"] } },
    });
    const files = renderWorkspace(cfg);
    const opencode = files.find((f) => f.path === ".opencode/opencode.jsonc")?.content ?? "";
    expect(opencode).toContain("repos/backend/docs/security.md");
    const impl =
      files.find((f) => f.path === ".opencode/agents/implementer-backend.md")?.content ?? "";
    expect(impl).toContain("repos/backend/docs/security.md");
  });

  test("MCP patterns and web access become explicit permissions", () => {
    const cfg = config({
      skills: { roles: { reviewer: ["security-review"] } },
      mcp: { roles: { reviewer: ["mantine_*"] } },
    });
    const reviewer =
      renderWorkspace(cfg).find((f) => f.path === ".opencode/agents/reviewer.md")?.content ?? "";
    expect(reviewer).toContain("action: webfetch");
    expect(reviewer).toContain("action: mantine_*");
    expect(reviewer).toContain('resource: "*", effect: allow');
  });

  test("task routing picks a custom implementer by touched paths", () => {
    const cfg = config({
      agents: [
        {
          id: "ui",
          phase: "implementer",
          description: "UI",
          prompt: "You do UI.",
          edits: ["src/ui/**"],
        },
      ],
      routing: [{ paths: ["src/ui/**"], agent: "ui" }],
    });
    expect(agentForTask(cfg, "app", ["src/ui/Button.tsx"]).agent).toBe("ui");
    expect(agentForTask(cfg, "app", ["src/domain/price.ts"]).agent).toBe("implementer-app");
  });
});

describe("generated contract detection", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ai-factory-contracts-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("proposes IPC bindings and CRD generation commands with their outputs", () => {
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "operator/config/crd/bases"), { recursive: true });
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ scripts: { "gen:bindings": "cargo run --example export_bindings" } }),
    );
    writeFileSync(join(root, "bun.lock"), "");
    writeFileSync(join(root, "src/bindings.ts"), "export type A = string;\n");
    writeFileSync(join(root, "Taskfile.yml"), "version: '3'\ntasks:\n  manifests:\n    cmds: []\n");
    writeFileSync(join(root, "operator/config/crd/bases/x.yaml"), "apiVersion: v1\nkind: X\n");
    const files = listFiles(root, { maxDepth: 8, maxFiles: 100 });
    const contracts = detectContracts([{ name: "app", root, files }]);
    expect(contracts.find((c) => c.kind === "ipc")).toMatchObject({
      path: "src/bindings.ts",
      command: "bun run gen:bindings",
      outputs: ["src/bindings.ts"],
    });
    expect(contracts.find((c) => c.kind === "crd")).toMatchObject({
      path: "operator/config/crd/bases",
      command: "task manifests generate",
    });
  });
});

describe("legacy setup archive", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ai-factory-legacy-"));
    mkdirSync(join(root, ".opencode", "agents"), { recursive: true });
    writeFileSync(join(root, ".opencode", "agents", "orchestrator.md"), "custom\n");
    mkdirSync(join(root, ".opencode", "skills", "custom"), { recursive: true });
    writeFileSync(join(root, ".opencode", "skills", "custom", "SKILL.md"), "custom\n");
    mkdirSync(join(root, ".opencode", "skills", "openspec-apply-change"), { recursive: true });
    writeFileSync(join(root, ".opencode", "skills", "openspec-apply-change", "SKILL.md"), "keep\n");
    mkdirSync(join(root, ".opencode", "commands"), { recursive: true });
    writeFileSync(join(root, ".opencode", "commands", "opsx-apply.md"), "keep\n");
    writeFileSync(join(root, ".opencode", "commands", "mine.md"), "move\n");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("moves replaced agents/commands/skills and leaves OpenSpec files", () => {
    const result = archiveLegacySetups(root, ["."]);
    expect(result.archived).toEqual([
      ".opencode/agents/orchestrator.md",
      ".opencode/commands/mine.md",
      ".opencode/skills/custom",
    ]);
    expect(existsSync(join(root, ".opencode", "agents", "orchestrator.md"))).toBe(false);
    expect(existsSync(join(root, ".opencode", "commands", "opsx-apply.md"))).toBe(true);
    expect(existsSync(join(root, ".opencode", "skills", "openspec-apply-change", "SKILL.md"))).toBe(
      true,
    );
    expect(
      existsSync(
        join(root, ".factory", "legacy", result.stamp, ".opencode", "agents", "orchestrator.md"),
      ),
    ).toBe(true);
  });
});

describe("refine", () => {
  let root: string;
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "ai-factory-refine-"));
    writeFileSync(join(root, "README.md"), "x\n");
    await fixtureGit(root, "init", "-q", "-b", "main");
    await fixtureGit(root, "add", "-A");
    await fixtureGit(root, "commit", "-q", "-m", "chore: init");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("asks, composes a refined request and writes it under .factory/requests", async () => {
    const answers = [
      "backend, frontend",
      "no charts",
      "vitest and go test",
      "keep the API compatible",
      "",
    ];
    let i = 0;
    const { path, text } = await refineRequest(
      {
        cwd: root,
        out: () => {},
        err: () => {},
        ask: async () => answers[i++],
      },
      "Add search to the product list",
    );
    expect(path).toContain(".factory/requests/");
    expect(text).toContain("**scope**: backend, frontend");
    expect(text).toContain("**verification**: vitest and go test");
    expect(readFileSync(path, "utf8")).toContain("Add search to the product list");
    expect(await gitOut(root, "status", "--porcelain")).toContain(".factory/");
  });

  test("slug is stable and bounded", () => {
    expect(requestSlug("Add full-text search to the product list!!")).toBe(
      "add-full-text-search-to-the-product-list",
    );
  });
});
