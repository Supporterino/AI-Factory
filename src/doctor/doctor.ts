import { existsSync, lstatSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, extname, join } from "node:path";
import { loadConfig } from "../config/load.ts";
import type { FactoryConfig, GateType, RepoConfig } from "../config/schema.ts";
import { FactoryError } from "../errors.ts";
import { exec, git } from "../exec.ts";
import { type ResolvedGate, resolveGates } from "../gates/resolve.ts";
import { worktreeFiles } from "../gates/targets.ts";
import { prePushState } from "../git/hooks.ts";
import { dirtyPaths } from "../git/repo.ts";
import { graphStatus } from "../graph/graph.ts";
import { buildLock, type Lock, readLock } from "../lock/lock.ts";
import { sandboxEnabled } from "../policy/sandbox.ts";
import { parseScript, type Script } from "../policy/shell-parse.ts";
import { PROFILES } from "../profiles/index.ts";
import { serverEnv } from "../runtime/opencode.ts";
import { driverAlive, readActive, readQueue } from "../state/active.ts";
import { checkTools, compareVersions, type ToolName, toolBin } from "../tools.ts";
import { FACTORY_VERSION, runVersion } from "../version.ts";
import { GRAPHIFY } from "../versions.ts";
import { INSTALL_PATHS, planWorkspace } from "../workspace/sync.ts";

/**
 * `ai-factory doctor` (§5): read-only checks of everything a run depends on. Each check is
 * ok, a warning (works, but worth fixing) or a failure (a run would fail or be unsafe).
 */

export type CheckStatus = "ok" | "warn" | "fail";

export interface Check {
  readonly section: string;
  readonly name: string;
  readonly status: CheckStatus;
  readonly detail: string;
  readonly fix?: string;
}

export interface GateRow {
  readonly repo: string;
  readonly type: GateType;
  readonly cwd: string;
  readonly command?: string;
  readonly source?: ResolvedGate["source"];
  readonly problem?: string;
}

export interface DoctorReport {
  readonly checks: Check[];
  readonly gates: GateRow[];
  /** Uninitialised submodule paths (`doctor` offers to initialise them). */
  readonly uninitialised: string[];
}

/** Shell builtins: not executables to look up. */
const SHELL_BUILTINS = new Set([
  "[",
  "test",
  "echo",
  "exit",
  "true",
  "false",
  "cd",
  "set",
  "export",
  ":",
  "printf",
  "for",
]);
/** Keywords that may precede a command word (`do cmd`, `then cmd`, `{ cmd; }`). */
const SHELL_KEYWORDS = new Set([
  "do",
  "done",
  "then",
  "else",
  "fi",
  "if",
  "while",
  "until",
  "!",
  "{",
  "}",
]);

function commandNames(script: Script, out: Set<string>): void {
  for (const pipeline of script.pipelines) {
    for (const cmd of pipeline.commands) {
      if (cmd.kind === "subshell") {
        commandNames(cmd.script, out);
        continue;
      }
      for (const sub of cmd.substitutions) commandNames(sub, out);
      const name = cmd.words.find((w) => !SHELL_KEYWORDS.has(w));
      // `for x in …` headers, builtins, variables and placeholders are not programs.
      if (
        name === undefined ||
        SHELL_BUILTINS.has(name) ||
        name.startsWith("$") ||
        name.includes("{")
      )
        continue;
      out.add(name);
    }
  }
}

/** Executables a gate command runs (best effort; unparsable commands yield none). */
export function gateExecutables(command: string): string[] {
  const out = new Set<string>();
  try {
    commandNames(parseScript(command), out);
  } catch {
    return [];
  }
  return [...out];
}

function onPath(name: string, dirs: readonly string[]): boolean {
  if (name.includes("/")) return dirs.some((d) => existsSync(join(d, name)));
  return dirs.some((d) => d !== "" && existsSync(join(d, name)));
}

