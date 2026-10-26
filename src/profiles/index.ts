import go from "../../templates/standards/go.md" with { type: "text" };
import helm from "../../templates/standards/helm.md" with { type: "text" };
import python from "../../templates/standards/python.md" with { type: "text" };
import react from "../../templates/standards/react.md" with { type: "text" };
import rust from "../../templates/standards/rust.md" with { type: "text" };
import tauri from "../../templates/standards/tauri.md" with { type: "text" };
import typescript from "../../templates/standards/typescript.md" with { type: "text" };
import type { GateType, Language } from "../config/schema.ts";

/**
 * Language profiles. The prose lives in templates/standards/<id>.md; the machine-readable
 * parts (test globs, gate candidates, install steps) live here and are rendered into the
 * same file, so the agent and the CLI read one source.
 *
 * Gate commands run with `sh -c` in a target directory and may contain placeholders:
 * {files} changed files, {testFiles} test files related to them, {packages} Go packages,
 * {crates} Rust `-p` flags, {charts} chart dirs, {base} the change's base commit.
 */

/** When a gate candidate applies. Paths are relative to the target directory. */
export type Requirement =
  | { readonly file: readonly string[] }
  | { readonly dependency: readonly string[] }
  | { readonly fileContains: { readonly file: string; readonly text: string } };

export interface GateCandidate {
  readonly when?: Requirement;
  /** Checks the whole target. */
  readonly command: string;
  /** Checks only the task's changed files; used per task when present. */
  readonly scoped?: string;
}

export interface Profile {
  readonly id: Language;
  readonly title: string;
  readonly prose: string;
  /**
   * opencode edit-permission globs for the tester (relative to the worktree; `*` matches
   * `/` in opencode, so `*_test.go` matches at any depth).
   */
  readonly testGlobs: readonly string[];
  /** Files that mark a target directory (a package, module, crate or chart). */
  readonly markers: readonly string[];
  /**
   * "dir": gates run in each top-most marker dir ("nested" also keeps marker dirs inside
   * other ones, e.g. separate Go modules). "charts": once at the repo root over all charts.
   */
  readonly targets: "dir" | "nested" | "charts";
  /** Source files the profile's tools check; drives {files} and affected targets. */
  readonly extensions: readonly string[];
  /** Tool directories (relative to the target) prepended to PATH. */
  readonly binDirs: readonly string[];
  /** Gate candidates per type in preference order; the first whose requirement holds wins. */
  readonly gates: Readonly<Record<GateType, readonly GateCandidate[]>>;
  /** Install step per marker dir: the first lockfile present wins. */
  readonly install: readonly { readonly lockfile: string; readonly command: string }[];
  /** Profiles whose target in the same directory this one replaces (tauri runs the cargo gates). */
  readonly supersedes?: readonly Language[];
}

const TS_TEST_GLOBS = [
  "*.test.ts",
  "*.test.tsx",
  "*.spec.ts",
  "*.spec.tsx",
  "*.test.js",
  "*.test.jsx",
  "*.spec.js",
  "*/__tests__/*",
  "test/*",
  "tests/*",
  "*/test/*",
  "*/tests/*",
] as const;

const TS_INSTALL = [
  { lockfile: "bun.lock", command: "bun install --frozen-lockfile" },
  { lockfile: "bun.lockb", command: "bun install --frozen-lockfile" },
  { lockfile: "pnpm-lock.yaml", command: "pnpm install --frozen-lockfile" },
  { lockfile: "yarn.lock", command: "yarn install --immutable" },
  { lockfile: "package-lock.json", command: "npm ci" },
] as const;

const BIOME = { file: ["biome.json", "biome.jsonc"] } as const;
const PRETTIER = {
  file: [
    ".prettierrc",
    ".prettierrc.json",
    ".prettierrc.yaml",
    ".prettierrc.js",
    "prettier.config.js",
    "prettier.config.mjs",
  ],
} as const;
const ESLINT = {
  file: [
    "eslint.config.js",
    "eslint.config.mjs",
    "eslint.config.cjs",
    "eslint.config.ts",
    ".eslintrc",
    ".eslintrc.json",
    ".eslintrc.js",
    ".eslintrc.cjs",
  ],
} as const;

