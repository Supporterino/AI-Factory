import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { appendJsonc, parseJsonc, setJsonc } from "../src/config/jsonc.ts";
import { parseConfigText } from "../src/config/load.ts";
import { FactoryConfig, type FactoryConfigInput, modelFor } from "../src/config/schema.ts";
import { ConfigError } from "../src/errors.ts";
import { FACTORY_VERSION, PACKAGE_NAME } from "../src/version.ts";
import { PONYTAIL } from "../src/versions.ts";

const MODELS = {
  orchestrator: "anthropic/claude-sonnet-5-5",
  architect: "anthropic/claude-opus-5-5",
  reviewer: "anthropic/claude-opus-5-5",
  implementer: "anthropic/claude-sonnet-5-5",
  tester: "anthropic/claude-sonnet-5-5",
  explorer: "anthropic/claude-haiku-5-5",
};

const submodules = (): FactoryConfigInput => ({
  schemaVersion: 2,
  layout: "submodules",
  repos: [
    { name: "ai", path: ".", role: "orchestration", languages: [] },
    { name: "backend", path: "repos/backend", languages: ["go"], defaultBranch: "main" },
    { name: "frontend", path: "repos/frontend", languages: ["typescript", "react"] },
  ],
  models: MODELS,
  contracts: [
    { kind: "openapi", provider: "backend", path: "api/openapi.yaml", consumers: ["frontend"] },
  ],
  gates: { overrides: { backend: { testAffected: "go test -race {packages}" } } },
});

function issues(input: unknown): string[] {
  const res = FactoryConfig.safeParse(input);
  return res.success ? [] : res.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
}

describe("FactoryConfig schema", () => {
  test("applies documented defaults", () => {
    const cfg = FactoryConfig.parse(submodules());
    expect(cfg.gates.maxRetries).toBe(3);
    expect(cfg.gates.scripts.testAffected).toBe("test:affected");
    expect(cfg.parallel).toEqual({ maxAgents: 4, maxGateProcesses: 2, withinRepo: "worktrees" });
    expect(cfg.tokens).toEqual({
      mode: "report",
      contextPackMaxTokens: 8000,
      gateOutputMaxLines: 80,
    });
    expect(cfg.addons.ponytail).toEqual({
      enabled: true,
      ref: `${PONYTAIL.tag}@${PONYTAIL.commit}`,
      roles: ["implementer", "reviewer"],
      level: "full",
      shortcutComments: "report",
    });
    expect(cfg.logs).toEqual({ retentionDays: 14, redact: true });
    expect(cfg.graph.exclude).toContain("graphify-out/**");
    expect(cfg.repos[1]?.role).toBe("code");
    expect(cfg.unmanaged).toEqual([]);
  });

  test("contractReviewer falls back to reviewer", () => {
    const cfg = FactoryConfig.parse(submodules());
    expect(modelFor(cfg, "contractReviewer")).toBe(MODELS.reviewer);
    expect(
      modelFor(
        FactoryConfig.parse({ ...submodules(), models: { ...MODELS, contractReviewer: "x/y" } }),
        "contractReviewer",
      ),
    ).toBe("x/y");
  });

  test("rejects unknown keys and bad values", () => {
    expect(issues({ ...submodules(), extra: 1 })).toEqual([': Unrecognized key: "extra"']);
    expect(issues({ ...submodules(), schemaVersion: 4 })[0]).toStartWith("schemaVersion:");
    expect(issues({ ...submodules(), models: { ...MODELS, implementer: "sonnet" } })).toEqual([
      'models.implementer: expected "provider/model"',
    ]);
    const badLang = submodules();
    badLang.repos[1] = { name: "backend", path: "repos/backend", languages: ["cobol" as "go"] };
    expect(issues(badLang)[0]).toStartWith("repos.1.languages.0:");
  });

  test("rejects paths that escape the workspace", () => {
    for (const path of ["../x", "/abs", "a/../../b", "a\\b"]) {
      const cfg = submodules();
      cfg.repos[1] = { name: "backend", path, languages: ["go"] };
      expect(issues(cfg).some((i) => i.startsWith("repos.1.path:"))).toBe(true);
    }
  });

  test("cross-field rules", () => {
    const dupe = submodules();
    dupe.repos.push({ name: "backend", path: "repos/b2", languages: [] });
    expect(issues(dupe)).toContain('repos.3.name: duplicate repo name "backend"');

    const noOrch = submodules();
    noOrch.repos[0] = { name: "ai", path: ".", languages: [] };
    expect(issues(noOrch)).toContain(
      'repos: submodules layout needs exactly one "orchestration" repo with path "."',
    );

    const badContract = submodules();
    badContract.contracts = [
      { kind: "openapi", provider: "ai", path: "x.yaml", consumers: ["backend", "nope"] },
    ];
    expect(issues(badContract)).toEqual([
      'contracts.0.provider: unknown code repo "ai"',
      'contracts.0.consumers.1: unknown code repo "nope"',
    ]);

    const selfConsumer = submodules();
    selfConsumer.contracts = [
      { kind: "openapi", provider: "backend", path: "x.yaml", consumers: ["backend"] },
    ];
    expect(issues(selfConsumer)).toEqual([
      "contracts.0.consumers.0: a provider cannot consume its own contract",
    ]);

    const badOverride = submodules();
    badOverride.gates = { overrides: { ghost: { lint: "x" } } };
    expect(issues(badOverride)).toEqual(['gates.overrides.ghost: unknown code repo "ghost"']);
  });

  test("single layout needs exactly one code repo at '.'", () => {
    const single: FactoryConfigInput = {
      schemaVersion: 2,
      layout: "single",
      repos: [{ name: "app", path: ".", languages: ["typescript"] }],
      models: MODELS,
    };
    expect(issues(single)).toEqual([]);
    expect(issues({ ...single, repos: [{ name: "app", path: "sub", languages: [] }] })).toEqual([
      'repos: single layout needs exactly one repo with path "."',
    ]);
    expect(
      issues({
        ...single,
        repos: [{ name: "app", path: ".", role: "orchestration", languages: [] }],
      }),
    ).toEqual(['repos: single layout has no "orchestration" repo']);
  });
});

