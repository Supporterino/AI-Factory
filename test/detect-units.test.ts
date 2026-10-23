import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectContracts } from "../src/detect/contracts.ts";
import { detectLanguages } from "../src/detect/languages.ts";
import { listFiles } from "../src/detect/walk.ts";
import { type Files, writeFiles } from "./fixtures/workspaces.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ai-factory-units-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function scan(rel: string, files: Files) {
  const root = join(dir, rel);
  writeFiles(root, files);
  return { root, files: listFiles(root, { maxDepth: 6, maxFiles: 10_000 }) };
}

describe("detectLanguages", () => {
  test("monorepo packages override the root by sub-path", () => {
    const { root, files } = scan("mono", {
      "package.json": JSON.stringify({ private: true, workspaces: ["packages/*"] }),
      "tsconfig.json": "{}",
      "packages/core/package.json": JSON.stringify({ name: "core" }),
      "packages/web/package.json": JSON.stringify({ name: "web", dependencies: { react: "19" } }),
      "services/api/go.mod": "module api\n",
      "tools/requirements-dev.txt": "ruff\n",
      "node_modules/react/package.json": JSON.stringify({ name: "react" }),
    });
    expect(detectLanguages(root, files)).toEqual({
      languages: ["typescript", "react", "python", "go"],
      subPaths: [
        { path: "packages/web", languages: ["typescript", "react"] },
        { path: "services/api", languages: ["go"] },
        { path: "tools", languages: ["python"] },
      ],
    });
  });

  test("helm: charts, nested subcharts and plain manifests", () => {
    const { root, files } = scan("infra", {
      "charts/app/Chart.yaml": "apiVersion: v2\nname: app\n",
      "charts/app/charts/db/Chart.yaml": "apiVersion: v2\nname: db\n",
      "charts/app/templates/svc.yaml": "kind: Service\nmetadata: {{ x }}\n",
      "k8s/base/deploy.yaml":
        "apiVersion: apps/v1\nkind: Deployment\n---\napiVersion: v1\nkind: Service\n",
      "k8s/prod/patch.yaml": "apiVersion: apps/v1\nkind: Deployment\n",
      "docs/config.yaml": "title: not a manifest\n",
      "Cargo.toml": '[package]\nname = "x"\n',
    });
    expect(detectLanguages(root, files)).toEqual({
      languages: ["rust", "helm"],
      subPaths: [
        { path: "charts/app", languages: ["helm"] },
        { path: "k8s", languages: ["helm"] },
      ],
    });
  });

  test("a plain JS package uses the typescript profile; empty repo has no languages", () => {
    expect(detectLanguages(...args(scan("js", { "package.json": "{}" }))).languages).toEqual([
      "typescript",
    ]);
    expect(detectLanguages(...args(scan("empty", { "README.md": "x" })))).toEqual({
      languages: [],
      subPaths: [],
    });
  });
});

function args(s: { root: string; files: ReturnType<typeof listFiles> }) {
  return [s.root, s.files] as const;
}

describe("detectContracts", () => {
  test("proto and JSON Schema contracts with consumers", () => {
    const events = scan("events", {
      "proto/events/v1/order.proto": 'syntax = "proto3";\npackage shop.events.v1;\n',
      "proto/events/v1/user.proto": 'syntax = "proto3";\npackage shop.events.v1;\n',
      "schemas/order.schema.json": JSON.stringify({
        $schema: "https://json-schema.org/draft/2020-12/schema",
      }),
      "schemas/plain.json": JSON.stringify({
        $schema: "https://json-schema.org/draft/2020-12/schema",
      }),
    });
    const billing = scan("billing", {
      "go.mod": "module billing\n",
      "consumer.go": "// consumes shop.events.v1\npackage billing\n",
    });
    const web = scan("web", {
      "package.json": JSON.stringify({
        scripts: { validate: "ajv -s ../events/schemas/order.schema.json" },
      }),
    });
    expect(
      detectContracts([
        { name: "events", ...events },
        { name: "billing", ...billing },
        { name: "web", ...web },
      ]),
    ).toEqual([
      {
        kind: "json-schema",
        provider: "events",
        path: "schemas/order.schema.json",
        consumers: ["web"],
      },
      { kind: "proto", provider: "events", path: "proto/events/v1", consumers: ["billing"] },
    ]);
  });
});