const TS_GATES: Profile["gates"] = {
  format: [
    {
      when: BIOME,
      command: "biome format .",
      scoped: "biome format --no-errors-on-unmatched {files}",
    },
    {
      when: PRETTIER,
      command: "prettier --check .",
      scoped: "prettier --check --ignore-unknown {files}",
    },
    {
      when: { dependency: ["prettier"] },
      command: "prettier --check .",
      scoped: "prettier --check --ignore-unknown {files}",
    },
  ],
  lint: [
    { when: BIOME, command: "biome lint .", scoped: "biome lint --no-errors-on-unmatched {files}" },
    { when: ESLINT, command: "eslint .", scoped: "eslint --no-warn-ignored {files}" },
  ],
  types: [{ when: { file: ["tsconfig.json"] }, command: "tsc --noEmit" }],
  test: [
    { when: { dependency: ["vitest"] }, command: "vitest run" },
    { when: { dependency: ["jest"] }, command: "jest" },
    { when: { file: ["bun.lock", "bun.lockb", "bunfig.toml"] }, command: "bun test" },
  ],
  testAffected: [
    { when: { dependency: ["vitest"] }, command: "vitest related --run {files}" },
    { when: { dependency: ["jest"] }, command: "jest --findRelatedTests {files}" },
    { when: { file: ["bun.lock", "bun.lockb", "bunfig.toml"] }, command: "bun test {testFiles}" },
  ],
};

const TS_BASE = {
  testGlobs: TS_TEST_GLOBS,
  markers: ["package.json"],
  targets: "dir",
  extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
  binDirs: ["node_modules/.bin"],
  gates: TS_GATES,
  install: TS_INSTALL,
} as const;

const RUST_TEST_GLOBS = ["tests/*", "*/tests/*", "*/tests.rs", "benches/*", "*/benches/*"] as const;

/**
 * Tauri's `generate_context!` fails when `build.frontendDist` does not exist yet (a fresh
 * worktree whose frontend was never built). An empty directory satisfies the compile and is
 * invisible to git, so the gates stay check-only. Reads tauri.conf.json only; JSON5/TOML
 * projects keep that directory themselves.
 */
const TAURI_DIST = `node -e 'const fs=require("fs");try{const d=JSON.parse(fs.readFileSync("tauri.conf.json","utf8")).build?.frontendDist;if(typeof d==="string"&&!/^[a-z]+:/i.test(d))fs.mkdirSync(d,{recursive:true})}catch{}'`;
const withDist = (command: string): string => `${TAURI_DIST}; ${command}`;

