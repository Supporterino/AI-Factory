import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { FactoryConfig, LANGUAGES } from "../src/config/schema.ts";
import { Handoff } from "../src/handoff/schema.ts";
import { agentRules, PROTECTED_PATHS } from "../src/policy/permissions.ts";
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
  test.each([...LANGUAGES])("%s: ≤150 lines, has a summary, globs and every gate", (lang) => {
    const profile = PROFILES[lang];
    expect(renderStandard(profile).split("\n").length).toBeLessThanOrEqual(150);
    expect(profileSummary(profile).length).toBeGreaterThanOrEqual(3);
    expect(profile.testGlobs.length).toBeGreaterThan(0);
    for (const gate of ["format", "lint", "types", "test", "testAffected"] as const) {
      expect(profile.gates[gate].length).toBeGreaterThan(0);
    }
  });

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
    expect(front.permissions).toEqual(agentRules("architect"));
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

  test("only implementers may edit by default; read-only roles cannot run arbitrary shell", () => {
    const allows = (role: Parameters<typeof agentRules>[0], action: string) =>
      agentRules(role)
        .filter((r) => r.action === action && r.effect === "allow")
        .map((r) => r.resource);
    expect(allows("implementer", "edit")).toEqual(["*"]);
    for (const role of [
      "orchestrator",
      "architect",
      "explorer",
      "reviewer",
      "contract-reviewer",
      "tester",
    ] as const) {
      expect(allows(role, "edit")).toEqual([]);
    }
    expect(allows("explorer", "shell")).not.toContain("*");
    expect(allows("orchestrator", "read")).toEqual([]);
  });
});
