import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { detectWorkspace } from "../src/detect/workspace.ts";
import {
  createSingleRepoFixture,
  createSubmoduleFixture,
  type Fixture,
  fixtureGit,
} from "./fixtures/workspaces.ts";

describe("detectWorkspace: single repo", () => {
  let fx: Fixture;
  beforeAll(async () => {
    fx = await createSingleRepoFixture();
  });
  afterAll(() => fx.cleanup());

  test("one code repo at '.', typescript, branch main, no contracts", async () => {
    const d = await detectWorkspace(fx.root);
    expect(d.layout).toBe("single");
    expect(d.repos).toEqual([
      {
        name: "app",
        path: ".",
        role: "code",
        languages: ["typescript"],
        defaultBranch: "main",
        initialized: true,
      },
    ]);
    expect(d.contracts).toEqual([]);
    expect(d.notes).toEqual([]);
  });
});

describe("detectWorkspace: AI repo with submodules", () => {
  let fx: Fixture;
  beforeAll(async () => {
    fx = await createSubmoduleFixture();
  });
  afterAll(() => fx.cleanup());

  test("detects the layout, repos and languages", async () => {
    const d = await detectWorkspace(fx.root);
    expect(d.layout).toBe("submodules");
    expect(d.repos).toEqual([
      { name: "ai", path: ".", role: "orchestration", languages: [], initialized: true },
      {
        name: "backend",
        path: "repos/backend",
        role: "code",
        languages: ["go"],
        defaultBranch: "main",
        initialized: true,
      },
      {
        name: "deploy",
        path: "repos/deploy",
        role: "code",
        languages: ["helm"],
        subPaths: [{ path: "charts/app", languages: ["helm"] }],
        defaultBranch: "main",
        initialized: true,
      },
      {
        name: "frontend",
        path: "repos/frontend",
        role: "code",
        languages: ["typescript", "react"],
        defaultBranch: "main",
        initialized: true,
      },
    ]);
  });

  test("proposes the OpenAPI and Helm values contracts, ignoring testdata", async () => {
    const d = await detectWorkspace(fx.root);
    expect(d.contracts).toEqual([
      {
        kind: "helm-values",
        provider: "deploy",
        path: "charts/app/values.schema.json",
        consumers: ["backend"],
      },
      { kind: "openapi", provider: "backend", path: "api/openapi.yaml", consumers: ["frontend"] },
    ]);
  });

  test("an uninitialised submodule is reported, not guessed", async () => {
    await fixtureGit(fx.root, "submodule", "deinit", "-q", "-f", "repos/deploy");
    rmSync(join(fx.root, "repos/deploy"), { recursive: true, force: true });
    try {
      const d = await detectWorkspace(fx.root);
      expect(d.repos.find((r) => r.name === "deploy")).toEqual({
        name: "deploy",
        path: "repos/deploy",
        role: "code",
        languages: [],
        initialized: false,
      });
      expect(d.notes.join("\n")).toContain("git submodule update --init repos/deploy");
    } finally {
      await fixtureGit(fx.root, "submodule", "update", "-q", "--init", "repos/deploy");
    }
  });
});
