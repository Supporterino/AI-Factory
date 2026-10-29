import { UsageError } from "../../errors.ts";
import { refineRequest } from "../../pipeline/refine.ts";
import { type Command, parseCommandArgs } from "../command.ts";
import { ExitCode } from "../exit-codes.ts";

const HELP = `Usage: ai-factory refine "<request>"

Ask a few scope, verification and constraint questions, then write a refined request to
.factory/requests/<slug>.md. Nothing is designed or implemented. Feed it to the pipeline
with \`ai-factory run --request .factory/requests/<slug>.md\`.`;

export const refineCommand: Command = {
  name: "refine",
  summary: "Clarify a vague request before it becomes a spec",
  help: HELP,
  options: {},
  positionals: [{ name: "request", variadic: true }],
  async run(args, io) {
    const { positionals } = parseCommandArgs("refine", args, {}, true);
    const request = positionals.join(" ").trim();
    if (request === "") throw new UsageError('refine: expected a request, e.g. "add search"');
    const { path } = await refineRequest(io, request);
    io.out(`refined request: ${path}`);
    io.out(`next: ai-factory run --request ${path}`);
    return ExitCode.Ok;
  },
};
