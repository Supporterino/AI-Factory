import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FactoryConfig, type FactoryConfigInput, type Language } from "../src/config/schema.ts";
import { globToRegExp, isTestFile } from "../src/gates/affected.ts";
import { compactOutput } from "../src/gates/compact.ts";
import { type GatePlan, resolveGates } from "../src/gates/resolve.ts";
import { findTargets, worktreeFiles } from "../src/gates/targets.ts";
import { PROFILES } from "../src/profiles/index.ts";
import { type Files, writeFiles } from "./fixtures/workspaces.ts";

const M = "a/b";
function config(extra: Partial<FactoryConfigInput> = {}, languages: Language[] = ["typescript"]) {
  return FactoryConfig.parse({
    schemaVersion: 2,
    layout: "single",
    repos: [{ name: "app", path: ".", languages }],
    models: { orchestrator: M, architect: M, reviewer: M, implementer: M, tester: M, explorer: M },
    ...extra,
  });
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ai-factory-gates-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function plan(
  files: Files,
  opts: {
    languages?: Language[];
    mode?: "task" | "full";
    changed?: string[];
    extra?: Partial<FactoryConfigInput>;
  } = {},
): GatePlan {
  writeFiles(dir, files);
  const cfg = config(opts.extra, opts.languages ?? ["typescript"]);
  const repo = cfg.repos[0];
  if (repo === undefined) throw new Error("no repo");
  return resolveGates({
    config: cfg,
    repo,
    worktree: dir,
    mode: opts.mode ?? "full",
    base: "abc123",
    changed: opts.changed ?? [],
    files: worktreeFiles(dir),
  });
}

const commands = (p: GatePlan) =>
  p.gates.map((g) => `${g.type}@${g.cwd}: ${g.command} (${g.source})`);

describe("targets", () => {
  test("TS workspace root covers its packages; react and typescript share a target", () => {
    writeFiles(dir, {
      "package.json": "{}",
      "packages/a/package.json": "{}",
      "packages/b/package.json": "{}",
    });
    const targets = findTargets(["typescript", "react"], worktreeFiles(dir));
    expect(targets.map((t) => `${t.profile.id}@${t.dir}`)).toEqual(["typescript@."]);
  });

  test("tauri supersedes rust in src-tauri; the frontend stays a typescript target", () => {
    writeFiles(dir, {
      "package.json": "{}",
      "src-tauri/Cargo.toml": '[package]\nname = "app"\n',
      "src-tauri/tauri.conf.json": "{}",
      "crates/core/Cargo.toml": '[package]\nname = "core"\n',
    });
    const targets = findTargets(["typescript", "rust", "tauri"], worktreeFiles(dir));
    expect(targets.map((t) => `${t.profile.id}@${t.dir}`)).toEqual([
      "typescript@.",
      "rust@crates/core",
      "tauri@src-tauri",
    ]);
  });

  test("Go modules stay separate; charts form one target with every top-most chart", () => {
    writeFiles(dir, {
      "go.mod": "module a\n",
      "tools/go.mod": "module tools\n",
      "charts/app/Chart.yaml": "name: app\n",
      "charts/app/charts/db/Chart.yaml": "name: db\n",
      "charts/worker/Chart.yaml": "name: worker\n",
    });
    const targets = findTargets(["go", "helm"], worktreeFiles(dir));
    expect(targets.map((t) => [t.profile.id, t.dir, t.charts])).toEqual([
      ["go", ".", []],
      ["go", "tools", []],
      ["helm", ".", ["charts/app", "charts/worker"]],
    ]);
  });
});

describe("resolution order", () => {
  const pkg = (scripts: Record<string, string>, deps: Record<string, string> = {}) =>
    JSON.stringify({ scripts, devDependencies: deps });

  test("profile defaults pick the configured tool", () => {
    const p = plan({
      "package.json": pkg({}, { vitest: "4" }),
      "biome.json": "{}",
      "tsconfig.json": "{}",
    });
    expect(commands(p)).toEqual([
      "format@.: biome format . (profile)",
      "lint@.: biome lint . (profile)",
      "types@.: tsc --noEmit (profile)",
      "test@.: vitest run (profile)",
    ]);
    expect(p.missing).toEqual([]);
    expect(p.gates[0]?.binDirs).toEqual(["node_modules/.bin"]);
  });

  test("a repo script beats the profile; the runner follows the lockfile", () => {
    const p = plan({
      "package.json": pkg({ lint: "eslint .", "format:check": "prettier -c ." }),
      "bun.lock": "",
      "biome.json": "{}",
      "tsconfig.json": "{}",
    });
    expect(commands(p).slice(0, 2)).toEqual([
      "format@.: bun run format:check (script)",
      "lint@.: bun run lint (script)",
    ]);
  });

  test("Makefile, justfile and Taskfile targets count as scripts", () => {
    expect(
      commands(
        plan(
          { "go.mod": "module a\n", Makefile: "lint:\n\tgolangci-lint run\n" },
          { languages: ["go"] },
        ),
      ),
    ).toContain("lint@.: make lint (script)");
    rmSync(join(dir, "Makefile"));
    expect(
      commands(plan({ justfile: "typecheck:\n  go vet ./...\n" }, { languages: ["go"] })),
    ).toContain("types@.: just typecheck (script)");
    rmSync(join(dir, "justfile"));
    expect(
      commands(
        plan(
          { "Taskfile.yml": "version: '3'\ntasks:\n  test:\n    cmds: [go test ./...]\n" },
          { languages: ["go"] },
        ),
      ),
    ).toContain("test@.: task test (script)");
  });

  test("an override beats everything; 'skip' is an explicit opt-out", () => {
    const p = plan(
      { "go.mod": "module a\n", "main.go": "package main\n", Makefile: "lint:\n\ttrue\n" },
      {
        languages: ["go"],
        mode: "task",
        changed: ["main.go"],
        extra: {
          gates: { overrides: { app: { lint: "skip", testAffected: "go test -race {packages}" } } },
        },
      },
    );
    expect(commands(p)).toContain("testAffected@.: go test -race . (override)");
    expect(p.skipped).toEqual([
      { type: "lint", cwd: ".", reason: "skip: gates.overrides.app.lint" },
    ]);
  });

  test("no tool configured is reported as missing, not skipped", () => {
    const p = plan({ "package.json": pkg({}), "tsconfig.json": "{}" });
    expect(p.missing.map((m) => m.type)).toEqual(["format", "lint", "test"]);
    expect(p.missing[0]?.reason).toContain("set gates.overrides.app.format");
  });
});

describe("task mode", () => {
  test("only touched targets run, with file-scoped commands", () => {
    const p = plan(
      {
        "go.mod": "module a\n",
        "internal/http/health.go": "package http\n",
        "tools/go.mod": "module tools\n",
        "tools/gen.go": "package main\n",
      },
      { languages: ["go"], mode: "task", changed: ["internal/http/health.go", "README.md"] },
    );
    expect(commands(p)).toEqual([
      `format@.: out="$(gofmt -l internal/http/health.go)"; [ -z "$out" ] || { echo "needs gofmt:"; echo "$out"; exit 1; } (profile)`,
      "lint@.: golangci-lint run --new-from-rev=abc123 (profile)",
      "types@.: go vet ./internal/http (profile)",
      "testAffected@.: go test -race ./internal/http (profile)",
    ]);
  });

  test("bun affected tests: changed tests plus tests named after changed sources", () => {
    const p = plan(
      {
        "package.json": "{}",
        "bun.lock": "",
        "biome.json": "{}",
        "src/sum.ts": "",
        "src/sum.test.ts": "",
        "src/other.test.ts": "",
        "src/my file.ts": "",
      },
      { mode: "task", changed: ["src/my file.ts", "src/sum.ts"] },
    );
    expect(commands(p)).toContain("testAffected@.: bun test src/sum.test.ts (profile)");
    expect(commands(p)).toContain(
      "format@.: biome format --no-errors-on-unmatched 'src/my file.ts' src/sum.ts (profile)",
    );
  });

  test("helm lints only affected charts; nothing affected means skipped", () => {
    const files = {
      "charts/app/Chart.yaml": "name: app\n",
      "charts/app/values.yaml": "a: 1\n",
      "charts/worker/Chart.yaml": "name: worker\n",
    };
    const p = plan(files, {
      languages: ["helm"],
      mode: "task",
      changed: ["charts/app/values.yaml"],
    });
    expect(commands(p)).toContain("lint@.: helm lint charts/app (profile)");
    const none = plan(files, { languages: ["helm"], mode: "task", changed: ["README.md"] });
    expect(none.gates).toEqual([]);
  });

  test("rust affected tests select crates", () => {
    const p = plan(
      {
        "Cargo.toml": '[workspace]\nmembers = ["crates/*"]\n',
        "crates/core/Cargo.toml": '[package]\nname = "app-core"\nversion = "0.1.0"\n',
        "crates/core/src/lib.rs": "",
      },
      { languages: ["rust"], mode: "task", changed: ["crates/core/src/lib.rs"] },
    );
    expect(commands(p)).toContain("testAffected@.: cargo test -p app-core (profile)");
  });
});

describe("tauri gates", () => {
  const app: Files = {
    "package.json": "{}",
    "src/main.ts": "export {};\n",
    "src-tauri/Cargo.toml": '[package]\nname = "app"\n',
    "src-tauri/tauri.conf.json": JSON.stringify({ build: { frontendDist: "../dist" } }),
    "src-tauri/src/lib.rs": "pub fn run() {}\n",
    "src-tauri/capabilities/default.json": "{}",
  };

  test("cargo gates run once, in src-tauri, after ensuring frontendDist", () => {
    const p = plan(app, {
      languages: ["typescript", "rust", "tauri"],
      extra: { gates: { overrides: {}, scripts: {} } },
    });
    const tauri = p.gates.filter((g) => g.profile === "tauri");
    expect(tauri.map((g) => `${g.type}@${g.cwd}`)).toEqual([
      "format@src-tauri",
      "lint@src-tauri",
      "types@src-tauri",
      "test@src-tauri",
    ]);
    expect(p.gates.some((g) => g.profile === "rust")).toBe(false);
    expect(tauri.find((g) => g.type === "types")?.command).toEndWith("; cargo check --all-targets");
    expect(tauri.find((g) => g.type === "format")?.command).toBe("cargo fmt --all --check");
  });

  test("a capability-only change re-runs the compile checks but selects no crate tests", () => {
    const p = plan(app, {
      languages: ["typescript", "rust", "tauri"],
      mode: "task",
      changed: ["src-tauri/capabilities/default.json"],
      extra: { gates: { overrides: {}, scripts: {} } },
    });
    expect(p.gates.filter((g) => g.profile === "tauri").map((g) => g.type)).toEqual([
      "format",
      "lint",
      "types",
    ]);
    expect(p.skipped.map((g) => `${g.type}@${g.cwd}: ${g.reason}`)).toContain(
      "testAffected@src-tauri: skip: nothing affected",
    );
  });

  test("the frontendDist step creates a missing dist dir and ignores URLs and other formats", async () => {
    const types = plan(app, { languages: ["tauri"] }).gates.find((g) => g.type === "types");
    const prelude = types?.command.replace("; cargo check --all-targets", "") ?? "";
    const sh = (cwd: string) => Bun.spawnSync(["sh", "-c", prelude], { cwd }).exitCode;
    expect(sh(join(dir, "src-tauri"))).toBe(0);
    expect(existsSync(join(dir, "dist"))).toBe(true);

    writeFiles(dir, {
      "url/src-tauri/tauri.conf.json": JSON.stringify({ build: { frontendDist: "http://x" } }),
      "toml/src-tauri/Tauri.toml": 'frontend-dist = "../out"\n',
    });
    expect(sh(join(dir, "url/src-tauri"))).toBe(0);
    expect(existsSync(join(dir, "url/src-tauri/http:"))).toBe(false);
    expect(sh(join(dir, "toml/src-tauri"))).toBe(0);
    expect(existsSync(join(dir, "toml/out"))).toBe(false);
  });
});

describe("test-file globs", () => {
  test("opencode semantics: * also matches /", () => {
    expect(globToRegExp("*_test.go").test("internal/http/health_test.go")).toBe(true);
    expect(isTestFile(PROFILES.python, "pkg/tests/test_api.py")).toBe(true);
    expect(isTestFile(PROFILES.typescript, "src/sum.ts")).toBe(false);
  });
});

describe("compactOutput", () => {
  test("strips ANSI, drops duplicates, keeps failures with context, caps lines", () => {
    const raw = [
      "\u001b[32mRUN\u001b[0m TestA",
      "ok   a 0.1s",
      "progress 10%",
      "progress 10%",
      "noise 1",
      "noise 2",
      "noise 3",
      "noise 4",
      "health_test.go:12: expected 200, got 500",
      "--- FAIL: TestHealth (0.00s)",
      "FAIL",
    ].join("\n");
    expect(compactOutput(raw, 80)).toBe(
      [
        "…",
        "noise 3",
        "noise 4",
        "health_test.go:12: expected 200, got 500",
        "--- FAIL: TestHealth (0.00s)",
        "FAIL",
      ].join("\n"),
    );
    expect(compactOutput(raw, 3).split("\n")).toEqual(["…", "noise 3", "… 4 more lines"]);
  });

  test("falls back to the tail when nothing looks like a failure", () => {
    expect(compactOutput("a\nb\nc\nd", 2)).toBe("c\nd");
  });
});
