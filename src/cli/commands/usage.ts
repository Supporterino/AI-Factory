import { basename } from "node:path";
import { findWorkspaceRoot } from "../../config/load.ts";
import { PreconditionError, UsageError } from "../../errors.ts";
import {
  summarizeWorkspaceUsage,
  totalTokens,
  type UsageDimension,
  workspaceUsageReport,
} from "../../usage/usage.ts";
import { type Command, type CommandOptions, parseCommandArgs } from "../command.ts";
import { ExitCode } from "../exit-codes.ts";

const DIMENSIONS: readonly UsageDimension[] = ["change", "agent", "model", "day"];

const OPTIONS = {
  since: { type: "string", description: "Include entries from this UTC day (YYYY-MM-DD)" },
  until: { type: "string", description: "Include entries through this UTC day (YYYY-MM-DD)" },
  change: {
    type: "string",
    multiple: true,
    complete: "ledger",
    description: "Only these changes/quick tasks (repeatable or comma list)",
  },
  agent: {
    type: "string",
    multiple: true,
    complete: "agent",
    description: "Only these agents (repeatable or comma list)",
  },
  model: {
    type: "string",
    multiple: true,
    complete: "model",
    description: "Only these models (repeatable or comma list)",
  },
  by: {
    type: "string",
    multiple: true,
    choices: DIMENSIONS,
    description: "Tables to print: change, agent, model, day (default change,agent,model)",
  },
  json: { type: "boolean", default: false, description: "Print the report as JSON" },
} satisfies CommandOptions;

const HELP = `Usage: ai-factory usage [--since <date>] [--until <date>]
                   [--change <id>]... [--agent <id>]... [--model <id>]...
                   [--by <list>] [--json]

Reports every token and cost the factory has spent in this workspace: all changes, quick
tasks and archived runs. The source is .factory/usage/<id>.json; nothing is enforced.

  --since <date>  Include entries from this UTC day (YYYY-MM-DD)
  --until <date>  Include entries through this UTC day (YYYY-MM-DD)
  --change <id>   Only these changes/quick tasks (repeatable or comma list)
  --agent <id>    Only these agents (repeatable or comma list)
  --model <id>    Only these models (repeatable or comma list)
  --by <list>     Tables to print: change, agent, model, day
                  (default: change,agent,model)
  --json          Machine-readable report (always includes every dimension)`;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function date(value: string, name: string): string {
  const parsed = new Date(`${value}T00:00:00Z`);
  if (
    !DATE.test(value) ||
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  )
    throw new UsageError(`usage: ${name} must be a real date in YYYY-MM-DD`);
  return value;
}

function list(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const raw = Array.isArray(value) ? value : [value];
  const items = raw
    .flatMap((item) => item.split(","))
    .map((item) => item.trim())
    .filter((item) => item !== "");
  return items.length === 0 ? undefined : items;
}

export const usageCommand: Command = {
  name: "usage",
  summary: "Report AI token and cost usage across the whole workspace",
  help: HELP,
  options: OPTIONS,
  async run(args, io) {
    const { values } = parseCommandArgs("usage", args, OPTIONS);
    const root = await findWorkspaceRoot(io.cwd);
    if (root === undefined) throw new PreconditionError("not inside a git repository");

    const since = values.since === undefined ? undefined : date(values.since, "--since");
    const until = values.until === undefined ? undefined : date(values.until, "--until");
    if (since !== undefined && until !== undefined && since > until)
      throw new UsageError("usage: --since is after --until");

    const by = [...new Set(list(values.by) ?? ["change", "agent", "model"])];
    const unknown = by.filter((item) => !DIMENSIONS.includes(item as UsageDimension));
    if (unknown.length > 0)
      throw new UsageError(
        `usage: unknown --by value "${unknown[0]}" (expected ${DIMENSIONS.join(", ")})`,
      );

    const changes = list(values.change);
    const agents = list(values.agent);
    const models = list(values.model);
    const summary = summarizeWorkspaceUsage(root, {
      ...(since === undefined ? {} : { since }),
      ...(until === undefined ? {} : { until }),
      ...(changes === undefined ? {} : { changes }),
      ...(agents === undefined ? {} : { agents }),
      ...(models === undefined ? {} : { models }),
    });

    if (values.json) {
      io.out(
        JSON.stringify(
          {
            version: 1,
            workspace: root,
            filters: {
              since: since ?? null,
              until: until ?? null,
              changes: changes ?? [],
              agents: agents ?? [],
              models: models ?? [],
            },
            ...summary,
            totalTokens: totalTokens(summary.total),
            retryTokens: totalTokens(summary.retryOverhead),
            first: summary.first ?? null,
            last: summary.last ?? null,
          },
          null,
          2,
        ),
      );
      return ExitCode.Ok;
    }

    if (summary.sessions === 0 && summary.corrupt.length === 0) {
      io.out("no usage recorded yet");
      return ExitCode.Ok;
    }
    io.out(`AI usage across ${basename(root)}`);
    for (const line of workspaceUsageReport(summary, by as UsageDimension[])) io.out(line);
    if (summary.corrupt.length > 0)
      io.err(`skipped unreadable ledgers: ${summary.corrupt.join(", ")}`);
    return ExitCode.Ok;
  },
};