function dirSize(path: string): number {
  let total = 0;
  const stack = [path];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const child = join(dir, name);
      const st = lstatSync(child, { throwIfNoEntry: false });
      if (st === undefined || st.isSymbolicLink()) continue;
      if (st.isDirectory()) stack.push(child);
      else total += st.size;
    }
  }
  return total;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

class Checks {
  readonly list: Check[] = [];
  constructor(private section: string) {}
  in(section: string): this {
    this.section = section;
    return this;
  }
  add(status: CheckStatus, name: string, detail: string, fix?: string): void {
    this.list.push({ section: this.section, name, status, detail, ...(fix ? { fix } : {}) });
  }
}

const GUARD_PLUGIN = ".opencode/plugins/factory.js";

/** The tool pins this factory version writes into a lock. */
const CURRENT_PINS = buildLock({}).tools;

const range = (pin: Lock["tools"]["git"]): string =>
  `>= ${pin.min}${pin.maxExclusive ? ` < ${pin.maxExclusive}` : ""}`;

async function checkToolsAndLock(c: Checks, root: string, lock: Lock | undefined): Promise<void> {
  c.in("tools");
  const names: ToolName[] = ["git", "opencode", "openspec", "graphify"];
  for (const t of await checkTools(names, root)) {
    if (!t.ok) {
      c.add("fail", t.tool, t.problem, t.fix);
      continue;
    }
    const pin = lock?.tools[t.tool];
    const outsideLock =
      pin !== undefined &&
      (compareVersions(t.version, pin.min) < 0 ||
        (pin.maxExclusive !== undefined && compareVersions(t.version, pin.maxExclusive) >= 0));
    if (pin !== undefined && outsideLock) {
      c.add(
        "warn",
        t.tool,
        `${t.version} is outside the lock's range (${range(pin)})`,
        "ai-factory update --tools",
      );
    } else if (pin !== undefined && pin.tested !== CURRENT_PINS[t.tool].tested) {
      c.add(
        "warn",
        t.tool,
        `${t.version}; the lock pins tested ${pin.tested}, this factory ${CURRENT_PINS[t.tool].tested}`,
        "ai-factory update --tools",
      );
    } else {
      c.add(
        "ok",
        t.tool,
        pin ? `${t.version} (lock ${range(pin)}, tested ${pin.tested})` : t.version,
      );
    }
  }
  if (lock === undefined) return;
  const cmp = compareVersions(lock.factoryVersion, FACTORY_VERSION);
  if (cmp < 0) {
    c.add(
      "warn",
      "factory",
      `installed by ${lock.factoryVersion}, this is ${FACTORY_VERSION}`,
      "ai-factory update",
    );
  } else if (cmp > 0) {
    c.add(
      "fail",
      "factory",
      `installed by ${lock.factoryVersion}, newer than this ${FACTORY_VERSION}`,
      runVersion(lock.factoryVersion),
    );
  } else {
    c.add("ok", "factory", FACTORY_VERSION);
  }
}

function checkManaged(c: Checks, root: string, config: FactoryConfig): void {
  c.in("install");
  try {
    const plan = planWorkspace(root, config);
    const by = (a: string): string[] => plan.filter((p) => p.action === a).map((p) => p.path);
    const stale = [...by("update"), ...by("create"), ...by("overwrite"), ...by("remove")];
    const edited = [...by("keep-user-edit"), ...by("keep-removed-edit")];
    const deleted = by("keep-deleted");
    if (stale.length > 0) {
      c.add(
        "warn",
        "managed files",
        `${stale.length} differ from this factory's templates: ${stale.slice(0, 5).join(", ")}${stale.length > 5 ? ", …" : ""}`,
        "ai-factory update (or ai-factory detect --apply after repo changes)",
      );
    } else {
      c.add("ok", "managed files", `${plan.length} up to date`);
    }
    // The guard plugin enforces the safety rules: an edited copy is not trusted (ADR-0018).
    if (edited.includes(GUARD_PLUGIN) || deleted.includes(GUARD_PLUGIN)) {
      c.add(
        "fail",
        "guard plugin",
        `${GUARD_PLUGIN} differs from the rendered plugin`,
        "ai-factory update --restore (after moving your changes elsewhere)",
      );
    }
    const yours = edited.filter((p) => p !== GUARD_PLUGIN);
    if (yours.length > 0)
      c.add("ok", "your edits", `kept and merged on update: ${yours.join(", ")}`);
    if (deleted.length > 0)
      c.add("ok", "deleted by you", `${deleted.join(", ")} (update --restore recreates them)`);
  } catch (err) {
    if (!(err instanceof FactoryError)) throw err;
    c.add("fail", "managed files", [err.message, ...err.details].join("; "));
  }
}

