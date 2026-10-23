import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Io } from "../cli/command.ts";
import { setJsonc } from "../config/jsonc.ts";
import type { FactoryConfig } from "../config/schema.ts";
import { git, gitOk } from "../exec.ts";
import type { Handoff } from "../handoff/schema.ts";
import { loadRun } from "../state/run.ts";
import { summarizeUsage, totalTokens } from "../usage/usage.ts";

/**
 * `ai-factory bench ponytail` (§12, "proof, not trust"): runs the same fixture change with
 * and without the Ponytail add-on on real models and compares the outcomes. Each run is a
 * fresh single-repo workspace in a temp dir; the user's model config is copied over.
 */

export interface BenchCase {
  readonly id: string;
  readonly request: string;
  readonly files: Readonly<Record<string, string>>;
}

export const BENCH_CASES: readonly BenchCase[] = [
  {
    id: "slugify",
    request:
      "Add a slugify(text) function in src/slug.ts and export it from src/index.ts. It lowercases the text, turns runs of whitespace into single dashes, removes characters that are not letters, digits or dashes, and trims dashes from both ends.",
    files: {
      "package.json": `${JSON.stringify({ name: "bench-app", private: true, type: "module", scripts: { test: "bun test" } }, null, 2)}\n`,
      "bunfig.toml": "[test]\n",
      "tsconfig.json": `${JSON.stringify({ compilerOptions: { strict: true, noEmit: true, module: "esnext", target: "es2022" } }, null, 2)}\n`,
      "src/index.ts": 'export { sum } from "./sum";\n',
      "src/sum.ts": "export function sum(a: number, b: number): number {\n  return a + b;\n}\n",
      "src/sum.test.ts":
        'import { expect, test } from "bun:test";\nimport { sum } from "./sum";\n\ntest("adds", () => expect(sum(1, 2)).toBe(3));\n',
    },
  },
];

/** Gates for the bench fixture: only tests (the fixture installs no formatter or linter). */
const BENCH_GATES = {
  format: "skip",
  lint: "skip",
  types: "skip",
  test: "bun test",
  testAffected: "bun test",
};

/** Rough planning numbers for the cost prompt (one change ≈ 10 sessions). */
export const SESSIONS_PER_RUN = 10;
export const TOKENS_PER_RUN_ESTIMATE = 250_000;

export interface RunMetrics {
  readonly variant: "with" | "without";
  readonly run: number;
  readonly phase: string;
  readonly tokens: number;
  readonly linesChanged: number;
  /** Share of spec tasks whose first attempt passed the gates. */
  readonly firstPassRate: number;
  readonly retries: number;
  /** Share of spec scenarios named by a test in the change. */
  readonly scenarioCoverage: number;
  readonly reviewFindings: number;
}

export interface Stat {
  readonly median: number;
  readonly min: number;
  readonly max: number;
}

