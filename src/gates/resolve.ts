import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { FactoryConfig, GateType, Language, RepoConfig } from "../config/schema.ts";
import type { Profile } from "../profiles/index.ts";
import { opencodeGlobRegExp } from "../tasks/glob.ts";
import {
  fillPlaceholders,
  type PlaceholderValues,
  placeholderValues,
  shellQuote,
  targetChanges,
} from "./affected.ts";
import { findTargets, requirementHolds, type Target } from "./targets.ts";

/**
 * Gate resolution (§9), per gate type:
 * 1. `gates.overrides[repo][type]` (the literal "skip" opts out explicitly);
 * 2. the repo's own script named by `gates.scripts[type]` (package.json, Makefile,
 *    justfile, Taskfile) at the repo root;
 * 3. the stacked profile defaults, per target (package, module, crate, chart set).
 * A gate with no resolvable command is reported as missing, never skipped silently.
 */

export type GateMode = "task" | "full";

export const GATES_BY_MODE: Readonly<Record<GateMode, readonly GateType[]>> = {
  task: ["format", "lint", "types", "testAffected"],
  full: ["format", "lint", "types", "test"],
};

export interface ResolvedGate {
  readonly type: GateType;
  /** Human-readable id for an extra/generated gate. */
  readonly name?: string;
  readonly command: string;
  /** Worktree-relative directory to run in. */
  readonly cwd: string;
  readonly source: "override" | "script" | "profile" | "extra";
  readonly profile?: Language;
  /** Worktree-relative tool directories to prepend to PATH. */
  readonly binDirs: readonly string[];
  /** Extra environment for this gate only. */
  readonly env?: Readonly<Record<string, string>>;
  /** Runs before `command`; a failure fails the gate. */
  readonly setup?: string;
  /** Generated-artifact gate: files that must not drift. */
  readonly outputs?: readonly string[];
  /** False allows a gate to write files (used with outputs/format generators). */
  readonly checkOnly?: boolean;
  readonly timeoutMs?: number;
}

export interface GateGap {
  readonly type: GateType;
  readonly cwd: string;
  readonly reason: string;
}

export interface GatePlan {
  readonly gates: ResolvedGate[];
  /** No command could be resolved: the gate fails. */
  readonly missing: GateGap[];
  /** Deliberately not run (explicit "skip", or nothing affected): recorded, not failed. */
  readonly skipped: GateGap[];
}

export interface ResolveInput {
  readonly config: FactoryConfig;
  readonly repo: RepoConfig;
  /** Absolute worktree (or repo checkout) path. */
  readonly worktree: string;
  readonly mode: GateMode;
  readonly base: string;
  /** Worktree-relative changed files (task mode). */
  readonly changed: readonly string[];
  /** Worktree-relative files of the checkout. */
  readonly files: readonly string[];
  /** Worktree-relative files that depend on the changes, from the graph (optional). */
  readonly related?: readonly string[];
  /** Gate tables per language from the change's snapshot (`update --force` safety). */
  readonly gateTables?: Partial<Record<Language, Profile["gates"]>>;
}

export const SKIP = "skip";

type ScriptHost = "package.json" | "Makefile" | "justfile" | "Taskfile.yml";

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** The package manager that runs package.json scripts, from the lockfile. */
function scriptRunner(worktree: string): string {
  if (existsSync(join(worktree, "bun.lock")) || existsSync(join(worktree, "bun.lockb")))
    return "bun run";
  if (existsSync(join(worktree, "pnpm-lock.yaml"))) return "pnpm run";
  if (existsSync(join(worktree, "yarn.lock"))) return "yarn run";
  return "npm run --silent";
}

