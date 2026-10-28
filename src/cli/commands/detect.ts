import { existsSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findWorkspaceRoot, loadConfig, parseConfigText } from "../../config/load.ts";
import { CONFIG_FILE } from "../../config/schema.ts";
import { applyChanges } from "../../detect/apply.ts";
import { diffDetection, formatChange } from "../../detect/diff.ts";
import { detectWorkspace } from "../../detect/workspace.ts";
import { PreconditionError } from "../../errors.ts";
import { ensureNotNewer, readLock } from "../../lock/lock.ts";
import { FACTORY_VERSION } from "../../version.ts";
import {
  commitInstall,
  dirtyInstallPaths,
  planWorkspace,
  syncWorkspace,
} from "../../workspace/sync.ts";
import { type Command, type CommandOptions, parseCommandArgs } from "../command.ts";
import { ExitCode } from "../exit-codes.ts";

const HELP = `Usage: ai-factory detect [--apply [--no-commit] [--allow-downgrade]] [--check] [--json]

Re-detects the layout, repos, languages and contracts and shows the difference
from ${CONFIG_FILE}. Detection only proposes; nothing is written without --apply.

Options:
  --apply   Write the shown changes into ${CONFIG_FILE} (comments are kept), regenerate
            implementer agents, scopes, OpenSpec context and hooks, and commit the result
  --no-commit  With --apply: leave the changes uncommitted
  --allow-downgrade  With --apply: let this (older) version rewrite a newer install
  --check   Exit with code ${ExitCode.Drift} when there are differences
  --json    Print the detection and the changes as JSON
  -h, --help`;

const OPTIONS = {
  apply: { type: "boolean", default: false, description: "Write the detected changes and commit" },
  check: {
    type: "boolean",
    default: false,
    description: "Exit 10 when detection differs from the config",
  },
  json: { type: "boolean", default: false, description: "Print the result as JSON" },
  "no-commit": {
    type: "boolean",
    default: false,
    description: "With --apply: leave it uncommitted",
  },
  "allow-downgrade": {
    type: "boolean",
    default: false,
    description: "Let an older factory rewrite a newer install",
  },
} satisfies CommandOptions;

export const detectCommand: Command = {
  name: "detect",
  summary: "Re-detect repos, languages and contracts; diff against the config",
  help: HELP,
  options: OPTIONS,
  async run(args, io) {
    const { values } = parseCommandArgs("detect", args, OPTIONS);

    const root = await findWorkspaceRoot(io.cwd);
    if (root === undefined) {
      throw new PreconditionError("not inside a git repository", [
        "run ai-factory from the workspace (AI repo or single repo)",
      ]);
    }
    const hasConfig = existsSync(join(root, CONFIG_FILE));
    const loaded = hasConfig ? loadConfig(root) : undefined;
    if (values.apply && loaded === undefined) {
      throw new PreconditionError(`no ${CONFIG_FILE} to apply to`, ["run `ai-factory init` first"]);
    }
    if (values.apply) ensureNotNewer(readLock(root), values["allow-downgrade"]);

    const detection = await detectWorkspace(root);
    const changes = diffDetection(detection, loaded?.config);

    let applied = false;
    let commit: string | undefined;
    if (values.apply && loaded !== undefined && changes.length > 0) {
      const installed = readLock(root) !== undefined;
      if (installed && !values["no-commit"]) {
        const dirty = await dirtyInstallPaths(root, [CONFIG_FILE]);
        if (dirty.length > 0) {
          throw new PreconditionError("uncommitted changes in factory files", [
            ...dirty,
            "commit or stash them, or rerun with --no-commit",
          ]);
        }
      }
      const next = applyChanges(loaded.text, loaded.config, changes);
      const nextConfig = parseConfigText(next, CONFIG_FILE);
      // Plan first: a conflict stops before the config is written (audit G3).
      if (installed) planWorkspace(root, nextConfig, { merge: true });
      const tmp = `${loaded.file}.tmp`;
      writeFileSync(tmp, next);
      renameSync(tmp, loaded.file);
      applied = true;
      // Agents, edit scopes, OpenSpec context and hooks follow the config (§10). Agents the
      // user edited are merged like on `update`, so new standards arrive in them too.
      if (installed) {
        let result: Awaited<ReturnType<typeof syncWorkspace>>;
        try {
          result = await syncWorkspace(root, nextConfig, { merge: true });
        } catch (err) {
          writeFileSync(loaded.file, loaded.text);
          throw err;
        }
        if (result.conflicts.length > 0) {
          io.err("detect merged your edits but these files have conflicts (nothing committed):");
          for (const f of result.conflicts) io.err(`  ${f}`);
          io.err("resolve them and commit, or `git checkout -- .` to drop the change");
          return ExitCode.Precondition;
        }
        if (!values["no-commit"]) {
          commit = await commitInstall(
            root,
            `chore(factory): apply detected changes (v${FACTORY_VERSION})`,
          );
        }
      }
    }

    if (values.json) {
      io.out(
        JSON.stringify(
          { root, hasConfig, detection, changes, applied, commit: commit ?? null },
          null,
          2,
        ),
      );
    } else {
      for (const note of detection.notes) io.out(`note: ${note}`);
      if (!hasConfig)
        io.out(`no ${CONFIG_FILE} yet; this is what \`ai-factory init\` would propose:`);
      if (changes.length === 0) {
        io.out("No differences.");
      } else {
        for (const change of changes) io.out(formatChange(change));
        if (applied) {
          io.out(
            `Updated ${CONFIG_FILE} (${changes.length} change${changes.length === 1 ? "" : "s"}).`,
          );
          if (commit) io.out(`committed ${commit.slice(0, 12)}`);
        } else if (hasConfig) {
          io.out("Run `ai-factory detect --apply` to write these changes.");
        }
      }
    }

    return values.check && changes.length > 0 && !applied ? ExitCode.Drift : ExitCode.Ok;
  },
};