export function stat(values: readonly number[]): Stat {
  if (values.length === 0) return { median: 0, min: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1
      ? (sorted[mid] ?? 0)
      : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  return { median, min: sorted[0] ?? 0, max: sorted.at(-1) ?? 0 };
}

const METRICS = [
  "tokens",
  "linesChanged",
  "firstPassRate",
  "retries",
  "scenarioCoverage",
  "reviewFindings",
] as const;

function walk(dir: string, rel = ""): string[] {
  return readdirSync(join(dir, rel)).flatMap((name) => {
    const r = rel === "" ? name : `${rel}/${name}`;
    return statSync(join(dir, r)).isDirectory() ? walk(dir, r) : [r];
  });
}

async function collect(
  root: string,
  id: string,
  variant: RunMetrics["variant"],
  run: number,
): Promise<RunMetrics> {
  const state = loadRun(root, id);
  const base = state?.branches["."]?.base ?? "HEAD";
  const head = `change/${id}`;
  const stat = await git(
    ["diff", "--numstat", `${base}..${head}`, "--", ".", ":(exclude)openspec"],
    { cwd: root },
  );
  const linesChanged = stat.stdout
    .split("\n")
    .filter(Boolean)
    .reduce((n, l) => n + (Number(l.split("\t")[0]) || 0) + (Number(l.split("\t")[1]) || 0), 0);
  const specTasks = state?.tasks.filter((t) => t.kind === "task") ?? [];
  const scenarios = walk(join(root, "openspec", "specs"))
    .filter((f) => f.endsWith(".md"))
    .flatMap((f) =>
      [
        ...readFileSync(join(root, "openspec", "specs", f), "utf8").matchAll(
          /^#### Scenario:\s*(.+)$/gm,
        ),
      ].map((m) => (m[1] ?? "").trim().toLowerCase()),
    );
  const testFiles = (await gitOk(["diff", "--name-only", `${base}..${head}`], { cwd: root }))
    .split("\n")
    .filter((f) => /\.(test|spec)\.[jt]sx?$/.test(f));
  const testText = (
    await Promise.all(testFiles.map((f) => git(["show", `${head}:${f}`], { cwd: root })))
  )
    .map((r) => r.stdout.toLowerCase())
    .join("\n");
  const covered = scenarios.filter((s) => testText.includes(s)).length;
  const findings = Object.entries(state?.handoffs ?? {})
    .filter(([k]) => k.startsWith("review:"))
    .reduce((n, [, h]) => n + ((h as Partial<Handoff>).findings?.length ?? 0), 0);
  return {
    variant,
    run,
    phase: state?.phase ?? "unknown",
    tokens: totalTokens(summarizeUsage(root, id).total),
    linesChanged,
    firstPassRate:
      specTasks.length === 0
        ? 0
        : specTasks.filter((t) => t.failures === 0).length / specTasks.length,
    retries: (state?.tasks ?? []).reduce((n, t) => n + t.failures, 0),
    scenarioCoverage: scenarios.length === 0 ? 0 : covered / scenarios.length,
    reviewFindings: findings,
  };
}

export interface BenchOptions {
  readonly runs: number;
  readonly config: FactoryConfig;
  /** The CLI entry point, injected to avoid an import cycle. */
  readonly cli: (argv: readonly string[], io: Io) => Promise<number>;
  readonly io: Io;
  readonly cases?: readonly BenchCase[];
}

async function oneRun(
  opts: BenchOptions,
  bench: BenchCase,
  variant: RunMetrics["variant"],
  run: number,
): Promise<RunMetrics> {
  const base = mkdtempSync(join(tmpdir(), `ai-factory-bench-${variant}-`));
  const root = join(base, "app");
  try {
    for (const [rel, content] of Object.entries(bench.files)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), content);
    }
    for (const args of [
      ["init", "-q", "-b", "main"],
      ["add", "-A"],
      ["commit", "-q", "-m", "chore: bench fixture"],
    ]) {
      await gitOk(args, { cwd: root });
    }
    const quiet: Io = {
      ...opts.io,
      cwd: root,
      out: () => {},
      err: (t) => opts.io.err(`  [${variant} #${run}] ${t}`),
    };
    await opts.cli(["init", "--no-graph"], quiet);
    const file = join(root, "factory.config.jsonc");
    let text = readFileSync(file, "utf8");
    text = setJsonc(text, ["models"], opts.config.models);
    text = setJsonc(text, ["addons", "ponytail", "enabled"], variant === "with");
    // The single repo is named after its directory ("app").
    text = setJsonc(text, ["gates", "overrides"], { app: BENCH_GATES });
    writeFileSync(file, text);
    await opts.cli(["init", "--no-graph"], quiet);
    await gitOk(["add", "-A"], { cwd: root });
    await git(["commit", "-q", "-m", "chore: bench config"], { cwd: root });
    await opts.cli(["run", bench.request], quiet);
    const id = readdirSync(join(root, ".factory", "runs"))
      .find((f) => f.endsWith(".json"))
      ?.replace(/\.json$/, "");
    if (id === undefined) throw new Error("bench: the run did not create a change");
    await opts.cli(["approve", id], quiet);
    return await collect(root, id, variant, run);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

export interface BenchResult {
  readonly case: string;
  readonly runs: readonly RunMetrics[];
  readonly summary: Record<"with" | "without", Record<(typeof METRICS)[number], Stat>>;
}

export async function runBench(opts: BenchOptions): Promise<BenchResult[]> {
  const results: BenchResult[] = [];
  for (const bench of opts.cases ?? BENCH_CASES) {
    const runs: RunMetrics[] = [];
    for (let i = 1; i <= opts.runs; i++) {
      for (const variant of ["with", "without"] as const) {
        opts.io.out(`▶ ${bench.id}: run ${i}/${opts.runs} ${variant} Ponytail`);
        runs.push(await oneRun(opts, bench, variant, i));
      }
    }
    const summarize = (variant: "with" | "without") =>
      Object.fromEntries(
        METRICS.map((m) => [m, stat(runs.filter((r) => r.variant === variant).map((r) => r[m]))]),
      ) as Record<(typeof METRICS)[number], Stat>;
    results.push({
      case: bench.id,
      runs,
      summary: { with: summarize("with"), without: summarize("without") },
    });
  }
  return results;
}

const fmt = (m: (typeof METRICS)[number], v: number): string =>
  m === "firstPassRate" || m === "scenarioCoverage"
    ? `${Math.round(v * 100)}%`
    : m === "tokens"
      ? `${Math.round(v / 1000)}k`
      : String(Math.round(v * 10) / 10);

export function benchMarkdown(
  results: readonly BenchResult[],
  models: FactoryConfig["models"],
  date: string,
): string {
  const lines = [
    `# Ponytail bench (${date})`,
    "",
    `Models: implementer \`${models.implementer}\`, reviewer \`${models.reviewer}\`, architect \`${models.architect}\`.`,
    "Medians with min–max over the runs. Lower is better for tokens, lines and retries; higher for pass rate and coverage.",
    "",
  ];
  for (const r of results) {
    lines.push(
      `## ${r.case} (${r.runs.length / 2} run${r.runs.length === 2 ? "" : "s"} per variant)`,
      "",
      "| Metric | With Ponytail | Without |",
      "|---|---|---|",
    );
    for (const m of METRICS) {
      const w = r.summary.with[m];
      const o = r.summary.without[m];
      lines.push(
        `| ${m} | ${fmt(m, w.median)} (${fmt(m, w.min)}–${fmt(m, w.max)}) | ${fmt(m, o.median)} (${fmt(m, o.min)}–${fmt(m, o.max)}) |`,
      );
    }
    const unfinished = r.runs
      .filter((x) => x.phase !== "done")
      .map((x) => `${x.variant} #${x.run}: ${x.phase}`);
    lines.push(
      "",
      unfinished.length > 0
        ? `Runs that did not finish: ${unfinished.join(", ")}.`
        : "All runs finished.",
      "",
    );
  }
  return lines.join("\n");
}
