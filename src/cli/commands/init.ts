import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findWorkspaceRoot, loadConfig, parseConfigText } from "../../config/load.ts";
import { renderInitialConfig } from "../../config/render.ts";
import { CONFIG_FILE } from "../../config/schema.ts";
import { detectWorkspace } from "../../detect/workspace.ts";
import { PreconditionError } from "../../errors.ts";
import { gitOk } from "../../exec.ts";
import { graphFile, updateGraph } from "../../graph/graph.ts";
import type { SyncAction } from "../../managed/sync.ts";
import { renderOpenspecTools } from "../../openspec/cli.ts";
import { checkTools, type ToolName } from "../../tools.ts";
import { FACTORY_VERSION } from "../../version.ts";
import {
  commitInstall,
  dirtyInstallPaths,
  planWorkspace,
  syncWorkspace,
} from "../../workspace/sync.ts";
import { type Command, parseCommandArgs } from "../command.ts";
import { ExitCode } from "../exit-codes.ts";

const HELP = `Usage: ai-factory init [--force] [--no-commit] [--no-graph] [--json]

Installs the factory into the workspace: detects repos, languages and contracts, checks
the tools, runs \`openspec init\` for opencode, renders agents, standards and config,
installs pre-push hooks, writes ${CONFIG_FILE} and factory.lock.json, updates .gitignore
and commits the result in the AI repo. Safe to run again: an unchanged workspace gives
no diff and no commit.

Options:
  --force       Overwrite existing files that ai-factory did not create
  --no-commit   Leave the changes uncommitted
  --no-graph    Skip building the workspace graph (build it later with \`ai-factory graph\`)
  --json        Print the result as JSON
  -h, --help`;

const REQUIRED_TOOLS: readonly ToolName[] = ["git", "opencode", "openspec", "graphify"];

const REPORTED: Partial<Record<SyncAction, string>> = {
  create: "created",
  update: "updated",
  overwrite: "overwritten (--force)",
  remove: "removed",
  "keep-user-edit": "kept your edit (run `ai-factory update` to merge)",
  "keep-deleted": "kept deleted",
  "keep-removed-edit": "no longer managed; kept your edited copy",
};

export const initCommand: Command = {
  name: "init",
  summary: "Install or refresh the factory in this workspace (idempotent)",
  help: HELP,
  async run(args, io) {
    const { values } = parseCommandArgs("init", args, {
      force: { type: "boolean", default: false },
      "no-commit": { type: "boolean", default: false },
      "no-graph": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    });

    const root = await findWorkspaceRoot(io.cwd);
    if (root === undefined) {
      throw new PreconditionError("not inside a git repository", [
        "ai-factory installs into a git repository (the AI repo or the single repo)",
      ]);
    }
    const top = await gitOk(["rev-parse", "--show-toplevel"], { cwd: root });
    if (top !== root) {
      throw new PreconditionError(`${root} is not the top level of its git repository (${top})`);
    }

    const tools = await checkTools(REQUIRED_TOOLS, root);
    const missing = tools.filter((t) => !t.ok);
    if (missing.length > 0) {
      throw new PreconditionError(
        "required tools are missing or unsupported",
        missing.map((t) => (t.ok ? "" : `${t.tool}: ${t.problem} → ${t.fix}`)),
      );
    }

    if (!values["no-commit"]) {
      const dirty = await dirtyInstallPaths(root, [CONFIG_FILE]);
      if (dirty.length > 0) {
        throw new PreconditionError("uncommitted changes in files that init commits", [
          ...dirty,
          "commit or stash them, or rerun with --no-commit",
        ]);
      }
    }

    const configPath = join(root, CONFIG_FILE);
    const newConfig = !existsSync(configPath);
    const detection = newConfig ? await detectWorkspace(root) : undefined;
    const configText = detection !== undefined ? renderInitialConfig(detection) : undefined;
    const config =
      configText !== undefined ? parseConfigText(configText, CONFIG_FILE) : loadConfig(root).config;

    // OpenSpec's opencode files are rendered aside and managed like the factory's own.
    const openspecFiles = await renderOpenspecTools(root);
    // Plan first so a conflict stops init before anything is written.
    planWorkspace(root, config, { force: values.force, tools: openspecFiles });
    if (configText !== undefined) writeFileSync(configPath, configText);
    const result = await syncWorkspace(root, config, {
      force: values.force,
      tools: openspecFiles,
    });
    const commit = values["no-commit"]
      ? undefined
      : await commitInstall(root, `chore(factory): init v${FACTORY_VERSION}`);
    // The graph is local state (gitignored), so it is built after the commit.
    const graph = values["no-graph"]
      ? undefined
      : await updateGraph(root, { full: !existsSync(graphFile(root)) });

    const changed = result.plan.filter((c) => REPORTED[c.action] !== undefined);
    if (values.json) {
      io.out(
        JSON.stringify(
          {
            root,
            newConfig,
            tools,
            notes: detection?.notes ?? [],
            plan: result.plan.map(({ path, action }) => ({ path, action })),
            hooks: result.hooks,
            commit: commit ?? null,
            graph: graph ?? null,
          },
          null,
          2,
        ),
      );
      return ExitCode.Ok;
    }

    io.out(`ai-factory ${FACTORY_VERSION} in ${root}`);
    io.out(`tools: ${tools.map((t) => `${t.tool} ${t.ok ? t.version : "?"}`).join(", ")}`);
    for (const note of detection?.notes ?? []) io.out(`note: ${note}`);
    if (newConfig) io.out(`wrote ${CONFIG_FILE} (review "models" and "contracts")`);
    for (const c of changed) io.out(`${REPORTED[c.action]}: ${c.path}`);
    if (changed.length === 0) io.out("managed files: up to date");
    for (const { repo, result: hook } of result.hooks) {
      if (hook.status === "skipped") io.out(`hook ${repo}: skipped (${hook.reason})`);
      else if (hook.status !== "unchanged") io.out(`hook ${repo}: ${hook.status}`);
    }
    if (graph?.ok && graph.meta) {
      io.out(
        `graph: ${graph.meta.full ? "built" : "updated"} (${graph.meta.nodes} nodes, ${(graph.meta.durationMs / 1000).toFixed(1)}s)`,
      );
    } else if (graph) {
      io.out(
        `graph: not built (${graph.error ?? "unknown error"}); run \`ai-factory graph --full\` later`,
      );
    }
    io.out(
      commit
        ? `committed ${commit.slice(0, 12)} chore(factory): init v${FACTORY_VERSION}`
        : "nothing to commit",
    );
    return ExitCode.Ok;
  },
};
