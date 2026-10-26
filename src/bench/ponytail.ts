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
  {
    // A fix in existing code: does the add-on keep the diff small without skipping the test?
    id: "paginate-fix",
    request:
      "Fix pageOf(items, page, size) in src/page.ts: page numbers start at 1, but page 1 currently skips the first `size` items and the last page can come back empty. Pages past the end return an empty list.",
    files: {
      "package.json": `${JSON.stringify({ name: "bench-app", private: true, type: "module", scripts: { test: "bun test" } }, null, 2)}\n`,
      "bunfig.toml": "[test]\n",
      "tsconfig.json": `${JSON.stringify({ compilerOptions: { strict: true, noEmit: true, module: "esnext", target: "es2022" } }, null, 2)}\n`,
      "src/page.ts":
        "export function pageOf<T>(items: readonly T[], page: number, size: number): T[] {\n  const start = page * size;\n  return items.slice(start, start + size);\n}\n",
      "src/page.test.ts":
        'import { expect, test } from "bun:test";\nimport { pageOf } from "./page";\n\ntest("size limits a page", () => expect(pageOf([1, 2, 3], 0, 2)).toHaveLength(2));\n',
    },
  },
];

/** A Ponytail setting a run uses: off, or on at a level (§12). */
export interface BenchVariant {
  readonly name: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly level?: "lite" | "full" | "ultra";
}

/** "without" plus one "with" variant per level ("with" alone for the default level). */
export function benchVariants(levels: readonly ("lite" | "full" | "ultra")[]): BenchVariant[] {
  const single = levels.length === 1 && levels[0] === "full";
  return [
    ...levels.map(
      (level): BenchVariant =>
        single
          ? { name: "with", label: "With Ponytail", enabled: true, level }
          : { name: `with-${level}`, label: `Ponytail ${level}`, enabled: true, level },
    ),
    { name: "without", label: "Without", enabled: false },
  ];
}

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
  readonly variant: string;
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
  variant: string,
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
  readonly variants?: readonly BenchVariant[];
  /** Called after every run with the results so far, so an interrupted bench keeps them. */
  readonly onRun?: (partial: readonly BenchResult[]) => void;
}

async function oneRun(
  opts: BenchOptions,
  bench: BenchCase,
  v: BenchVariant,
  run: number,
): Promise<RunMetrics> {
  const variant = v.name;
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
    text = setJsonc(text, ["addons", "ponytail", "enabled"], v.enabled);
    if (v.level !== undefined) text = setJsonc(text, ["addons", "ponytail", "level"], v.level);
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

export interface VariantSummary {
  /** Runs that reached `done`; quality metrics are over these only. */
  readonly finished: number;
  readonly total: number;
  readonly metrics: Record<(typeof METRICS)[number], Stat>;
}

export interface BenchResult {
  readonly case: string;
  readonly variants: readonly BenchVariant[];
  readonly runs: readonly RunMetrics[];
  readonly summary: Record<string, VariantSummary>;
}

/**
 * Tokens count every run (they were spent). The quality metrics use finished runs only: an
 * unfinished run has no review and few tests, which would flatter or punish a variant.
 */
export function summarizeVariant(runs: readonly RunMetrics[]): VariantSummary {
  const finished = runs.filter((r) => r.phase === "done");
  return {
    finished: finished.length,
    total: runs.length,
    metrics: Object.fromEntries(
      METRICS.map((m) => [m, stat((m === "tokens" ? runs : finished).map((r) => r[m]))]),
    ) as Record<(typeof METRICS)[number], Stat>,
  };
}

export async function runBench(opts: BenchOptions): Promise<BenchResult[]> {
  const variants = opts.variants ?? benchVariants(["full"]);
  const results: BenchResult[] = [];
  for (const bench of opts.cases ?? BENCH_CASES) {
    const runs: RunMetrics[] = [];
    const result = (): BenchResult => ({
      case: bench.id,
      variants,
      runs,
      summary: Object.fromEntries(
        variants.map((v) => [v.name, summarizeVariant(runs.filter((r) => r.variant === v.name))]),
      ),
    });
    for (let i = 1; i <= opts.runs; i++) {
      for (const v of variants) {
        opts.io.out(`▶ ${bench.id}: run ${i}/${opts.runs} ${v.label}`);
        runs.push(await oneRun(opts, bench, v, i));
        opts.onRun?.([...results, result()]);
      }
    }
    results.push(result());
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
    "Medians with min–max. Tokens count every run; the other metrics only runs that finished. Lower is better for tokens, lines and retries; higher for pass rate and coverage.",
    "",
  ];
  for (const r of results) {
    const perVariant = r.runs.length / Math.max(1, r.variants.length);
    lines.push(
      `## ${r.case} (${perVariant} run${perVariant === 1 ? "" : "s"} per variant)`,
      "",
      `| Metric | ${r.variants.map((v) => v.label).join(" | ")} |`,
      `|---|${r.variants.map(() => "---").join("|")}|`,
      `| finished | ${r.variants.map((v) => `${r.summary[v.name]?.finished ?? 0}/${r.summary[v.name]?.total ?? 0}`).join(" | ")} |`,
    );
    for (const m of METRICS) {
      const cells = r.variants.map((v) => {
        const s = r.summary[v.name]?.metrics[m] ?? { median: 0, min: 0, max: 0 };
        return `${fmt(m, s.median)} (${fmt(m, s.min)}–${fmt(m, s.max)})`;
      });
      lines.push(`| ${m} | ${cells.join(" | ")} |`);
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
