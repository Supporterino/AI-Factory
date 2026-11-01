import { PreconditionError, UsageError } from "../../errors.ts";
import type { Finding } from "../../handoff/schema.ts";
import { reapprove, reword } from "../../pipeline/reword.ts";
import { loadRun } from "../../state/run.ts";
import { type Command, type CommandOptions, parseCommandArgs } from "../command.ts";
import { ExitCode } from "../exit-codes.ts";
import { changeIdArg, PROGRESS_OPTIONS, verbosityOf, withPipeline } from "./pipeline-commands.ts";

/** `--finding 1,3` indexes the run's recorded spec findings (1-based). */
function selectedFindings(
  command: string,
  all: readonly Finding[],
  value: string | undefined,
): Finding[] {
  if (value === undefined) return [...all];
  const indexes = value
    .split(",")
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((n) => Number.isInteger(n));
  if (indexes.length === 0)
    throw new UsageError(`${command}: --finding expects 1-based numbers, e.g. --finding 1,3`);
  for (const index of indexes) {
    if (index < 1 || index > all.length)
      throw new UsageError(
        `${command}: finding ${index} does not exist (${all.length} recorded spec finding${all.length === 1 ? "" : "s"})`,
      );
  }
  return [...new Set(indexes)].map((index) => all[index - 1] as Finding);
}

const REWORD_OPTIONS = {
  finding: {
    type: "string",
    description: "Comma-separated spec findings to apply (default: all)",
  },
  prompt: {
    type: "string",
    description: "Extra instruction for the architect",
  },
  "dry-run": {
    type: "boolean",
    default: false,
    description: "Run the architect, show the result, then restore the spec",
  },
  ...PROGRESS_OPTIONS,
} satisfies CommandOptions;

const REAPPROVE_OPTIONS = {
  "dry-run": {
    type: "boolean",
    default: false,
    description: "Validate and show the diff without committing or re-stamping",
  },
  ...PROGRESS_OPTIONS,
} satisfies CommandOptions;

export const rewordCommand: Command = {
  name: "reword",
  summary: "Let the architect apply review findings to an approved spec",
  options: REWORD_OPTIONS,
  positionals: [{ name: "change-id", complete: "change" }],
  help: `Usage: ai-factory reword <change-id> [--finding <n,...>] [--prompt <text>] [--dry-run] [--verbose|--quiet]

Runs one architect session over the change's spec to apply the review findings recorded when
the change paused. Only wording and clarity may change; the task list (ids, deps, touches)
must stay as approved. The result is validated, committed on \`change/<id>\` as
\`docs(spec): reword <id>\` and the approval is re-stamped with the new commit and hash.
Continue with \`ai-factory resume <id>\`.

  --finding <n,...>  Apply only these findings (1-based, as listed at the pause); the rest
                     stay recorded and keep the change paused
  --prompt <text>    Add an instruction for the architect
  --dry-run          Run the architect, show the diff, then restore the spec
  --verbose          Also print one line per agent tool call
  --quiet            Only phase banners and the result`,
  async run(args, io) {
    const { values, positionals } = parseCommandArgs("reword", args, REWORD_OPTIONS, true);
    const id = changeIdArg("reword", positionals);
    const verbosity = verbosityOf(values);
    return withPipeline(io, id, { verbosity }, async (p) => {
      const run = loadRun(p.root, id);
      if (run === undefined)
        throw new PreconditionError(`${id} has no run state`, [
          `run \`ai-factory run "..."\` or \`ai-factory adopt ${id}\` first`,
        ]);
      const findings = selectedFindings("reword", run.specFindings, values.finding);
      const result = await reword(p, id, {
        findings,
        ...(values.prompt === undefined ? {} : { request: values.prompt }),
        ...(values["dry-run"] === true ? { dryRun: true } : {}),
      });
      if (!result.changed && values["dry-run"] !== true)
        io.out(`${id}: no spec change; the findings are still recorded`);
      return ExitCode.Ok;
    });
  },
};

export const reapproveCommand: Command = {
  name: "reapprove",
  summary: "Accept a spec edit after approval and re-stamp the approval hash",
  options: REAPPROVE_OPTIONS,
  positionals: [{ name: "change-id", complete: "change" }],
  help: `Usage: ai-factory reapprove <change-id> [--dry-run] [--verbose|--quiet]

Validates the change's current spec, commits it on \`change/<id>\` as \`docs(spec): reword <id>\`
and records a new approval (new spec commit and hash, same approver). The run's tasks and their
progress are kept, so the approved task plan (ids, deps, touches) cannot change; start a new
change for a new plan. Use this after editing the spec by hand; use \`reword\` to let the
architect apply review findings. Continue with \`ai-factory resume <id>\`.

  --dry-run    Validate and show the diff without committing or re-stamping
  --verbose    Also print one line per agent tool call
  --quiet      Only phase banners and the result`,
  async run(args, io) {
    const { values, positionals } = parseCommandArgs("reapprove", args, REAPPROVE_OPTIONS, true);
    const id = changeIdArg("reapprove", positionals);
    const verbosity = verbosityOf(values);
    return withPipeline(io, id, { verbosity }, async (p) => {
      await reapprove(p, id, values["dry-run"] === true ? { dryRun: true } : {});
      return ExitCode.Ok;
    });
  },
};