describe("JSONC config text", () => {
  const TEXT = `{
  // Layout of the workspace
  "schemaVersion": 2,
  "layout": "single", /* detected */
  "repos": [
    { "name": "app", "path": ".", "languages": ["typescript"] }, // the only repo
  ],
  "models": ${JSON.stringify(MODELS)},
}
`;

  test("parses comments and trailing commas", () => {
    expect(parseConfigText(TEXT, "factory.config.jsonc").repos[0]?.name).toBe("app");
  });

  test("reports syntax errors with line and column", () => {
    try {
      parseConfigText('{\n  "layout": "single"\n  "x": 1\n}', "f.jsonc");
      throw new Error("expected a ConfigError");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).details).toEqual(["3:3 CommaExpected"]);
    }
  });

  test("reports schema errors per field", () => {
    expect(() => parseConfigText('{"schemaVersion": 2}', "f.jsonc")).toThrow(ConfigError);
  });

  test("targeted edits keep comments", () => {
    let out = setJsonc(TEXT, ["repos", 0, "languages"], ["typescript", "react"]);
    out = appendJsonc(out, ["repos"], { name: "lib", path: "lib", languages: [] });
    expect(out).toContain("// Layout of the workspace");
    expect(out).toContain("/* detected */");
    expect(out).toContain("// the only repo");
    expect(parseJsonc(out).value).toMatchObject({
      repos: [{ languages: ["typescript", "react"] }, { name: "lib" }],
    });
  });
});

test("FACTORY_VERSION and PACKAGE_NAME match package.json", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
    name: string;
    bin: unknown;
  };
  expect(FACTORY_VERSION).toBe(pkg.version);
  expect(PACKAGE_NAME).toBe(pkg.name);
  expect(pkg.bin).toEqual({ "ai-factory": "./dist/cli.js" });
});
