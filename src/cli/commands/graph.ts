import { existsSync } from "node:fs";
import { join } from "node:path";
import { findWorkspaceRoot } from "../../config/load.ts";
import { PreconditionError } from "../../errors.ts";
import { graphFile, updateGraph } from "../../graph/graph.ts";
import { LOCK_FILE } from "../../lock/lock.ts";
import { checkTool } from "../../tools.ts";
import { type Command, type CommandOptions, parseCommandArgs } from "../command.ts";
import { ExitCode } from "../exit-codes.ts";

const OPTIONS = {
  full: { type: "boolean", default: false, description: "Rebuild the graph from scratch" },
  json: { type: "boolean", default: false, description: "Print the result as JSON" },
} satisfies CommandOptions;

export const graphCommand: Command = {
  name: "graph",
  summary: "Build or incrementally update the workspace graph",
  options: OPTIONS,
  help: `Usage: ai-factory graph [--full] [--json]

Updates the one Graphify graph over the workspace and every submodule (graphify-out/,
gitignored). Incremental by default (changed files only); --full rebuilds from scratch.
The pipeline also updates it after every task merge, so this is rarely needed by hand.`,
  async run(args, io) {
    const { values } = parseCommandArgs("graph", args, OPTIONS);
    const root = await findWorkspaceRoot(io.cwd);
    if (root === undefined) throw new PreconditionError("not inside a git repository");
    if (!existsSync(join(root, LOCK_FILE)))
      throw new PreconditionError("ai-factory is not installed here", ["run `ai-factory init`"]);
    const tool = await checkTool("graphify", root);
    if (!tool.ok) throw new PreconditionError(`graphify: ${tool.problem}`, [tool.fix]);

    const full = values.full || !existsSync(graphFile(root));
    const result = await updateGraph(root, { full });
    if (values.json) {
      io.out(JSON.stringify(result, null, 2));
    } else if (result.ok && result.meta) {
      const m = result.meta;
      io.out(
        `graph ${m.full ? "built" : "updated"}: ${m.nodes} nodes, ${m.links} links in ${(m.durationMs / 1000).toFixed(1)}s`,
      );
    } else {
      io.err(`graph update failed: ${result.error ?? "unknown"}`);
    }
    return result.ok ? ExitCode.Ok : ExitCode.Failure;
  },
};
