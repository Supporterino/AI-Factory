import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setJsonc } from "../../config/jsonc.ts";
import { findWorkspaceRoot, loadConfig, parseConfigText } from "../../config/load.ts";
import { renderInitialConfig } from "../../config/render.ts";
import { CONFIG_FILE } from "../../config/schema.ts";
import { detectWorkspace } from "../../detect/workspace.ts";
import { PreconditionError } from "../../errors.ts";
import { gitOk } from "../../exec.ts";
import { graphFile, updateGraph } from "../../graph/graph.ts";
import { ensureNotNewer, readLock } from "../../lock/lock.ts";
import type { SyncAction } from "../../managed/sync.ts";
import { planSync } from "../../managed/sync.ts";
import { renderOpenspecTools } from "../../openspec/cli.ts";
import { renderWorkspace } from "../../render/workspace.ts";
import { checkTools, type ToolName } from "../../tools.ts";
import { FACTORY_VERSION } from "../../version.ts";
import { archiveLegacySetups } from "../../workspace/legacy.ts";
import {
  commitInstall,
  dirtyInstallPaths,
  planWorkspace,
  syncWorkspace,
} from "../../workspace/sync.ts";
import { type Command, type CommandOptions, parseCommandArgs } from "../command.ts";

const OPENSPEC_CONFIG = "openspec/config.yaml";

import { ExitCode } from "../exit-codes.ts";

const HELP = `Usage: ai-factory init [--plan] [--force] [--allow-downgrade] [--no-commit] [--no-graph] [--json]

Installs the factory into the workspace: detects repos, languages and contracts, checks
the tools, runs \`openspec init\` for opencode, renders agents, standards and config,
installs pre-push hooks, writes ${CONFIG_FILE} and factory.lock.json, updates .gitignore
and commits the result in the AI repo. Safe to run again: an unchanged workspace gives
no diff and no commit.

Options:
  --plan        Show what would be created, archived or replaced; write nothing
  --force       Overwrite existing files that ai-factory did not create
  --allow-downgrade  Let this (older) version rewrite a workspace a newer one installed
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

const OPTIONS = {
  force: {
    type: "boolean",
    default: false,
    description: "Overwrite files ai-factory did not create",
  },
  "allow-downgrade": {
    type: "boolean",
    default: false,
    description: "Let an older factory rewrite a newer install",
  },
  "no-commit": { type: "boolean", default: false, description: "Leave the changes uncommitted" },
  "no-graph": { type: "boolean", default: false, description: "Skip building the workspace graph" },
  plan: {
    type: "boolean",
    default: false,
    description: "Show what would change; write nothing",
  },
  json: { type: "boolean", default: false, description: "Print the result as JSON" },
} satisfies CommandOptions;

export const initCommand: Command = {
  name: "init",
  summary: "Install or refresh the factory in this workspace (idempotent)",
  help: HELP,
  options: OPTIONS,
  async run(args, io) {
    const { values } = parseCommandArgs("init", args, OPTIONS);

    const root = await findWorkspaceRoot(io.cwd);
    if (root === undefined) {
      throw new PreconditionError("not inside a git repository", [
        "ai-factory installs into a git repository (the AI repo or the single repo)",
      ]);
    }
    ensureNotNewer(readLock(root), values["allow-downgrade"]);
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

    if (!values.plan && !values["no-commit"]) {
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
    // Replacing an existing set is reversible: archive agents/commands/skills the factory
    // takes over before planning, and never touch additions made after the first install.
    const legacy =
      !values.plan && readLock(root) === undefined && detection !== undefined
        ? archiveLegacySetups(
            root,
            detection.repos.map((r) => r.path),
          )
        : undefined;
    // A team that already uses OpenSpec keeps its config.yaml: the first config lists it as
    // unmanaged, since that hint cannot be followed before a config exists (audit G2).
    const keepOpenspec =
      newConfig &&
      !values.force &&
      existsSync(join(root, OPENSPEC_CONFIG)) &&
      readLock(root) === undefined;
    const rendered = detection !== undefined ? renderInitialConfig(detection) : undefined;
    const configText =
      rendered !== undefined && keepOpenspec
        ? setJsonc(rendered, ["unmanaged"], [OPENSPEC_CONFIG])
        : rendered;
    const config =
      configText !== undefined ? parseConfigText(configText, CONFIG_FILE) : loadConfig(root).config;

    // OpenSpec's opencode files are rendered aside and managed like the factory's own.
    const openspecFiles = await renderOpenspecTools(root);
    if (values.plan) {
      const planned = planSync(
        root,
        [...renderWorkspace(config, { root }), ...openspecFiles],
        readLock(root)?.managed ?? {},
        { unmanaged: config.unmanaged, force: values.force },
      );
      if (values.json) {
        io.out(
          JSON.stringify(
            {
              root,
              newConfig,
              notes: detection?.notes ?? [],
              plan: planned.map(({ path, action }) => ({ path, action })),
            },
            null,
            2,
          ),
        );
      } else {
        io.out(`ai-factory ${FACTORY_VERSION} plan for ${root}`);
        if (newConfig) io.out(`would write ${CONFIG_FILE}`);
        for (const change of planned)
          io.out(`${REPORTED[change.action] ?? change.action}: ${change.path}`);
      }
      return ExitCode.Ok;
    }
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
    if (legacy !== undefined && legacy.archived.length > 0) {
      io.out(
        `legacy setup archived under .factory/legacy/${legacy.stamp}/ (${legacy.archived.length} path${legacy.archived.length === 1 ? "" : "s"})`,
      );
    }
    if (keepOpenspec)
      io.out(
        `kept your ${OPENSPEC_CONFIG} (listed under "unmanaged"); add the factory's workspace context to it by hand if you want the architect to see it`,
      );
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
