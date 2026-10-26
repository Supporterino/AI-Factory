import { describe, expect, test } from "bun:test";
import { contractOrderIssues, dependentsOf, findCycle, validateDag } from "../src/tasks/dag.ts";
import { globsOverlap, matchGlob, touchesOverlap } from "../src/tasks/glob.ts";
import { normalizeCheckboxes, parseTasks, setTaskChecked } from "../src/tasks/parse.ts";

const TASKS = `## 1. backend

- [ ] 1.1 Add OpenAPI path for /health
  - repo: backend
  - deps: none
  - touches: api/openapi.yaml
- [x] 1.2 Add health handler
  - repo: backend
  - deps: 1.1
  - touches: \`internal/http/**\`, cmd/server/main.go

## 2. frontend

- [ ] 2.1 Show health badge
  - repo: frontend
  - deps: 1.1
  - touches: src/components/**

Notes for humans.
`;

describe("parseTasks", () => {
  test("reads tasks and their metadata", () => {
    const { tasks, issues } = parseTasks(TASKS);
    expect(issues).toEqual([]);
    expect(tasks).toEqual([
      {
        id: "1.1",
        title: "Add OpenAPI path for /health",
        line: 3,
        done: false,
        repo: "backend",
        deps: [],
        touches: ["api/openapi.yaml"],
      },
      {
        id: "1.2",
        title: "Add health handler",
        line: 7,
        done: true,
        repo: "backend",
        deps: ["1.1"],
        touches: ["internal/http/**", "cmd/server/main.go"],
      },
      {
        id: "2.1",
        title: "Show health badge",
        line: 14,
        done: false,
        repo: "frontend",
        deps: ["1.1"],
        touches: ["src/components/**"],
      },
    ]);
  });

  test("flags checkboxes OpenSpec would miscount and stray metadata", () => {
    const { issues } = parseTasks(
      "  - repo: x\n- [ ] 1.1 A\n  - [ ] sub item\n```\n- [ ] 9.9 fenced\n```\n",
    );
    expect(issues.map((i) => i.line)).toEqual([1, 3, 5]);
  });

  test("checkbox mirror and normalisation touch only checkbox characters", () => {
    const checked = setTaskChecked(TASKS, "1.1", true);
    expect(checked).toContain("- [x] 1.1 Add OpenAPI");
    expect(checked.replace("- [x] 1.1", "- [ ] 1.1")).toBe(TASKS);
    expect(normalizeCheckboxes(checked)).toBe(normalizeCheckboxes(TASKS));
    expect(normalizeCheckboxes(TASKS)).not.toContain("[x]");
  });
});

describe("validateDag", () => {
  test("accepts a valid DAG", () => {
    const { tasks, issues } = validateDag(parseTasks(TASKS).tasks, ["backend", "frontend"]);
    expect(issues).toEqual([]);
    expect(tasks.map((t) => t.id)).toEqual(["1.1", "1.2", "2.1"]);
  });

  test("rejects cycles, unknown repos and deps, missing metadata", () => {
    const text = `- [ ] 1.1 A
  - repo: backend
  - deps: 1.2
  - touches: a/**
- [ ] 1.2 B
  - repo: backend
  - deps: 1.1
  - touches: b/**
- [ ] 1.3 C
  - repo: mobile
  - deps: 9.9
- [ ] 1.4 D
  - repo: backend
  - touches: ../x
- [ ] 1.5 E
  - repo: backend
  - deps: none
  - touches: src/[ab, docs/{a
`;
    const { issues } = validateDag(parseTasks(text).tasks, ["backend"]);
    expect(issues.map((i) => `${i.task ?? "-"}: ${i.message}`)).toEqual([
      '1.3: unknown repo "mobile" (known: backend)',
      "1.3: unknown dependency 9.9",
      "1.3: missing `touches:` globs",
      "1.4: missing `deps:` line (use `deps: none`)",
      '1.4: touches glob "../x" must stay inside the repo',
      '1.5: touches glob "src/[ab" is not a valid glob (unclosed [)',
      '1.5: touches glob "docs/{a" is not a valid glob (unclosed {)',
      "-: dependency cycle: 1.1 → 1.2 → 1.1",
    ]);
  });

  test("consumers depend on the tasks that change their contract (audit G9)", () => {
    const tasks = [
      { id: "1.1", title: "API", repo: "backend", deps: [], touches: ["api/openapi.yaml"] },
      { id: "1.2", title: "Handler", repo: "backend", deps: ["1.1"], touches: ["internal/**"] },
      { id: "2.1", title: "Badge", repo: "frontend", deps: [], touches: ["src/**"] },
      { id: "2.2", title: "Client", repo: "frontend", deps: ["2.3"], touches: ["src/api/**"] },
      { id: "2.3", title: "Types", repo: "frontend", deps: ["1.1"], touches: ["src/types/**"] },
    ];
    const contracts = [{ provider: "backend", path: "api/openapi.yaml", consumers: ["frontend"] }];
    expect(contractOrderIssues(tasks, contracts)).toEqual([
      {
        task: "2.1",
        message:
          "consumes backend:api/openapi.yaml, so it must depend on 1.1 (contract changes come first)",
      },
    ]);
    expect(contractOrderIssues(tasks.slice(1), contracts)).toEqual([]);
  });

  test("cycle search and transitive dependents", () => {
    expect(
      findCycle([
        { id: "a", deps: [] },
        { id: "b", deps: ["a"] },
      ]),
    ).toBeUndefined();
    const nodes = [
      { id: "a", deps: [] },
      { id: "b", deps: ["a"] },
      { id: "c", deps: ["b"] },
      { id: "d", deps: [] },
    ];
    expect(dependentsOf(nodes, "a").sort()).toEqual(["b", "c"]);
  });
});

describe("globs", () => {
  test("standard glob semantics", () => {
    expect(matchGlob("internal/http/**", "internal/http/a/b.go")).toBe(true);
    expect(matchGlob("src/**/*.ts", "src/a.ts")).toBe(true);
    expect(matchGlob("src/*.ts", "src/a/b.ts")).toBe(false);
  });

  test.each([
    ["api/openapi.yaml", "api/**", true],
    ["internal/http/**", "internal/db/**", false],
    ["src/**/*.go", "src/**/*.ts", false],
    ["src/**", "src/components/*.tsx", true],
    ["a.go", "b.go", false],
    ["**/*.go", "cmd/main.go", true],
  ])("%s vs %s overlap: %s", (a, b, expected) => {
    expect(globsOverlap(a, b)).toBe(expected);
    expect(globsOverlap(b, a)).toBe(expected);
  });

  test("task touches overlap if any pair does", () => {
    expect(touchesOverlap(["a/**", "b.go"], ["c/**", "b.go"])).toBe(true);
    expect(touchesOverlap(["a/**"], ["c/**"])).toBe(false);
  });
});
