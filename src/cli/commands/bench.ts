import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BENCH_CASES,
  benchMarkdown,
  runBench,
  SESSIONS_PER_RUN,
  TOKENS_PER_RUN_ESTIMATE,
} from "../../bench/ponytail.ts";
import { findWorkspaceRoot, loadConfig } from "../../config/load.ts";
import { PreconditionError, UsageError } from "../../errors.ts";
import { formatTokens } from "../../usage/usage.ts";
import { type Command, type Io, parseCommandArgs } from "../command.ts";
import { ExitCode } from "../exit-codes.ts";

const HELP = `Usage: ai-factory bench ponytail [--runs N] [--yes] [--json]

Runs the bench fixture change N times (default 3) with and without the Ponytail add-on on
your configured models, and writes medians with their spread for tokens, lines changed,
first-attempt gate pass rate, retries, scenario test coverage and review findings to
docs/bench/. Real model calls: it prints an estimate and asks before running.`;

export function benchCommand(cli: (argv: readonly string[], io: Io) => Promise<number>): Command {
  return {
    name: "bench",
    summary: "Measure the Ponytail add-on on real models (A/B)",
    help: HELP,
    async run(args, io) {
      const { values, positionals } = parseCommandArgs(
        "bench",
        args,
        {
          runs: { type: "string", default: "3" },
          yes: { type: "boolean", default: false },
          json: { type: "boolean", default: false },
        },
        true,
      );
      if (positionals[0] !== "ponytail" || positionals.length > 1)
        throw new UsageError("bench: the only benchmark is `ponytail`");
      const runs = Number.parseInt(values.runs, 10);
      if (!Number.isInteger(runs) || runs < 1 || runs > 20)
        throw new UsageError("bench: --runs must be 1–20");
      const root = await findWorkspaceRoot(io.cwd);
      if (root === undefined) throw new PreconditionError("not inside a git repository");
      const { config } = loadConfig(root);

      const sessions = BENCH_CASES.length * runs * 2 * SESSIONS_PER_RUN;
      const tokens = BENCH_CASES.length * runs * 2 * TOKENS_PER_RUN_ESTIMATE;
      io.out(
        `bench ponytail: ${runs} run(s) × 2 variants × ${BENCH_CASES.length} case(s) ≈ ${sessions} agent sessions, ~${formatTokens(tokens)} tokens on ${config.models.implementer} (implementer), ${config.models.architect} (architect), ${config.models.reviewer} (reviewer). The cost depends on your provider's prices for these models.`,
      );
      if (!values.yes) {
        if (io.confirm === undefined)
          throw new PreconditionError("bench makes real model calls; rerun with --yes to confirm");
        if (!(await io.confirm("Run the benchmark?"))) {
          io.out("cancelled");
          return ExitCode.Ok;
        }
      }
      const results = await runBench({ runs, config, cli, io });
      const date = new Date().toISOString().slice(0, 10);
      const dir = join(root, "docs", "bench");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `ponytail-${date}.md`), benchMarkdown(results, config.models, date));
      writeFileSync(
        join(dir, `ponytail-${date}.json`),
        `${JSON.stringify({ date, models: config.models, results }, null, 2)}\n`,
      );
      if (values.json) io.out(JSON.stringify(results, null, 2));
      else io.out(`wrote docs/bench/ponytail-${date}.md`);
      return ExitCode.Ok;
    },
  };
}
