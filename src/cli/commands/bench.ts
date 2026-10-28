import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BENCH_CASES,
  type BenchResult,
  benchMarkdown,
  benchVariants,
  runBench,
  SESSIONS_PER_RUN,
  TOKENS_PER_RUN_ESTIMATE,
} from "../../bench/ponytail.ts";
import { findWorkspaceRoot, loadConfig } from "../../config/load.ts";
import { PreconditionError, UsageError } from "../../errors.ts";
import { formatTokens } from "../../usage/usage.ts";
import { type Command, type CommandOptions, type Io, parseCommandArgs } from "../command.ts";
import { ExitCode } from "../exit-codes.ts";

const HELP = `Usage: ai-factory bench ponytail [--runs N] [--case ID] [--levels L,…] [--yes] [--json]

Runs each bench case (${BENCH_CASES.map((c) => c.id).join(", ")}) N times (default 3) with and
without the Ponytail add-on on your configured models, and writes medians with their spread
for tokens, lines changed, first-attempt gate pass rate, retries, scenario test coverage and
review findings to docs/bench/. Results are saved after every run.
Real model calls: it prints an estimate and asks before running.

  --case ID      Only this case (repeatable as a comma list)
  --levels L,…   Ponytail levels to compare against "without" (lite, full, ultra; default full)`;

const LEVELS = ["lite", "full", "ultra"] as const;

const OPTIONS = {
  runs: { type: "string", default: "3", description: "Runs per case (1-20)" },
  case: {
    type: "string",
    choices: BENCH_CASES.map((c) => c.id),
    description: "Only this bench case (comma list)",
  },
  levels: {
    type: "string",
    default: "full",
    choices: LEVELS,
    description: "Ponytail levels to compare (comma list)",
  },
  yes: { type: "boolean", default: false, description: "Confirm the real model calls" },
  json: { type: "boolean", default: false, description: "Print the results as JSON" },
} satisfies CommandOptions;

export function benchCommand(cli: (argv: readonly string[], io: Io) => Promise<number>): Command {
  return {
    name: "bench",
    summary: "Measure the Ponytail add-on on real models (A/B)",
    help: HELP,
    options: OPTIONS,
    subcommands: ["ponytail"],
    async run(args, io) {
      const { values, positionals } = parseCommandArgs("bench", args, OPTIONS, true);
      if (positionals[0] !== "ponytail" || positionals.length > 1)
        throw new UsageError("bench: the only benchmark is `ponytail`");
      const runs = Number.parseInt(values.runs, 10);
      if (!Number.isInteger(runs) || runs < 1 || runs > 20)
        throw new UsageError("bench: --runs must be 1–20");
      const root = await findWorkspaceRoot(io.cwd);
      if (root === undefined) throw new PreconditionError("not inside a git repository");
      const { config } = loadConfig(root);

      const wanted = values.case?.split(",").map((c) => c.trim()) ?? [];
      const cases =
        wanted.length === 0 ? BENCH_CASES : BENCH_CASES.filter((c) => wanted.includes(c.id));
      if (cases.length < wanted.length)
        throw new UsageError(
          `bench: unknown case (known: ${BENCH_CASES.map((c) => c.id).join(", ")})`,
        );
      const levels = values.levels.split(",").map((l) => l.trim());
      if (
        levels.length === 0 ||
        !levels.every((l): l is (typeof LEVELS)[number] =>
          (LEVELS as readonly string[]).includes(l),
        )
      )
        throw new UsageError(`bench: --levels takes ${LEVELS.join(", ")}`);
      const variants = benchVariants(levels as (typeof LEVELS)[number][]);

      const n = cases.length * runs * variants.length;
      io.out(
        `bench ponytail: ${runs} run(s) × ${variants.length} variants × ${cases.length} case(s) ≈ ${n * SESSIONS_PER_RUN} agent sessions, ~${formatTokens(n * TOKENS_PER_RUN_ESTIMATE)} tokens on ${config.models.implementer} (implementer), ${config.models.architect} (architect), ${config.models.reviewer} (reviewer). The cost depends on your provider's prices for these models.`,
      );
      if (!values.yes) {
        if (io.confirm === undefined)
          throw new PreconditionError("bench makes real model calls; rerun with --yes to confirm");
        if (!(await io.confirm("Run the benchmark?"))) {
          io.out("cancelled");
          return ExitCode.Ok;
        }
      }
      const date = new Date().toISOString().slice(0, 10);
      const dir = join(root, "docs", "bench");
      mkdirSync(dir, { recursive: true });
      // Saved after every run: an interrupted bench keeps what it paid for (audit G1).
      const save = (results: readonly BenchResult[], complete: boolean): void => {
        writeFileSync(
          join(dir, `ponytail-${date}.json`),
          `${JSON.stringify({ date, complete, models: config.models, results }, null, 2)}\n`,
        );
        writeFileSync(
          join(dir, `ponytail-${date}.md`),
          benchMarkdown(results, config.models, date),
        );
      };
      const results = await runBench({
        runs,
        config,
        cli,
        io,
        cases,
        variants,
        onRun: (partial) => save(partial, false),
      });
      save(results, true);
      if (values.json) io.out(JSON.stringify(results, null, 2));
      else io.out(`wrote docs/bench/ponytail-${date}.md`);
      return ExitCode.Ok;
    },
  };
}