async function checkRepos(
  c: Checks,
  root: string,
  config: FactoryConfig,
  uninitialised: string[],
): Promise<RepoConfig[]> {
  c.in("repos");
  const ready: RepoConfig[] = [];
  if (config.layout === "submodules") {
    const res = await git(["submodule", "status"], { cwd: root });
    for (const line of res.stdout.split("\n").filter((l) => l.trim() !== "")) {
      const path = line.slice(1).trim().split(/\s+/)[1] ?? "";
      if (line.startsWith("-")) {
        uninitialised.push(path);
        c.add("warn", path, "submodule not initialised", `git submodule update --init ${path}`);
      } else if (line.startsWith("U")) {
        c.add("fail", path, "submodule has merge conflicts", `resolve them in ${path}`);
      } else if (line.startsWith("+")) {
        c.add("ok", path, "checked out at a different commit than the AI repo records");
      }
    }
  }
  const checkouts = [{ name: "AI repo", dir: root }];
  for (const repo of config.repos) {
    const dir = join(root, repo.path);
    if (repo.path === ".") {
      ready.push(repo);
      continue;
    }
    if (!existsSync(join(dir, ".git"))) {
      if (!uninitialised.includes(repo.path))
        c.add("warn", repo.name, `${repo.path} is not a git checkout`);
      continue;
    }
    ready.push(repo);
    checkouts.push({ name: repo.name, dir });
  }
  for (const { name, dir } of checkouts) {
    const dirty = await dirtyPaths(dir);
    c.add(
      dirty.length > 0 ? "warn" : "ok",
      `${name} working tree`,
      dirty.length > 0
        ? `${dirty.length} uncommitted path(s): ${dirty.slice(0, 3).join(", ")}${dirty.length > 3 ? ", …" : ""}`
        : "clean",
      dirty.length > 0 ? "commit or stash before `approve` and `update`" : undefined,
    );
    const hook = await prePushState(dir);
    if (hook === "installed") c.add("ok", `${name} pre-push hook`, "installed");
    else if (hook === "foreign-hooks-path")
      c.add(
        "warn",
        `${name} pre-push hook`,
        "core.hooksPath points outside .git; agents are still blocked by their git environment",
      );
    else
      c.add(
        "fail",
        `${name} pre-push hook`,
        hook,
        "ai-factory init (reinstalls hooks, idempotent)",
      );
  }
  return ready;
}

