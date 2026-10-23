import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findWorkspaceRoot } from "../../config/load.ts";
import { CONFIG_FILE } from "../../config/schema.ts";
import { PreconditionError } from "../../errors.ts";
import { commitPaths } from "../../git/commit.ts";
import { ensureClean } from "../../git/repo.ts";
import { updateGraph } from "../../graph/graph.ts";
import { initOpenspec } from "../../openspec/cli.ts";
import { checkTools } from "../../tools.ts";
import {
  backup,
  changesInProgress,
  dirtyOutside,
  formatPlan,
  latestBackup,
  planUpdate,
  requireInstalled,
  restoreBackup,
  UPDATE_COMMIT_PATHS,
} from "../../update/update.ts";
import { FACTORY_VERSION } from "../../version.ts";
import { commitInstall, syncWorkspace } from "../../workspace/sync.ts";
import { type Command, type Io, parseCommandArgs } from "../command.ts";
import { ExitCode } from "../exit-codes.ts";

async function workspaceRoot(io: Io): Promise<string> {
  const root = await findWorkspaceRoot(io.cwd);
  if (root === undefined) throw new PreconditionError("not inside a git repository");
  return root;
}

export const updateCommand: Command = {
  name: "update",
  summary: "Upgrade an installed workspace (templates, config, tools)",
  help: `Usage: ai-factory update [--dry-run] [--tools] [--restore] [--force] [--json]

Upgrades this workspace to the installed factory version, as one local commit
("chore(factory): update to vX.Y.Z") after backing up every file it touches to
.factory/backups/<timestamp>/ (\`ai-factory rollback\` restores it):
- migrates factory.config.jsonc in order (comments are kept);
- re-renders managed files: unchanged ones are replaced, ones you edited are merged
  three-way (conflicts get markers and nothing is committed), deleted ones stay deleted;
- reinstalls hooks; warns when detection differs from the config.

  --dry-run   Print the plan and stop
  --tools     Also refresh OpenSpec's opencode files and rebuild the graph if its format changed
  --restore   Recreate managed files you deleted
  --force     Update although a change is active or queued (it keeps its snapshot)
  --json      Machine-readable result`,
  async run(args, io) {
    const { values } = parseCommandArgs("update", args, {
      "dry-run": { type: "boolean", default: false },
      tools: { type: "boolean", default: false },
      restore: { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    });
    const root = await workspaceRoot(io);
    const lock = requireInstalled(root);

    const inProgress = changesInProgress(root);
    if (inProgress.length > 0 && !values.force) {
      throw new PreconditionError(`changes in progress: ${inProgress.join(", ")}`, [
        "finish or abort them first, or rerun with --force (they keep the definitions they started with)",
      ]);
    }
    await ensureClean(root, "the AI repo");

    const plan = await planUpdate(root, lock, { tools: values.tools, restore: values.restore });
    if (!values.json) for (const line of formatPlan(plan)) io.out(line);
    if (values["dry-run"]) {
      if (values.json)
        io.out(
          JSON.stringify(
            { dryRun: true, ...plan, config: undefined, configText: undefined },
            null,
            2,
          ),
        );
      return ExitCode.Ok;
    }

    const tools = await checkTools(["git", "opencode", "openspec", "graphify"], root);
    for (const t of tools) if (!t.ok) io.out(`warning: ${t.tool}: ${t.problem} → ${t.fix}`);

    const backupDir = backup(root, plan);
    writeFileSync(join(root, CONFIG_FILE), plan.configText);
    if (plan.openspecRefresh) await initOpenspec(root);
    const result = await syncWorkspace(root, plan.config, {
      merge: true,
      ...(values.restore ? { restore: true } : {}),
    });

    if (result.conflicts.length > 0) {
      io.err(
        "update merged your edits but these files have conflicts (markers written, nothing committed):",
      );
      for (const f of result.conflicts) io.err(`  ${f}`);
      io.err("resolve them and commit, or run `ai-factory rollback`");
      return ExitCode.Precondition;
    }
    const commit = await commitInstall(root, `chore(factory): update to v${FACTORY_VERSION}`);
    // A no-op update keeps no backup, so `rollback` still targets the last real one.
    if (commit === undefined) rmSync(backupDir, { recursive: true, force: true });
    if (plan.graphRebuild) {
      const graph = await updateGraph(root, { full: true });
      io.out(
        graph.ok
          ? "graph: rebuilt"
          : `graph: rebuild failed (${graph.error ?? ""}); run \`ai-factory graph --full\``,
      );
    }
    if (values.json) {
      io.out(
        JSON.stringify(
          {
            commit: commit ?? null,
            merged: result.merged,
            migrations: plan.migrations,
            backup: commit ? backupDir : null,
          },
          null,
          2,
        ),
      );
    } else {
      for (const f of result.merged) io.out(`merged your edits: ${f}`);
      io.out(
        commit
          ? `committed ${commit.slice(0, 12)} chore(factory): update to v${FACTORY_VERSION}`
          : "already up to date",
      );
      if (commit) io.out(`backup: ${backupDir}`);
    }
    return ExitCode.Ok;
  },
};

export const rollbackCommand: Command = {
  name: "rollback",
  summary: "Restore the workspace from the latest update backup",
  help: `Usage: ai-factory rollback

Restores every file the latest \`ai-factory update\` touched (including the lock file) from
.factory/backups/ and commits the result. \`git revert\` of the update commit works too.`,
  async run(args, io) {
    parseCommandArgs("rollback", args, {});
    const root = await workspaceRoot(io);
    const latest = latestBackup(root);
    if (latest === undefined) throw new PreconditionError("no update backup to restore");
    const allowed = [...latest.manifest.files, ...latest.manifest.created];
    const dirty = await dirtyOutside(root, allowed);
    if (dirty.length > 0)
      throw new PreconditionError("uncommitted changes outside the update's files", dirty);
    const paths = await restoreBackup(root, latest.dir, latest.manifest);
    const commit = await commitPaths(
      root,
      [...new Set([...paths, ...UPDATE_COMMIT_PATHS])].filter((p) => p !== ""),
      `chore(factory): roll back update to v${latest.manifest.toVersion}`,
    );
    io.out(
      `restored ${latest.manifest.files.length} file(s) from ${latest.dir} (factory ${latest.manifest.fromVersion})`,
    );
    io.out(
      commit
        ? `committed ${commit.slice(0, 12)}`
        : "nothing to commit (the update was not committed)",
    );
    return ExitCode.Ok;
  },
};
