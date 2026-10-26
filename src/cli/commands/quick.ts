import { UsageError } from "../../errors.ts";
import { quickTask } from "../../pipeline/quick.ts";
import { type Command, parseCommandArgs } from "../command.ts";
import { ExitCode } from "../exit-codes.ts";
import { withPipeline } from "./pipeline-commands.ts";

const HELP = `Usage: ai-factory quick "<task>" [--repo <name>] [--agent <id>] [--no-review]

The no-OpenSpec path: create a task/<slug> branch, implement, run the repository gates, run
one review pass, then make one local commit. No spec, no approval hash, and no push.
--agent selects a configured custom implementer. The branch stays checked out so you can
inspect or amend it.`;

export const quickCommand: Command = {
  name: "quick",
  summary: "Implement a small task on a branch without an OpenSpec change",
  help: HELP,
  async run(args, io) {
    const { values, positionals } = parseCommandArgs(
      "quick",
      args,
      {
        repo: { type: "string" },
        agent: { type: "string" },
        "no-review": { type: "boolean", default: false },
      },
      true,
    );
    const task = positionals.join(" ").trim();
    if (task === "") throw new UsageError('quick: expected a task, e.g. "fix the login typo"');
    return withPipeline(io, "quick", async (p) => {
      const result = await quickTask(p, {
        task,
        ...(values.repo === undefined ? {} : { repo: values.repo }),
        ...(values.agent === undefined ? {} : { agent: values.agent }),
        review: !values["no-review"],
      });
      io.out(`${result.ok ? "✓" : "✗"} ${result.repo} ${result.branch}: ${result.detail}`);
      return result.ok ? ExitCode.Ok : ExitCode.GateFailed;
    });
  },
};
