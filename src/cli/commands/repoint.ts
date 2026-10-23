import { findWorkspaceRoot, loadConfig } from "../../config/load.ts";
import { PreconditionError, UsageError } from "../../errors.ts";
import { repoint } from "../../git/pointers.ts";
import { CHANGE_ID } from "../../git/repo.ts";
import { type Command, parseCommandArgs } from "../command.ts";
import { ExitCode } from "../exit-codes.ts";

const HELP = `Usage: ai-factory repoint <change-id> [--json]

After the submodule MRs of a change are merged upstream: fetches each submodule, finds the
merged commit (fast-forward, merge commit, Change-Id trailer, or the squash commit with the
same patch-id) and commits the real pointers in the AI repo, replacing the provisional bump.
Pointers whose MR has not merged yet stay provisional; run repoint again later.

Exits ${ExitCode.Precondition} when any pointer is still provisional.`;

export const repointCommand: Command = {
  name: "repoint",
  summary: "Replace provisional submodule pointers after the MRs merged",
  help: HELP,
  async run(args, io) {
    const { values, positionals } = parseCommandArgs(
      "repoint",
      args,
      { json: { type: "boolean", default: false } },
      true,
    );
    const id = positionals[0];
    if (id === undefined || positionals.length > 1)
      throw new UsageError("repoint: expected exactly one <change-id>");
    if (!CHANGE_ID.test(id)) throw new UsageError(`repoint: invalid change id "${id}"`);
    const root = await findWorkspaceRoot(io.cwd);
    if (root === undefined) throw new PreconditionError("not inside a git repository");

    const outcome = await repoint(root, loadConfig(root).config, id);
    const pending = outcome.results.filter((r) => "detail" in r);

    if (values.json) {
      io.out(
        JSON.stringify(
          { change: id, commit: outcome.commit ?? null, results: outcome.results },
          null,
          2,
        ),
      );
    } else {
      for (const r of outcome.results) {
        if ("detail" in r) io.out(`… ${r.repo}: ${r.status} — ${r.detail}`);
        else
          io.out(
            `✓ ${r.repo}: ${r.status} ${r.from.slice(0, 12)} → ${r.to.slice(0, 12)} (${r.method})`,
          );
      }
      io.out(
        outcome.commit
          ? `committed ${outcome.commit.slice(0, 12)} chore(submodules): repoint ${id}`
          : "nothing to commit",
      );
    }
    return pending.length === 0 ? ExitCode.Ok : ExitCode.Precondition;
  },
};
