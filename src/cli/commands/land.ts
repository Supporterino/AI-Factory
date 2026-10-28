import { findWorkspaceRoot, loadConfig } from "../../config/load.ts";
import { PreconditionError, UsageError } from "../../errors.ts";
import { CHANGE_ID } from "../../git/repo.ts";
import { landChange } from "../../pipeline/land.ts";
import { type Command, type CommandOptions, parseCommandArgs } from "../command.ts";
import { ExitCode } from "../exit-codes.ts";

const OPTIONS = {
  "dry-run": {
    type: "boolean",
    default: false,
    description: "Show the merges and cleanup without changing anything",
  },
  json: { type: "boolean", default: false, description: "Print the result as JSON" },
} satisfies CommandOptions;

const HELP = `Usage: ai-factory land <change-id> [--dry-run] [--json]

Merges a finished change back into its base branches and removes what it no longer needs.
The factory still never pushes: every merge stays local.

For each touched submodule it merges \`change/<id>\` into the repo's tracked/default branch,
updates the AI repo's submodule pointers, then merges the AI repo's \`change/<id>\` into its
base branch. It then deletes the change and leftover task branches and removes worktrees,
context packs, approvals, session context and run state.

Kept for the record: the final report, the token usage ledger and the redacted logs.

  --dry-run   Print the plan only; merge and delete nothing
  --json      Machine-readable result

The change must be done. The workspace and the change's worktrees must be clean; a merge
conflict aborts that merge and leaves the change branches in place.`;

export const landCommand: Command = {
  name: "land",
  summary: "Merge a finished change into its base branches and clean up",
  help: HELP,
  options: OPTIONS,
  positionals: [{ name: "change-id", complete: "change" }],
  async run(args, io) {
    const { values, positionals } = parseCommandArgs("land", args, OPTIONS, true);
    const id = positionals[0];
    if (id === undefined || positionals.length > 1)
      throw new UsageError("land: expected exactly one <change-id>");
    if (!CHANGE_ID.test(id)) throw new UsageError(`land: invalid change id "${id}"`);
    const root = await findWorkspaceRoot(io.cwd);
    if (root === undefined) throw new PreconditionError("not inside a git repository");
    const { config } = loadConfig(root);

    const outcome = await landChange(root, config, id, { dryRun: values["dry-run"] });
    if (values.json) {
      io.out(JSON.stringify(outcome, null, 2));
      return outcome.keptBranches.length > 0 ? ExitCode.Precondition : ExitCode.Ok;
    }

    io.out(`${outcome.dryRun ? "land plan" : "landed"} ${id}`);
    for (const repo of outcome.repos) {
      const where = repo.path === "." ? "AI repo" : repo.path;
      const commit = repo.commit === undefined ? "" : ` ${repo.commit.slice(0, 12)}`;
      io.out(
        `  ${repo.status === "missing" ? "…" : "✓"} ${where}: ${repo.target} <- ${repo.branch} (${repo.status}${commit})`,
      );
    }
    if (outcome.pointerCommit !== undefined)
      io.out(`  ✓ submodule pointers: ${outcome.pointerCommit.slice(0, 12)}`);
    if (outcome.dryRun) {
      io.out(`  would clean: ${outcome.cleaned.join(", ")}`);
      io.out(`  would keep: ${outcome.kept.join(", ")}`);
      io.out("dry run: nothing was merged or deleted");
      return ExitCode.Ok;
    }
    if (outcome.deletedBranches.length > 0)
      io.out(`  ✓ deleted branches: ${outcome.deletedBranches.join(", ")}`);
    if (outcome.keptBranches.length > 0)
      io.err(`  ! kept branches (not merged): ${outcome.keptBranches.join(", ")}`);
    if (outcome.cleaned.length > 0) io.out(`  ✓ cleaned: ${outcome.cleaned.join(", ")}`);
    if (outcome.kept.length > 0) io.out(`  kept: ${outcome.kept.join(", ")}`);
    return outcome.keptBranches.length > 0 ? ExitCode.Precondition : ExitCode.Ok;
  },
};
