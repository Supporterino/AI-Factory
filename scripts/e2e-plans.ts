import type { TeamPlan } from "../test/fixtures/stub-team.ts";

/** The two changes the manual E2E runs act out (see scripts/e2e-transcript.ts). */

export interface E2ePlan {
  readonly intro: string;
  readonly request: string;
  readonly team: TeamPlan;
  readonly overrides: Record<string, Record<string, string>>;
  readonly configNote: string;
  readonly contracts?: unknown[];
  readonly repoDirs: readonly string[];
}

interface Task {
  readonly id: string;
  readonly title: string;
  readonly repo: string;
  readonly deps: readonly string[];
  readonly touches: readonly string[];
}

function tasksMd(tasks: readonly Task[]): string {
  const repos = [...new Set(tasks.map((t) => t.repo))];
  return repos
    .map((repo, i) => {
      const lines = tasks
        .filter((t) => t.repo === repo)
        .map(
          (t) =>
            `- [ ] ${t.id} ${t.title}\n  - repo: ${t.repo}\n  - deps: ${t.deps.join(", ") || "none"}\n  - touches: ${t.touches.join(", ")}`,
        );
      return `## ${i + 1}. ${repo}\n\n${lines.join("\n")}\n`;
    })
    .join("\n");
}

// ---------------------------------------------------------------------------------------
// Single repo: three tasks in one TypeScript repo, two of them in parallel.

const SINGLE_ID = "add-text-helpers";
const SINGLE_TASKS: Task[] = [
  { id: "1.1", title: "Add the greet helper", repo: "app", deps: [], touches: ["src/greet.ts"] },
  { id: "1.2", title: "Add the clamp helper", repo: "app", deps: [], touches: ["src/clamp.ts"] },
  {
    id: "1.3",
    title: "Export the helpers from src/index.ts",
    repo: "app",
    deps: ["1.1", "1.2"],
    touches: ["src/index.ts"],
  },
];

export const SINGLE: E2ePlan = {
  intro:
    "The workspace is a single TypeScript repo (`app`: `src/sum.ts` and a `bun test`). The change adds two helpers in parallel tasks, then a third task that depends on both.",
  request: "Add a greet(name) helper and a clamp(n, min, max) helper, exported from src/index.ts",
  repoDirs: ["app"],
  overrides: {
    app: { format: "skip", lint: "skip", types: "skip", testAffected: "bun test {testFiles}" },
  },
  configNote:
    "Config edits for the run: every role uses the stub model. The fixture has no installed formatter, linter or `tsc`, so those gates are `skip`; tests run for real with `bun test` (the repo's `test` script for the full suite, the test files related to each task's changes per task).",
  team: {
    changeId: SINGLE_ID,
    summary: "Add greet and clamp helpers, exported from the package entry point",
    repos: ["app"],
    spec: {
      [`openspec/changes/${SINGLE_ID}/proposal.md`]:
        "## Why\nCallers format greetings and clamp numbers by hand in several places.\n\n## What Changes\n- Add `greet(name)`\n- Add `clamp(n, min, max)`\n- Export both from `src/index.ts`\n\n## Impact\n- Repo `app` only; no API or contract changes\n",
      [`openspec/changes/${SINGLE_ID}/design.md`]:
        "## Context\nTwo small pure functions.\n\n## Decisions\n- One file per helper, re-exported from `src/index.ts`.\n",
      [`openspec/changes/${SINGLE_ID}/specs/text-helpers/spec.md`]:
        '## ADDED Requirements\n\n### Requirement: Greeting\nThe package SHALL export `greet(name)` returning `Hello, <name>!`.\n\n#### Scenario: Greet a name\n- **WHEN** `greet("Ada")` is called\n- **THEN** it returns `Hello, Ada!`\n\n### Requirement: Clamp\nThe package SHALL export `clamp(n, min, max)` that limits `n` to the closed range.\n\n#### Scenario: Value above the range\n- **WHEN** `clamp(12, 0, 10)` is called\n- **THEN** it returns `10`\n',
      [`openspec/changes/${SINGLE_ID}/tasks.md`]: tasksMd(SINGLE_TASKS),
    },
    tasks: {
      "1.1": {
        "src/greet.ts":
          // biome-ignore lint/suspicious/noTemplateCurlyInString: the file's own template literal
          "export function greet(name: string): string {\n  return `Hello, ${name}!`;\n}\n",
      },
      "1.2": {
        "src/clamp.ts":
          "export function clamp(n: number, min: number, max: number): number {\n  return Math.min(max, Math.max(min, n));\n}\n",
      },
      "1.3": {
        "src/index.ts":
          'export { clamp } from "./clamp";\nexport { greet } from "./greet";\nexport { sum } from "./sum";\n',
      },
    },
    tests: {
      app: {
        "src/greet.test.ts":
          'import { expect, test } from "bun:test";\nimport { greet } from "./greet";\n\ntest("greet a name", () => expect(greet("Ada")).toBe("Hello, Ada!"));\n',
        "src/clamp.test.ts":
          'import { expect, test } from "bun:test";\nimport { clamp } from "./clamp";\n\ntest("value above the range", () => expect(clamp(12, 0, 10)).toBe(10));\n',
      },
    },
    findings: {
      app: [
        {
          severity: "nice",
          file: "src/clamp.ts",
          line: 1,
          what: "clamp accepts min > max",
          problem: "With min > max the result is always max, which hides a caller bug.",
          fix: "Throw a RangeError when min > max.",
          impact: "Silent wrong values for swapped bounds.",
        },
      ],
    },
    probes: { "1.1": ["git push origin HEAD", "sh -c 'git push --force origin main'"] },
  },
};

