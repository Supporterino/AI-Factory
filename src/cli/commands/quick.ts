import { maybeExport } from "../../artifacts/export.ts";
import { UsageError } from "../../errors.ts";
import { quickChangeId, quickTask } from "../../pipeline/quick.ts";
import { type Command, type CommandOptions, parseCommandArgs } from "../command.ts";
import { ExitCode } from "../exit-codes.ts";
import { PROGRESS_OPTIONS, verbosityOf, withPipeline } from "./pipeline-commands.ts";

const HELP = `Usage: ai-factory quick "<task>" [--repo <name>] [--agent <id>] [--no-review] [--verbose|--quiet]

The no-OpenSpec path: create a task/<slug> branch, implement, run the repository gates, run
one review pass, then make one local commit. No spec, no approval hash, and no push.
--agent selects a configured custom implementer. The branch stays checked out so you can
inspect or amend it.

  --verbose         Also print one line per agent tool call and per gate
  --quiet           Only banners, commits, failures and the summary`;

const OPTIONS = {
  repo: {
    type: "string",
    complete: "repo",
    description: "Repo to change (when there are several)",
  },
  agent: { type: "string", complete: "agent", description: "Configured custom implementer" },
  "no-review": { type: "boolean", default: false, description: "Skip the review pass" },
  ...PROGRESS_OPTIONS,
} satisfies CommandOptions;

export const quickCommand: Command = {
  name: "quick",
  summary: "Implement a small task on a branch without an OpenSpec change",
  help: HELP,
  options: OPTIONS,
  positionals: [{ name: "task", variadic: true }],
  async run(args, io) {
    const { values, positionals } = parseCommandArgs("quick", args, OPTIONS, true);
    const task = positionals.join(" ").trim();
    if (task === "") throw new UsageError('quick: expected a task, e.g. "fix the login typo"');
    const verbosity = verbosityOf(values);
    return withPipeline(io, "quick", { verbosity }, async (p) => {
      const result = await quickTask(p, {
        task,
        ...(values.repo === undefined ? {} : { repo: values.repo }),
        ...(values.agent === undefined ? {} : { agent: values.agent }),
        review: !values["no-review"],
      });
      io.out(`${result.ok ? "✓" : "✗"} ${result.repo} ${result.branch}: ${result.detail}`);
      // The ledger exists even when the task failed: the tokens were still spent.
      try {
        const recorded = await maybeExport(p.root, p.config, quickChangeId(task));
        if (recorded !== undefined && recorded.written.length > 0)
          io.out(`  recorded ${recorded.written.join(", ")}`);
      } catch (err) {
        io.err(
          `warning: could not record artifacts (${err instanceof Error ? err.message : String(err)}); run \`ai-factory artifacts sync ${quickChangeId(task)}\``,
        );
      }
      return result.ok ? ExitCode.Ok : ExitCode.GateFailed;
    });
  },
};
