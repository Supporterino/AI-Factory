import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { FactoryConfig, LANGUAGES } from "../src/config/schema.ts";
import { Handoff } from "../src/handoff/schema.ts";
import { agentRules, PROTECTED_PATHS, ruleEffect } from "../src/policy/permissions.ts";
import { PROFILES, profileSummary, profilesFor, renderStandard } from "../src/profiles/index.ts";
import { renderWorkspace } from "../src/render/workspace.ts";

const M = "anthropic/claude-sonnet-5-5";
const config = FactoryConfig.parse({
  schemaVersion: 2,
  layout: "submodules",
  repos: [
    { name: "ai", path: ".", role: "orchestration", languages: [] },
    { name: "web", path: "repos/web", languages: ["react"] },
  ],
  models: {
    orchestrator: M,
    architect: "anthropic/claude-opus-5-5",
    reviewer: M,
    implementer: M,
    tester: M,
    explorer: M,
  },
});

describe("profiles", () => {
  test.each([...LANGUAGES])(
    "%s: ≤150 prompt lines, has a summary, globs and every gate",
    (lang) => {
      const profile = PROFILES[lang];
      expect(renderStandard(profile, { comments: false }).split("\n").length).toBeLessThanOrEqual(
        150,
      );
      expect(profileSummary(profile).length).toBeGreaterThanOrEqual(3);
      expect(profile.testGlobs.length).toBeGreaterThan(0);
      for (const gate of ["format", "lint", "types", "test", "testAffected"] as const) {
        expect(profile.gates[gate].length).toBeGreaterThan(0);
      }
    },
  );

  test.each([...LANGUAGES])(
    "%s: grounded in cited sources, comments kept out of prompts",
    (lang) => {
      const prose = PROFILES[lang].prose;
      const sources = prose.match(/<!-- Sources:\n([\s\S]*?)-->/)?.[1] ?? "";
      const keys = [...sources.matchAll(/^\s*\[([\w-]+)\] .+ — https:\/\/\S+$/gm)].map((m) => m[1]);
      expect(keys.length).toBeGreaterThanOrEqual(2);
      // Every section after the summary says what grounds it, using the listed keys.
      const sections = [...prose.matchAll(/^## (.+)\n\n?(.*)$/gm)].filter(
        (m) => m[1] !== "Summary",
      );
      expect(sections.length).toBeGreaterThan(0);
      for (const [, title, next] of sections) {
        expect({ title, next }).toEqual({ title, next: expect.stringMatching(/^<!-- .+ -->$/) });
        for (const cited of (next ?? "").matchAll(/\[([\w-]+)\]/g))
          expect(keys).toContain(cited[1]);
      }
      expect(renderStandard(PROFILES[lang])).toContain("<!-- Sources:");
      expect(renderStandard(PROFILES[lang], { comments: false })).not.toContain("<!--");
      expect(profileSummary(PROFILES[lang]).join("\n")).not.toContain("<!--");
    },
  );

  test("react stacks on typescript", () => {
    expect(profilesFor(["react"]).map((p) => p.id)).toEqual(["typescript", "react"]);
  });
});

describe("agent templates", () => {
  const dir = join(import.meta.dir, "../templates/agents");
  test.each(readdirSync(dir).filter((f) => f.endsWith(".md")))(
    "%s role prompt is ≤150 lines",
    (file) => {
      expect(readFileSync(join(dir, file), "utf8").split("\n").length).toBeLessThanOrEqual(150);
    },
  );
});

describe("sub-path languages (audit G9)", () => {
  test("a monorepo package's language brings its standard to the implementer and AGENTS.md", () => {
    const mono = FactoryConfig.parse({
      ...config,
      repos: [
        { name: "ai", path: ".", role: "orchestration", languages: [] },
        {
          name: "app",
          path: "repos/app",
          languages: ["go"],
          subPaths: [{ path: "web", languages: ["typescript"] }],
        },
      ],
    });
    const files = renderWorkspace(mono);
    const implementer = files.find((f) => f.path === ".opencode/agents/implementer-app.md");
    for (const lang of ["typescript", "go"] as const)
      expect(implementer?.content).toContain(
        renderStandard(PROFILES[lang], { comments: false }).slice(0, 200),
      );
    expect(files.find((f) => f.path === "AGENTS.md")?.content).toContain(
      "| app | `repos/app` | code | go, typescript |",
    );
    const context = files.find((f) => f.content.includes("Active language standards"));
    expect(context?.content).toContain(`${PROFILES.typescript.title}:`);
  });
});

describe("renderWorkspace", () => {
  const files = renderWorkspace(config);
  const byPath = new Map(files.map((f) => [f.path, f]));

  test("is deterministic", () => {
    expect(renderWorkspace(config)).toEqual(files);
  });

  test("agent frontmatter carries the role's model and parses as YAML", () => {
    const text = byPath.get(".opencode/agents/architect.md")?.content ?? "";
    const front = parseYaml(text.split("---\n")[1] ?? "") as {
      model: string;
      mode: string;
      permissions: unknown[];
    };
    expect(front.model).toBe("anthropic/claude-opus-5-5");
    expect(front.mode).toBe("primary");
    expect(front.permissions).toEqual(agentRules("architect", [], { web: true }));
  });

  test("every tool-using agent may research the web; the orchestrator may not", () => {
    const permissions = (path: string) => {
      const text = byPath.get(path)?.content ?? "";
      return (
        parseYaml(text.split("---\n")[1] ?? "") as {
          permissions: Parameters<typeof ruleEffect>[0];
        }
      ).permissions;
    };
    for (const path of [
      ".opencode/agents/architect.md",
      ".opencode/agents/explorer.md",
      ".opencode/agents/reviewer.md",
      ".opencode/agents/contract-reviewer.md",
      ".opencode/agents/tester.md",
      ".opencode/agents/implementer-web.md",
    ]) {
      expect(ruleEffect(permissions(path), "webfetch", "https://example.com")).toBe("allow");
      expect(ruleEffect(permissions(path), "websearch", "query")).toBe("allow");
    }
    expect(
      ruleEffect(
        permissions(".opencode/agents/orchestrator.md"),
        "webfetch",
        "https://example.com",
      ),
    ).toBe("deny");
  });

  test("static prompt order: role, standards, shared rules", () => {
    const text = byPath.get(".opencode/agents/implementer-web.md")?.content ?? "";
    const order = [
      "# Role: implementer for repo `web`",
      "# TypeScript / JavaScript standard",
      "# React standard",
      "## Untrusted content",
      "## Graph first",
      "## Handoff",
    ].map((h) => text.indexOf(h));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test("the generated handoff schema matches the zod schema", () => {
    const schema = JSON.parse(
      byPath.get(".opencode/schemas/handoff.schema.json")?.content ?? "{}",
    ) as {
      required: string[];
    };
    expect(schema.required.sort()).toEqual([
      "decisions",
      "filesChanged",
      "openQuestions",
      "risks",
      "status",
      "task",
    ]);
    expect(
      Handoff.safeParse({
        status: "done",
        task: "1.1",
        filesChanged: [],
        decisions: [],
        risks: [],
        openQuestions: [],
      }).success,
    ).toBe(true);
  });
});

describe("permission rules", () => {
  test("start with deny-all and end with the protected denies (last match wins)", () => {
    for (const role of ["orchestrator", "implementer", "tester", "reviewer"] as const) {
      const rules = agentRules(role);
      expect(rules[0]).toEqual({ action: "read", resource: "*", effect: "deny" });
      const lastAllow = rules.findLastIndex((r) => r.effect === "allow");
      for (const path of PROTECTED_PATHS) {
        const i = rules.findIndex(
          (r) => r.action === "edit" && r.resource === path && r.effect === "deny",
        );
        expect(i).toBeGreaterThan(lastAllow);
      }
      expect(rules.at(-1)).toEqual({ action: "external_directory", resource: "*", effect: "deny" });
    }
  });

  test("edit allowances: implementers everywhere, architect its folders, tester test globs", () => {
    const allows = (role: Parameters<typeof agentRules>[0], action: string) =>
      agentRules(role, ["*.test.ts"])
        .filter((r) => r.action === action && r.effect === "allow")
        .map((r) => r.resource);
    expect(allows("implementer", "edit")).toEqual(["*"]);
    expect(allows("architect", "edit")).toEqual(["openspec/changes/*", ".factory/context/*"]);
    expect(allows("tester", "edit")).toEqual(["*.test.ts"]);
    for (const role of ["orchestrator", "explorer", "reviewer", "contract-reviewer"] as const) {
      expect(allows(role, "edit")).toEqual([]);
    }
    const architect = agentRules("architect");
    expect(ruleEffect(architect, "edit", "openspec/changes/add-x/specs/a/spec.md")).toBe("allow");
    expect(ruleEffect(architect, "edit", ".factory/context/add-x/1.1.md")).toBe("allow");
    expect(ruleEffect(architect, "edit", ".factory/runs/add-x.json")).toBe("deny");
    expect(ruleEffect(architect, "edit", ".factory/context/add-x/key.pem")).toBe("deny");
    expect(ruleEffect(architect, "edit", "openspec/specs/a/spec.md")).toBe("deny");
    expect(ruleEffect(architect, "edit", "src/a.ts")).toBe("deny");
    const tester = agentRules("tester", ["*.test.ts", "*_test.go"]);
    expect(ruleEffect(tester, "edit", "src/deep/a.test.ts")).toBe("allow");
    expect(ruleEffect(tester, "edit", "pkg/x_test.go")).toBe("allow");
    expect(ruleEffect(tester, "edit", "src/a.ts")).toBe("deny");
    expect(ruleEffect(tester, "edit", ".opencode/x.test.ts")).toBe("deny");
    expect(allows("explorer", "shell")).not.toContain("*");
    expect(allows("orchestrator", "read")).toEqual([]);
  });
});