function findScript(worktree: string, name: string): ScriptHost | undefined {
  const pkg = readText(join(worktree, "package.json"));
  if (pkg !== undefined) {
    try {
      const scripts = (JSON.parse(pkg) as { scripts?: Record<string, unknown> }).scripts;
      if (scripts && typeof scripts[name] === "string") return "package.json";
    } catch {
      // A broken package.json is the lint gate's problem, not resolution's.
    }
  }
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const make = readText(join(worktree, "Makefile"));
  if (make !== undefined && new RegExp(`^${escaped}\\s*:(?!=)`, "m").test(make)) return "Makefile";
  const just = readText(join(worktree, "justfile")) ?? readText(join(worktree, "Justfile"));
  if (just !== undefined && new RegExp(`^@?${escaped}(\\s[^:]*)?:(?!=)`, "m").test(just))
    return "justfile";
  for (const file of ["Taskfile.yml", "Taskfile.yaml"]) {
    const task = readText(join(worktree, file));
    if (task === undefined) continue;
    try {
      const tasks = (parseYaml(task) as { tasks?: Record<string, unknown> } | null)?.tasks;
      if (tasks && name in tasks) return "Taskfile.yml";
    } catch {
      // Unparsable Taskfile: fall through to profile defaults.
    }
  }
  return undefined;
}

/** Command for a repo script; affected-test scripts receive the changed files as arguments. */
function scriptCommand(
  worktree: string,
  host: ScriptHost,
  name: string,
  files: readonly string[],
): string {
  const args = files.map(shellQuote).join(" ");
  switch (host) {
    case "package.json": {
      const runner = scriptRunner(worktree);
      if (args === "") return `${runner} ${shellQuote(name)}`;
      return runner.startsWith("bun")
        ? `${runner} ${shellQuote(name)} ${args}`
        : `${runner} ${shellQuote(name)} -- ${args}`;
    }
    case "Makefile":
      return args === "" ? `make ${name}` : `make ${name} FILES=${shellQuote(files.join(" "))}`;
    case "justfile":
      return `just ${name}${args === "" ? "" : ` ${args}`}`;
    case "Taskfile.yml":
      return `task ${name}${args === "" ? "" : ` -- ${args}`}`;
  }
}

function profileGate(input: ResolveInput, type: GateType, target: Target): ResolvedGate | GateGap {
  const table = input.gateTables?.[target.profile.id] ?? target.profile.gates;
  const candidate = table[type].find((c) => requirementHolds(c.when, input.worktree, target.dir));
  if (candidate === undefined) {
    return {
      type,
      cwd: target.dir,
      reason: `no ${type} tool configured for ${target.profile.title} in ${target.dir} (add one, or set gates.overrides.${input.repo.name}.${type})`,
    };
  }
  const template = input.mode === "task" && candidate.scoped ? candidate.scoped : candidate.command;
  const values = placeholderValues(
    input.worktree,
    target,
    input.changed,
    input.files,
    input.base,
    input.mode,
    input.related,
  );
  const command = fillPlaceholders(template, values);
  if (command === undefined) {
    return { type, cwd: target.dir, reason: "skip: nothing affected" };
  }
  return {
    type,
    command,
    cwd: target.dir,
    source: "profile",
    profile: target.profile.id,
    binDirs: target.profile.binDirs.map((b) => (target.dir === "." ? b : join(target.dir, b))),
  };
}

const isGap = (x: ResolvedGate | GateGap): x is GateGap => "reason" in x;

