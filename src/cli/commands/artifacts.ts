import { exportArtifacts, syncAllArtifacts } from "../../artifacts/export.ts";
import { isArtifactId } from "../../artifacts/paths.ts";
import { findWorkspaceRoot, loadConfig } from "../../config/load.ts";
import { PreconditionError, UsageError } from "../../errors.ts";
import { type Command, type CommandOptions, parseCommandArgs } from "../command.ts";
import { ExitCode } from "../exit-codes.ts";

const HELP = `Usage: ai-factory artifacts sync [<change-id> | --all] [--dry-run] [--json]

Copies a finished change's final report, approval record and usage ledger from the
gitignored .factory/ into the committed factory-records/ tree, so they survive a fresh
clone or another machine. Requires "artifacts": { "mode": "git" } in factory.config.jsonc.
Logs, paused reports, context packs and run state are never copied.

  <change-id>  Record one change or quick task
  --all        Backfill every id that still has local records (one commit)
  --dry-run    Show what would be written; write and commit nothing
  --json       Machine-readable result`;

const OPTIONS = {
  all: { type: "boolean", default: false, description: "Backfill every local record" },
  "dry-run": { type: "boolean", default: false, description: "Write and commit nothing" },
  json: { type: "boolean", default: false, description: "Print the result as JSON" },
} satisfies CommandOptions;

export const artifactsCommand: Command = {
  name: "artifacts",
  summary: "Commit a change's report, approval and usage records (artifacts.mode: git)",
  help: HELP,
  options: OPTIONS,
  subcommands: ["sync"],
  positionals: [{ name: "change-id", complete: "change" }],
  async run(args, io) {
    const [sub, ...rest] = args;
    if (sub !== "sync") throw new UsageError("artifacts: expected `sync`");
    const { values, positionals } = parseCommandArgs("artifacts sync", rest, OPTIONS, true);
    if (values.all && positionals.length > 0)
      throw new UsageError("artifacts: pass either <change-id> or --all");
    if (!values.all && positionals.length !== 1)
      throw new UsageError("artifacts: expected exactly one <change-id> or --all");

    const root = await findWorkspaceRoot(io.cwd);
    if (root === undefined) throw new PreconditionError("not inside a git repository");
    const { config } = loadConfig(root);

    if (values.all) {
      const result = await syncAllArtifacts(root, config, { dryRun: values["dry-run"] });
      if (values.json) {
        io.out(JSON.stringify({ all: true, ...result }, null, 2));
      } else if (result.written.length === 0) {
        io.out(
          result.changes.length === 0 ? "no local records to sync" : "everything is up to date",
        );
      } else {
        io.out(
          `${values["dry-run"] ? "would record" : "recorded"} ${result.changes.filter((c) => c.written.length > 0).length} change(s), ${result.written.length} file(s)`,
        );
        if (result.commit !== undefined)
          io.out(`committed ${result.commit.slice(0, 12)} docs(factory): backfill`);
      }
      return ExitCode.Ok;
    }

    const id = positionals[0] ?? "";
    if (!isArtifactId(id)) throw new UsageError(`artifacts: invalid change id "${id}"`);
    const result = await exportArtifacts(root, config, id, { dryRun: values["dry-run"] });
    if (values.json) {
      io.out(JSON.stringify(result, null, 2));
    } else if (result.written.length === 0) {
      io.out(`nothing to record for ${id}${result.unchanged.length > 0 ? " (up to date)" : ""}`);
    } else {
      io.out(
        `${values["dry-run"] ? "would write" : "recorded"} ${id}: ${result.written.join(", ")}`,
      );
      if (result.commit !== undefined)
        io.out(`committed ${result.commit.slice(0, 12)} docs(factory): record ${id}`);
    }
    return ExitCode.Ok;
  },
};
