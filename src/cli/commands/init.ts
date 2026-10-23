import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findWorkspaceRoot, loadConfig, parseConfigText } from "../../config/load.ts";
import { renderInitialConfig } from "../../config/render.ts";
import { CONFIG_FILE } from "../../config/schema.ts";
import { detectWorkspace } from "../../detect/workspace.ts";
import { PreconditionError } from "../../errors.ts";
import { execOk, gitOk } from "../../exec.ts";
import type { SyncAction } from "../../managed/sync.ts";
import { checkTools, type ToolName, toolBin, toolEnv } from "../../tools.ts";
import { FACTORY_VERSION } from "../../version.ts";
import {
  commitInstall,
  dirtyInstallPaths,
  planWorkspace,
  syncWorkspace,
} from "../../workspace/sync.ts";
import { type Command, parseCommandArgs } from "../command.ts";
import { ExitCode } from "../exit-codes.ts";

const HELP = `Usage: ai-factory init [--force] [--no-commit] [--json]

Installs the factory into the workspace: detects repos, languages and contracts, checks
the tools, runs \`openspec init\` for opencode, renders agents, standards and config,
installs pre-push hooks, writes ${CONFIG_FILE} and factory.lock.json, updates .gitignore
and commits the result in the AI repo. Safe to run again: an unchanged workspace gives
no diff and no commit.

Options:
  --force       Overwrite existing files that ai-factory did not create
  --no-commit   Leave the changes uncommitted
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

/** OpenSpec's opencode files, with a private config dir so output does not depend on ~/.config. */
async function openspecInit(root: string): Promise<void> {
  const xdg = join(root, ".factory", "cache", "openspec-xdg");
  mkdirSync(xdg, { recursive: true });
  await execOk(
    [
      toolBin("openspec"),
      "init",
      "--tools",
      "opencode",
      "--profile",
      "core",
      "--no-animation",
      root,
    ],
    { cwd: root, env: { ...toolEnv("openspec"), XDG_CONFIG_HOME: xdg }, timeoutMs: 120_000 },
  );
}

export const initCommand: Command = {
  name: "init",
  summary: "Install or refresh the factory in this workspace (idempotent)",
  help: HELP,
  async run(args, io) {
    const { values } = parseCommandArgs("init", args, {
      force: { type: "boolean", default: false },
      "no-commit": { type: "boolean", default: false },
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

    // Plan first so a conflict stops init before anything is written. Files the plan would
    // create may be written by `openspec init` first; the factory then takes them over.
    const created = planWorkspace(root, config, { force: values.force })
      .filter((c) => c.action === "create")
      .map((c) => c.path);
    if (configText !== undefined) writeFileSync(configPath, configText);
    await openspecInit(root);
    const result = await syncWorkspace(root, config, { force: values.force, adopt: created });
    const commit = values["no-commit"]
      ? undefined
      : await commitInstall(root, `chore(factory): init v${FACTORY_VERSION}`);

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
    io.out(
      commit
        ? `committed ${commit.slice(0, 12)} chore(factory): init v${FACTORY_VERSION}`
        : "nothing to commit",
    );
    return ExitCode.Ok;
  },
};