// ---------------------------------------------------------------------------------------
// AI repo with submodules: backend (Go, OpenAPI provider) + frontend (React consumer).

const SUB_ID = "add-version-endpoint";
const SUB_TASKS: Task[] = [
  {
    id: "1.1",
    title: "Add GET /version to the backend and its OpenAPI contract",
    repo: "backend",
    deps: [],
    touches: ["version.go", "main.go", "api/openapi.yaml"],
  },
  {
    id: "1.2",
    title: "Add the readiness handler",
    repo: "backend",
    deps: [],
    touches: ["ready.go"],
  },
  {
    id: "1.3",
    title: "Register GET /ready",
    repo: "backend",
    deps: ["1.1", "1.2"],
    touches: ["main.go"],
  },
  {
    id: "2.1",
    title: "Show the backend version in the frontend",
    repo: "frontend",
    deps: ["1.1"],
    touches: ["src/Version.tsx"],
  },
];

const OPENAPI_V2 = `openapi: 3.0.3
info:
  title: Backend API
  version: 1.1.0
paths:
  /health:
    get:
      operationId: getHealth
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema:
                type: object
                required: [status]
                properties:
                  status:
                    type: string
  /version:
    get:
      operationId: getVersion
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema:
                type: object
                required: [version]
                properties:
                  version:
                    type: string
`;

const mainGo = (routes: readonly string[]): string =>
  `package main\n\nimport "net/http"\n\nfunc main() {\n${routes.map((r) => `\thttp.HandleFunc("/${r}", ${r})\n`).join("")}\t_ = http.ListenAndServe(":8080", nil)\n}\n`;