function checkGates(
  c: Checks,
  root: string,
  config: FactoryConfig,
  repos: readonly RepoConfig[],
): GateRow[] {
  c.in("gates");
  const rows: GateRow[] = [];
  const pathDirs = (process.env.PATH ?? "").split(delimiter);
  for (const repo of repos.filter((r) => r.role === "code")) {
    const dir = join(root, repo.path);
    const plan = resolveGates({
      config,
      repo,
      worktree: dir,
      mode: "full",
      base: "HEAD",
      changed: [],
      files: worktreeFiles(dir),
    });
    const missingTools = new Set<string>();
    for (const g of plan.gates) {
      rows.push({
        repo: repo.name,
        type: g.type,
        cwd: g.cwd,
        command: g.command,
        source: g.source,
      });
      const dirs = [...g.binDirs.map((b) => join(dir, g.cwd, b)), join(dir, g.cwd), ...pathDirs];
      for (const exe of gateExecutables(g.command)) if (!onPath(exe, dirs)) missingTools.add(exe);
    }
    for (const g of plan.missing)
      rows.push({ repo: repo.name, type: g.type, cwd: g.cwd, problem: g.reason });
    for (const g of plan.skipped)
      rows.push({ repo: repo.name, type: g.type, cwd: g.cwd, problem: g.reason });
    if (plan.missing.length > 0) {
      c.add(
        "fail",
        repo.name,
        `no command for ${plan.missing.map((g) => g.type).join(", ")}`,
        `add a script (gates.scripts) or gates.overrides.${repo.name}`,
      );
    }
    if (missingTools.size > 0) {
      c.add(
        "fail",
        `${repo.name} toolchain`,
        `not found: ${[...missingTools].sort().join(", ")}`,
        "install them, or run the repo's install step (node_modules/.bin, .venv/bin count)",
      );
    }
    if (plan.missing.length === 0 && missingTools.size === 0) {
      c.add("ok", repo.name, `${plan.gates.length} gate command(s) resolved, toolchain present`);
    }
  }
  return rows;
}

function checkCaches(c: Checks, root: string): void {
  c.in("caches");
  const factory = join(root, ".factory");
  for (const [name, path] of [
    ["dependency caches", join(factory, "cache")],
    ["worktrees", join(factory, "worktrees")],
    ["logs", join(factory, "logs")],
    ["backups", join(factory, "backups")],
  ] as const) {
    if (!existsSync(path)) continue;
    c.add("ok", name, formatBytes(dirSize(path)));
  }
}

async function checkModels(c: Checks, root: string, config: FactoryConfig): Promise<void> {
  c.in("models");
  const configured = Object.entries(config.models).filter(
    (e): e is [string, string] => typeof e[1] === "string",
  );
  // Same curated environment as the server the pipeline starts (credentials of named
  // providers only), with a throwaway database so doctor stays read-only.
  const tmp = mkdtempSync(join(tmpdir(), "ai-factory-doctor-"));
  const res = await exec([toolBin("opencode"), "models", "--standalone"], {
    cwd: root,
    env: { ...serverEnv(root, config, "doctor"), OPENCODE_DB: join(tmp, "opencode.db") },
    replaceEnv: true,
    timeoutMs: 60_000,
  }).finally(() => rmSync(tmp, { recursive: true, force: true }));
  if (res.code !== 0) {
    c.add(
      "warn",
      "models",
      `could not list opencode's models: ${(res.stderr || res.stdout).trim().split("\n")[0] ?? ""}`,
    );
    return;
  }
  const available = new Set(
    res.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean),
  );
  for (const [role, model] of configured) {
    const id = model.split("#")[0] ?? model;
    if (available.has(id)) c.add("ok", role, model);
    else
      c.add(
        "fail",
        role,
        `${model} is not available to opencode`,
        `set the provider's credentials (env or \`opencode auth login\`) or change models.${role}`,
      );
  }
}

/** Source extensions of all profiles: what the graph indexes without an LLM backend. */
const CODE_EXTENSIONS = new Set(Object.values(PROFILES).flatMap((p) => p.extensions));

