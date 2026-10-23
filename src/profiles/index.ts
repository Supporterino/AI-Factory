import go from "../../templates/standards/go.md" with { type: "text" };
import helm from "../../templates/standards/helm.md" with { type: "text" };
import python from "../../templates/standards/python.md" with { type: "text" };
import react from "../../templates/standards/react.md" with { type: "text" };
import rust from "../../templates/standards/rust.md" with { type: "text" };
import typescript from "../../templates/standards/typescript.md" with { type: "text" };
import type { GateType, Language } from "../config/schema.ts";

/**
 * Language profiles. The prose lives in templates/standards/<id>.md; the machine-readable
 * parts (test globs, gate defaults, install steps) live here and are rendered into the
 * same file, so the agent and the CLI read one source.
 *
 * Gate commands may contain placeholders filled by the gate runner:
 * {files} changed files, {packages} Go packages, {crates} Rust crates, {charts} chart dirs.
 */
export interface Profile {
  readonly id: Language;
  readonly title: string;
  readonly prose: string;
  /**
   * opencode edit-permission globs for the tester (relative to the worktree; `*` matches
   * `/` in opencode, so `*_test.go` matches at any depth).
   */
  readonly testGlobs: readonly string[];
  /** Default gate commands in preference order; the gate resolver picks the first usable. */
  readonly gates: Readonly<Record<GateType, readonly string[]>>;
  /** Worktree install steps: first lockfile present wins. */
  readonly install: readonly { readonly lockfile: string; readonly command: string }[];
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

const TS_GATES = {
  format: ["biome format .", "prettier --check ."],
  lint: ["biome lint .", "eslint ."],
  types: ["tsc --noEmit"],
  test: ["vitest run", "jest", "bun test"],
  testAffected: ["vitest run --changed", "jest --findRelatedTests {files}", "bun test {files}"],
} as const;

export const PROFILES: Readonly<Record<Language, Profile>> = {
  typescript: {
    id: "typescript",
    title: "TypeScript / JavaScript",
    prose: typescript,
    testGlobs: TS_TEST_GLOBS,
    gates: TS_GATES,
    install: TS_INSTALL,
  },
  react: {
    id: "react",
    title: "React",
    prose: react,
    testGlobs: TS_TEST_GLOBS,
    gates: TS_GATES,
    install: TS_INSTALL,
  },
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
    gates: {
      format: ["ruff format --check ."],
      lint: ["ruff check ."],
      types: ["mypy --strict .", "pyright"],
      test: ["pytest"],
      testAffected: ["pytest {files}"],
    },
    install: [{ lockfile: "uv.lock", command: "uv sync --frozen" }],
  },
  go: {
    id: "go",
    title: "Go",
    prose: go,
    testGlobs: ["*_test.go", "testdata/*", "*/testdata/*"],
    gates: {
      // gofmt -l exits 0 even when files need formatting, so test its output.
      format: ['test -z "$(gofmt -l .)"'],
      lint: ["golangci-lint run"],
      types: ["go vet ./..."],
      test: ["go test -race ./..."],
      testAffected: ["go test -race {packages}"],
    },
    install: [{ lockfile: "go.sum", command: "go mod download" }],
  },
  rust: {
    id: "rust",
    title: "Rust",
    prose: rust,
    testGlobs: ["tests/*", "*/tests/*", "*/tests.rs", "benches/*", "*/benches/*"],
    gates: {
      format: ["cargo fmt --all --check"],
      lint: ["cargo clippy --all-targets -- -D warnings"],
      types: ["cargo check --all-targets"],
      test: ["cargo test --workspace"],
      testAffected: ["cargo test {crates}"],
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
    gates: {
      format: ["yamllint {charts}"],
      lint: ["helm lint {charts}"],
      types: ["helm template {charts} | kubeconform -strict -summary"],
      test: ["helm unittest {charts}"],
      testAffected: ["helm unittest {charts}"],
    },
    install: [{ lockfile: "Chart.lock", command: "helm dependency build {charts}" }],
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

/** The full standards file: prose plus generated test-path and gate sections. */
export function renderStandard(profile: Profile): string {
  const gates = (Object.keys(profile.gates) as GateType[])
    .map((g) => `- ${g}: ${profile.gates[g].map((c) => `\`${c}\``).join(" or ")}`)
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
