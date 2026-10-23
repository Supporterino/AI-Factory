import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ExitCode } from "../src/cli/exit-codes.ts";
import { runCli } from "../src/cli/main.ts";
import { parseConfigText } from "../src/config/load.ts";
import {
  bareRepo,
  createSingleRepoFixture,
  createSubmoduleFixture,
  type Fixture,
  FRONTEND_FILES,
  fixtureGit,
  writeFiles,
} from "./fixtures/workspaces.ts";

interface Run {
  code: number;
  out: string;
  err: string;
}

async function cli(cwd: string, ...argv: string[]): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, { cwd, out: (t) => out.push(t), err: (t) => err.push(t) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

const MODELS = `{
    "orchestrator": "anthropic/claude-sonnet-5-5",
    "architect": "anthropic/claude-opus-5-5",
    "reviewer": "anthropic/claude-opus-5-5",
    "implementer": "anthropic/claude-sonnet-5-5",
    "tester": "anthropic/claude-sonnet-5-5",
    "explorer": "anthropic/claude-haiku-5-5"
  }`;

/** A hand-written config matching the submodule fixture, with comments to preserve. */
function submoduleConfig(backendName = "backend"): string {
  return `{
  // ai-factory workspace config
  "schemaVersion": 2,
  "layout": "submodules",
  "repos": [
    { "name": "ai", "path": ".", "role": "orchestration", "languages": [] },
    { "name": "${backendName}", "path": "repos/backend", "languages": ["go"], "defaultBranch": "main" }, // Go API
    {
      "name": "deploy",
      "path": "repos/deploy",
      "languages": ["helm"],
      "subPaths": [{ "path": "charts/app", "languages": ["helm"] }],
      "defaultBranch": "main"
    },
    { "name": "frontend", "path": "repos/frontend", "languages": ["typescript", "react"], "defaultBranch": "main" }
  ],
  "models": ${MODELS},
  "contracts": [
    /* confirmed by hand */
    { "kind": "helm-values", "provider": "deploy", "path": "charts/app/values.schema.json", "consumers": ["${backendName}"] },
    { "kind": "openapi", "provider": "${backendName}", "path": "api/openapi.yaml", "consumers": ["frontend"] }
  ]
}
`;
}

describe("ai-factory detect (submodules)", () => {
  let fx: Fixture;
  let configFile: string;
  beforeEach(async () => {
    fx = await createSubmoduleFixture();
    configFile = join(fx.root, "factory.config.jsonc");
    writeFileSync(configFile, submoduleConfig());
  });
  afterEach(() => fx.cleanup());

  test("no differences when the config matches", async () => {
    const run = await cli(fx.root, "detect", "--check");
    expect(run).toEqual({ code: ExitCode.Ok, out: "No differences.", err: "" });
  });

  test("works from inside a submodule", async () => {
    const run = await cli(join(fx.root, "repos/frontend/src"), "detect");
    expect(run.out).toBe("No differences.");
  });

  test("renaming a repo in the config is not drift", async () => {
    writeFileSync(configFile, submoduleConfig("api-server"));
    expect((await cli(fx.root, "detect", "--check")).code).toBe(ExitCode.Ok);
  });

  test("a new submodule shows up as drift and --apply adds it, keeping comments", async () => {
    const remote = await bareRepo(fx.base, "worker", {
      "pyproject.toml": '[project]\nname = "worker"\nversion = "0.1.0"\n',
      "worker/main.py": "def main() -> None:\n    pass\n",
    });
    await fixtureGit(fx.root, "submodule", "add", "-q", remote, "repos/worker");

    const check = await cli(fx.root, "detect", "--check");
    expect(check.code).toBe(ExitCode.Drift);
    expect(check.out).toBe(
      [
        "+ repo worker (repos/worker) languages [python]",
        "Run `ai-factory detect --apply` to write these changes.",
      ].join("\n"),
    );
    // --check never writes.
    expect(readFileSync(configFile, "utf8")).toBe(submoduleConfig());

    const apply = await cli(fx.root, "detect", "--apply");
    expect(apply.code).toBe(ExitCode.Ok);
    expect(apply.out).toEndWith("Updated factory.config.jsonc (1 change).");

    const text = readFileSync(configFile, "utf8");
    for (const comment of [
      "// ai-factory workspace config",
      "// Go API",
      "/* confirmed by hand */",
    ]) {
      expect(text).toContain(comment);
    }
    const cfg = parseConfigText(text, "factory.config.jsonc");
    expect(cfg.repos.at(-1)).toEqual({
      name: "worker",
      path: "repos/worker",
      role: "code",
      languages: ["python"],
      defaultBranch: "main",
    });
    expect((await cli(fx.root, "detect", "--check")).code).toBe(ExitCode.Ok);
  });

  test("language, contract and removal changes round-trip through --apply", async () => {
    // Frontend drops React and stops referencing the backend API.
    const pkg = JSON.parse(FRONTEND_FILES["package.json"] ?? "{}") as Record<string, unknown>;
    writeFiles(join(fx.root, "repos/frontend"), {
      "package.json": JSON.stringify({ ...pkg, dependencies: {}, scripts: {} }, null, 2),
    });
    // The config also lists a repo that no longer exists.
    writeFileSync(
      configFile,
      submoduleConfig().replace(
        '"repos": [',
        '"repos": [\n    { "name": "legacy", "path": "repos/legacy", "languages": ["go"] },',
      ),
    );

    const check = await cli(fx.root, "detect");
    expect(check.out.split("\n")).toEqual([
      "~ repo frontend languages: [typescript, react] → [typescript]",
      "- repo legacy (repos/legacy)",
      "~ contract openapi backend:api/openapi.yaml consumers: [frontend] → []",
      "Run `ai-factory detect --apply` to write these changes.",
    ]);

    expect((await cli(fx.root, "detect", "--apply")).code).toBe(ExitCode.Ok);
    const cfg = parseConfigText(readFileSync(configFile, "utf8"), "f");
    expect(cfg.repos.map((r) => r.name)).toEqual(["ai", "backend", "deploy", "frontend"]);
    expect(cfg.repos.find((r) => r.name === "frontend")?.languages).toEqual(["typescript"]);
    expect((await cli(fx.root, "detect", "--check")).code).toBe(ExitCode.Ok);
  });

  test("--json prints the detection and the changes", async () => {
    const run = await cli(fx.root, "detect", "--json");
    const parsed = JSON.parse(run.out) as { changes: unknown[]; detection: { layout: string } };
    expect(parsed.changes).toEqual([]);
    expect(parsed.detection.layout).toBe("submodules");
  });

  test("an invalid config exits with ConfigInvalid", async () => {
    writeFileSync(configFile, '{ "schemaVersion": 2, "layout": "nope" }');
    const run = await cli(fx.root, "detect");
    expect(run.code).toBe(ExitCode.ConfigInvalid);
    expect(run.err).toContain("factory.config.jsonc is invalid");
  });
});

describe("ai-factory detect (single repo, no config)", () => {
  let fx: Fixture;
  beforeEach(async () => {
    fx = await createSingleRepoFixture();
  });
  afterEach(() => fx.cleanup());

  test("shows what init would propose", async () => {
    const run = await cli(fx.root, "detect");
    expect(run.code).toBe(ExitCode.Ok);
    expect(run.out.split("\n")).toEqual([
      "no factory.config.jsonc yet; this is what `ai-factory init` would propose:",
      "~ layout: (none) → single",
      "+ repo app (.) languages [typescript]",
    ]);
  });

  test("--apply without a config is a precondition error", async () => {
    const run = await cli(fx.root, "detect", "--apply");
    expect(run.code).toBe(ExitCode.Precondition);
    expect(run.err).toContain("run `ai-factory init` first");
  });

  test("usage errors", async () => {
    expect((await cli(fx.root, "detect", "--nope")).code).toBe(ExitCode.Usage);
    expect((await cli(fx.root, "frobnicate")).code).toBe(ExitCode.Usage);
    expect((await cli(fx.root, "detect", "--help")).out).toStartWith("Usage: ai-factory detect");
  });
});