async function checkGraph(
  c: Checks,
  root: string,
  config: FactoryConfig,
  lock: Lock | undefined,
): Promise<void> {
  c.in("graph");
  const status = graphStatus(root);
  if (status.state === "missing") {
    c.add("warn", "graph", "not built yet", "ai-factory graph");
    return;
  }
  if (
    status.state === "unsupported" ||
    (lock && lock.graph.schemaVersion !== GRAPHIFY.graphSchemaVersion)
  ) {
    c.add(
      "fail",
      "graph",
      "format differs from what this factory reads",
      "ai-factory update --tools",
    );
    return;
  }
  const age = `${Math.round(status.ageMs / 60_000)} min old`;
  const built = status.builtAtCommit;
  if (built === undefined) {
    c.add("ok", "graph", age);
    return;
  }
  // Graphify keeps built_at_commit when nothing it indexes changed, so only code changes
  // (and moved submodule pointers) since that commit make the graph stale.
  const diff = await git(["diff", "--name-only", `${built}..HEAD`], { cwd: root });
  if (diff.code !== 0) {
    c.add(
      "warn",
      "graph",
      `${age}, built at an unknown commit (${built.slice(0, 12)})`,
      "ai-factory graph --full",
    );
    return;
  }
  const submodules = new Set(config.repos.filter((r) => r.path !== ".").map((r) => r.path));
  const stale = diff.stdout
    .split("\n")
    .filter((f) => f !== "" && !f.startsWith("openspec/"))
    .filter((f) => !INSTALL_PATHS.some((p) => f === p || f.startsWith(`${p}/`)))
    .filter((f) => submodules.has(f) || CODE_EXTENSIONS.has(extname(f)));
  if (stale.length > 0) {
    c.add(
      "warn",
      "graph",
      `${age}; ${stale.length} code path(s) changed since it was built: ${stale.slice(0, 3).join(", ")}${stale.length > 3 ? ", …" : ""}`,
      "ai-factory graph",
    );
  } else {
    c.add(
      "ok",
      "graph",
      `${age}, no code changes since it was built${status.meta ? ` (${status.meta.nodes} nodes)` : ""}`,
    );
  }
}

function checkChanges(c: Checks, root: string): void {
  c.in("changes");
  const active = readActive(root);
  const queue = readQueue(root).entries.map((e) => e.changeId);
  if (active === undefined) c.add("ok", "active", "none");
  else if (driverAlive(active)) c.add("ok", "active", `${active.changeId} (running)`);
  else
    c.add(
      "warn",
      "active",
      `${active.changeId} holds the lock but nothing is driving it`,
      `ai-factory resume ${active.changeId}`,
    );
  if (queue.length > 0) c.add("ok", "queue", queue.join(", "));
}

function checkSandbox(c: Checks, config: FactoryConfig): void {
  c.in("security");
  if (config.security.sandbox === "off")
    c.add(
      "warn",
      "sandbox",
      "off: agent shells and gates run unsandboxed",
      'set security.sandbox to "auto"',
    );
  else if (sandboxEnabled(config.security.sandbox))
    c.add("ok", "sandbox", "agent shells and gates run under macOS sandbox-exec");
  else
    c.add(
      "warn",
      "sandbox",
      `no OS sandbox on ${process.platform} yet: the shell parser, plugin, audit and git layers still apply`,
      "run the factory on macOS for the sandbox (ADR-0026)",
    );
  c.in("install");
}

export async function runDoctor(root: string): Promise<DoctorReport> {
  const c = new Checks("tools");
  const lock = readLock(root);
  await checkToolsAndLock(c, root, lock);
  const uninitialised: string[] = [];
  c.in("install");
  if (lock === undefined) {
    c.add("fail", "install", "ai-factory is not installed here", "ai-factory init");
    return { checks: c.list, gates: [], uninitialised };
  }
  let config: FactoryConfig;
  try {
    config = loadConfig(root).config;
  } catch (err) {
    if (!(err instanceof FactoryError)) throw err;
    c.add("fail", "config", err.message, err.details.join("; ") || undefined);
    return { checks: c.list, gates: [], uninitialised };
  }
  c.add("ok", "config", `schemaVersion ${config.schemaVersion}, layout ${config.layout}`);
  checkSandbox(c, config);
  checkManaged(c, root, config);
  const repos = await checkRepos(c, root, config, uninitialised);
  const gates = checkGates(c, root, config, repos);
  checkCaches(c, root);
  await checkModels(c, root, config);
  await checkGraph(c, root, config, lock);
  checkChanges(c, root);
  return { checks: c.list, gates, uninitialised };
}