export const SUBMODULES: E2ePlan = {
  intro:
    "The workspace is an AI repo with three submodules: `backend` (Go, provides `api/openapi.yaml`), `frontend` (React, consumes it) and `deploy` (Helm). The change adds `GET /version` and `GET /ready` to the backend and shows the version in the frontend: two backend tasks and one frontend task start in parallel, a third backend task waits for both.",
  request:
    "Add GET /version (with the OpenAPI contract) and GET /ready to the backend, and show the backend version in the frontend",
  repoDirs: ["backend", "frontend"],
  overrides: {
    backend: { lint: "go vet ./..." },
    frontend: { format: "skip", lint: "skip", types: "skip", test: "skip", testAffected: "skip" },
    deploy: {
      format: "skip",
      types: "helm template charts/app > /dev/null",
      test: "skip",
      testAffected: "skip",
    },
  },
  contracts: [
    { kind: "openapi", provider: "backend", path: "api/openapi.yaml", consumers: ["frontend"] },
  ],
  configNote:
    "Config edits for the run: every role uses the stub model, and the detected OpenAPI contract is confirmed with `frontend` as its consumer. The backend gates are the Go profile's (`gofmt`, `go vet`, `go test -race`); `golangci-lint` is not installed here, so lint runs `go vet`. The frontend fixture has no `node_modules`, so its gates are `skip`. `deploy` keeps `helm lint` and checks rendering with `helm template`.",
  team: {
    changeId: SUB_ID,
    summary: "Add GET /version and GET /ready to the backend; show the version in the frontend",
    repos: ["backend", "frontend"],
    spec: {
      [`openspec/changes/${SUB_ID}/proposal.md`]:
        "## Why\nOperators need to see which backend build is running, and orchestrators need a readiness probe.\n\n## What Changes\n- Add GET /version (OpenAPI: compatible addition)\n- Add GET /ready\n- Show the backend version in the frontend\n\n## Impact\n- Repos: backend, frontend\n- Contract: backend api/openapi.yaml (additive)\n",
      [`openspec/changes/${SUB_ID}/design.md`]:
        "## Context\nThe backend uses net/http handlers registered in main.go.\n\n## Decisions\n- One file per handler; main.go registers routes.\n- The version comes from a package variable set at build time.\n",
      [`openspec/changes/${SUB_ID}/specs/service-info/spec.md`]:
        '## ADDED Requirements\n\n### Requirement: Version endpoint\nThe backend SHALL expose GET /version returning 200 with a JSON body containing `version`.\n\n#### Scenario: Version of a dev build\n- **WHEN** a client calls GET /version on a build without a version\n- **THEN** the response is 200 with body `{"version":"dev"}`\n\n### Requirement: Readiness endpoint\nThe backend SHALL expose GET /ready returning 204 when it can serve traffic.\n\n#### Scenario: Ready service\n- **WHEN** a client calls GET /ready\n- **THEN** the response is 204\n\n### Requirement: Version display\nThe frontend SHALL show the backend version.\n\n#### Scenario: Version shown\n- **WHEN** the version component renders with version `dev`\n- **THEN** it shows `Backend dev`\n',
      [`openspec/changes/${SUB_ID}/tasks.md`]: tasksMd(SUB_TASKS),
    },
    tasks: {
      "1.1": {
        "version.go":
          'package main\n\nimport "net/http"\n\n// Version is the build version reported by GET /version.\nvar Version = "dev"\n\nfunc version(w http.ResponseWriter, _ *http.Request) {\n\tw.Header().Set("Content-Type", "application/json")\n\t_, _ = w.Write([]byte(`{"version":"` + Version + `"}`))\n}\n',
        "main.go": mainGo(["health", "version"]),
        "api/openapi.yaml": OPENAPI_V2,
      },
      "1.2": {
        "ready.go":
          'package main\n\nimport "net/http"\n\nfunc ready(w http.ResponseWriter, _ *http.Request) {\n\tw.WriteHeader(http.StatusNoContent)\n}\n',
      },
      "1.3": { "main.go": mainGo(["health", "version", "ready"]) },
      "2.1": {
        "src/Version.tsx":
          "export function Version({ version }: { version: string }) {\n  return <p>Backend {version}</p>;\n}\n",
      },
    },
    tests: {
      backend: {
        "handlers_test.go":
          'package main\n\nimport (\n\t"net/http/httptest"\n\t"testing"\n)\n\nfunc TestVersion(t *testing.T) {\n\trec := httptest.NewRecorder()\n\tversion(rec, httptest.NewRequest("GET", "/version", nil))\n\tif rec.Code != 200 || rec.Body.String() != `{"version":"dev"}` {\n\t\tt.Fatalf("got %d %q", rec.Code, rec.Body.String())\n\t}\n}\n\nfunc TestReady(t *testing.T) {\n\trec := httptest.NewRecorder()\n\tready(rec, httptest.NewRequest("GET", "/ready", nil))\n\tif rec.Code != 204 {\n\t\tt.Fatalf("got %d", rec.Code)\n\t}\n}\n',
      },
      frontend: {
        "src/Version.test.tsx":
          'import { expect, test } from "vitest";\nimport { Version } from "./Version";\n\ntest("version shown", () => {\n  expect(Version({ version: "dev" }).props.children).toEqual(["Backend ", "dev"]);\n});\n',
      },
    },
    probes: { "1.1": ["git push origin HEAD"] },
  },
};