export function resolveGates(input: ResolveInput): GatePlan {
  const plan: GatePlan = { gates: [], missing: [], skipped: [] };
  const targets = findTargets(input.repo.languages, input.files);
  const rootBins = [
    ...new Set(targets.filter((t) => t.dir === ".").flatMap((t) => t.profile.binDirs)),
  ];

  for (const type of GATES_BY_MODE[input.mode]) {
    const override = input.config.gates.overrides[input.repo.name]?.[type];
    if (override === SKIP) {
      plan.skipped.push({
        type,
        cwd: ".",
        reason: `skip: gates.overrides.${input.repo.name}.${type}`,
      });
      continue;
    }
    if (override !== undefined) {
      const command = fillPlaceholders(override, repoPlaceholders(input, targets));
      if (command === undefined)
        plan.skipped.push({ type, cwd: ".", reason: "skip: nothing affected" });
      else plan.gates.push({ type, command, cwd: ".", source: "override", binDirs: rootBins });
      continue;
    }

    const scriptName = input.config.gates.scripts[type];
    const host = scriptName === undefined ? undefined : findScript(input.worktree, scriptName);
    if (host !== undefined && scriptName !== undefined) {
      const files =
        type === "testAffected"
          ? input.changed.filter((f) => existsSync(join(input.worktree, f)))
          : [];
      if (type === "testAffected" && files.length === 0) {
        plan.skipped.push({ type, cwd: ".", reason: "skip: nothing affected" });
      } else {
        plan.gates.push({
          type,
          command: scriptCommand(input.worktree, host, scriptName, files),
          cwd: ".",
          source: "script",
          binDirs: rootBins,
        });
      }
      continue;
    }

    if (targets.length === 0) {
      plan.missing.push({
        type,
        cwd: ".",
        reason: `no ${type} gate: no language markers in ${input.repo.name} and no override or script`,
      });
      continue;
    }
    for (const target of targets) {
      // Per task, only targets the task touched run.
      if (input.mode === "task" && targetChanges(target, input.changed).length === 0) continue;
      const result = profileGate(input, type, target);
      if (!isGap(result)) plan.gates.push(result);
      else if (result.reason.startsWith("skip:")) plan.skipped.push(result);
      else plan.missing.push(result);
    }
  }

  for (const extra of input.config.gates.extra) {
    if (!extra.phases.includes(input.mode)) continue;
    const wanted = extra.when.changed;
    if (
      wanted.length > 0 &&
      input.mode === "task" &&
      !input.changed.some((file) => wanted.some((glob) => opencodeGlobRegExp(glob).test(file)))
    ) {
      plan.skipped.push({
        type: extra.type,
        cwd: extra.cwd,
        reason: `skip: ${extra.name} does not match the changed paths`,
      });
      continue;
    }
    const values = repoPlaceholders(input, targets);
    const command = fillPlaceholders(extra.command, values);
    if (command === undefined) {
      plan.skipped.push({
        type: extra.type,
        cwd: extra.cwd,
        reason: `skip: nothing affected for ${extra.name}`,
      });
      continue;
    }
    const setup = extra.setup === undefined ? undefined : fillPlaceholders(extra.setup, values);
    plan.gates.push({
      type: extra.type,
      name: extra.name,
      command,
      cwd: extra.cwd,
      source: "extra",
      binDirs: rootBins,
      ...(Object.keys(extra.env).length > 0 ? { env: extra.env } : {}),
      ...(setup === undefined ? {} : { setup }),
      ...(extra.outputs.length > 0 ? { outputs: extra.outputs } : {}),
      checkOnly: extra.checkOnly,
      ...(extra.timeoutMs === undefined ? {} : { timeoutMs: extra.timeoutMs }),
    });
  }
  return plan;
}

/** Placeholder values for a repo-root override: the union over all targets, root-relative. */
function repoPlaceholders(input: ResolveInput, targets: readonly Target[]): PlaceholderValues {
  const perTarget = targets.map((t) =>
    placeholderValues(
      input.worktree,
      { profile: t.profile, dir: ".", charts: t.charts.map((c) => join(t.dir, c)) },
      input.changed,
      input.files,
      input.base,
      input.mode,
    ),
  );
  const union = (key: "testFiles" | "packages" | "crates" | "charts"): string[] =>
    [...new Set(perTarget.flatMap((v) => v[key]))].sort();
  return {
    files: input.changed.filter((f) => existsSync(join(input.worktree, f))),
    testFiles: union("testFiles"),
    packages: union("packages"),
    crates: union("crates"),
    charts: union("charts"),
    base: input.base,
  };
}