export const PROFILES: Readonly<Record<Language, Profile>> = {
  typescript: { id: "typescript", title: "TypeScript / JavaScript", prose: typescript, ...TS_BASE },
  react: { id: "react", title: "React", prose: react, ...TS_BASE },
  python: {
    id: "python",
    title: "Python",
    prose: python,
    testGlobs: [
      "test_*.py",
      "*/test_*.py",
      "*_test.py",
      "tests/*",
      "*/tests/*",
      "conftest.py",
      "*/conftest.py",
    ],
    markers: ["pyproject.toml", "requirements.txt"],
    targets: "dir",
    extensions: [".py", ".pyi"],
    binDirs: [".venv/bin"],
    gates: {
      format: [{ command: "ruff format --check .", scoped: "ruff format --check {files}" }],
      lint: [{ command: "ruff check .", scoped: "ruff check {files}" }],
      types: [
        { when: { file: ["pyrightconfig.json"] }, command: "pyright" },
        {
          when: { fileContains: { file: "pyproject.toml", text: "[tool.pyright]" } },
          command: "pyright",
        },
        { command: "mypy --strict ." },
      ],
      test: [{ command: "pytest" }],
      testAffected: [{ command: "pytest {testFiles}" }],
    },
    install: [{ lockfile: "uv.lock", command: "uv sync --frozen" }],
  },
  go: {
    id: "go",
    title: "Go",
    prose: go,
    testGlobs: ["*_test.go", "testdata/*", "*/testdata/*"],
    markers: ["go.mod"],
    targets: "nested",
    extensions: [".go"],
    binDirs: [],
    gates: {
      // gofmt -l exits 0 even when files need formatting, so fail on its output.
      format: [
        {
          command:
            'out="$(gofmt -l .)"; [ -z "$out" ] || { echo "needs gofmt:"; echo "$out"; exit 1; }',
          scoped:
            'out="$(gofmt -l {files})"; [ -z "$out" ] || { echo "needs gofmt:"; echo "$out"; exit 1; }',
        },
      ],
      lint: [{ command: "golangci-lint run", scoped: "golangci-lint run --new-from-rev={base}" }],
      types: [{ command: "go vet ./...", scoped: "go vet {packages}" }],
      test: [{ command: "go test -race ./..." }],
      testAffected: [{ command: "go test -race {packages}" }],
    },
    install: [{ lockfile: "go.sum", command: "go mod download" }],
  },
  rust: {
    id: "rust",
    title: "Rust",
    prose: rust,
    testGlobs: RUST_TEST_GLOBS,
    markers: ["Cargo.toml"],
    targets: "dir",
    extensions: [".rs"],
    binDirs: [],
    gates: {
      format: [{ command: "cargo fmt --all --check" }],
      lint: [{ command: "cargo clippy --all-targets -- -D warnings" }],
      types: [{ command: "cargo check --all-targets" }],
      test: [{ command: "cargo test --workspace" }],
      testAffected: [{ command: "cargo test {crates}" }],
    },
    install: [{ lockfile: "Cargo.lock", command: "cargo fetch --locked" }],
  },
  helm: {
    id: "helm",
    title: "Helm / Kubernetes",
    prose: helm,
    testGlobs: [
      "tests/*_test.yaml",
      "*/tests/*_test.yaml",
      "ci/*-values.yaml",
      "*/ci/*-values.yaml",
    ],
    markers: ["Chart.yaml"],
    targets: "charts",
    extensions: [".yaml", ".yml", ".tpl", ".json"],
    binDirs: [],
    gates: {
      format: [{ command: "yamllint {charts}" }],
      lint: [{ command: "helm lint {charts}" }],
      types: [
        {
          command:
            'for c in {charts}; do helm template "$c" | kubeconform -strict -summary || exit 1; done',
        },
      ],
      test: [{ command: "helm unittest {charts}" }],
      testAffected: [{ command: "helm unittest {charts}" }],
    },
    install: [{ lockfile: "Chart.lock", command: "helm dependency build ." }],
  },
  tauri: {
    id: "tauri",
    title: "Tauri v2",
    prose: tauri,
    testGlobs: RUST_TEST_GLOBS,
    // The src-tauri dir. The frontend is a separate typescript/react target.
    markers: ["tauri.conf.json", "tauri.conf.json5", "Tauri.toml"],
    targets: "dir",
    // Capabilities and config are compiled in: a change to them re-runs the cargo gates.
    extensions: [".rs", ".json", ".json5", ".toml"],
    binDirs: [],
    gates: {
      format: [{ command: "cargo fmt --all --check" }],
      // tauri-build validates the config and every capability's permissions at compile time.
      lint: [{ command: withDist("cargo clippy --all-targets -- -D warnings") }],
      types: [{ command: withDist("cargo check --all-targets") }],
      test: [{ command: withDist("cargo test --workspace") }],
      testAffected: [{ command: withDist("cargo test {crates}") }],
    },
    install: [{ lockfile: "Cargo.lock", command: "cargo fetch --locked" }],
    supersedes: ["rust"],
  },
};

/** The bullet lines of the profile's `## Summary` section. */
export function profileSummary(profile: Profile): string[] {
  const lines = profile.prose.split("\n");
  const start = lines.findIndex((l) => l.trim() === "## Summary");
  if (start === -1) return [];
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## ")) break;
    if (line.startsWith("- ")) out.push(line.slice(2));
  }
  return out;
}

function describe(req: Requirement): string {
  if ("file" in req) return `with ${req.file.join(" or ")}`;
  if ("dependency" in req) return `with dependency ${req.dependency.join(" or ")}`;
  return `when ${req.fileContains.file} has ${req.fileContains.text}`;
}

/** The full standards file: prose plus generated test-path and gate sections. */
export function renderStandard(profile: Profile): string {
  const gates = (Object.keys(profile.gates) as GateType[])
    .map((g) => {
      const options = profile.gates[g].map(
        (c) => `\`${c.command}\`${c.when ? ` (${describe(c.when)})` : ""}`,
      );
      return `- ${g}: ${options.join("; or ")}`;
    })
    .join("\n");
  return `${profile.prose.trimEnd()}

## Test paths (tester edit scope)
${profile.testGlobs.map((g) => `- \`${g}\``).join("\n")}

## Gates (defaults; the repo's own scripts and config overrides win)
${gates}
`;
}

/** Profiles of a repo in canonical order. React stacks on top of TypeScript. */
export function profilesFor(languages: readonly Language[]): Profile[] {
  const set = new Set(languages);
  if (set.has("react")) set.add("typescript");
  return (Object.keys(PROFILES) as Language[]).filter((l) => set.has(l)).map((l) => PROFILES[l]);
}
