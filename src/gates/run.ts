import { delimiter, join } from "node:path";
import { newShortcuts } from "../addons/shortcuts.ts";
import type { FactoryConfig, GateType, RepoConfig } from "../config/schema.ts";
import { exec } from "../exec.ts";
import { dependentFiles } from "../graph/graph.ts";
import { checkoutPolicy, sandboxArgv, sandboxEnabled, seatbeltProfile } from "../policy/sandbox.ts";
import { agentProcessEnv } from "../runtime/credentials.ts";
import { changedFiles } from "./affected.ts";
import { compactOutput } from "./compact.ts";
import { changedSince, restore, snapshot } from "./guard.ts";
import { cacheEnv, QUIET_ENV } from "./install.ts";
import { type GateMode, type ResolvedGate, type ResolveInput, resolveGates } from "./resolve.ts";
import { worktreeFiles } from "./targets.ts";

export type GateStatus = "pass" | "fail" | "missing" | "skipped" | "not-check-only" | "timeout";

export interface GateResult {
  readonly type: GateType;
  readonly status: GateStatus;
  readonly cwd: string;
  readonly command?: string;
  readonly source?: ResolvedGate["source"];
  readonly exitCode?: number | null;
  readonly durationMs: number;
  /** Compacted output (what an agent sees on a retry). */
  readonly output: string;
  /** Files a non-check-only gate modified (they were restored). */
  readonly modified?: readonly string[];
}

export interface GateReport {
  readonly repo: string;
  readonly mode: GateMode;
  readonly base: string;
  readonly passed: boolean;
  readonly changed: readonly string[];
  readonly results: readonly GateResult[];
}

export interface RunGatesInput {
  /** Workspace root (for caches). */
  readonly root: string;
  readonly config: FactoryConfig;
  readonly repo: RepoConfig;
  /** Absolute worktree or repo checkout. */
  readonly worktree: string;
  readonly mode: GateMode;
  /** Commit the changes are measured against. */
  readonly base: string;
  readonly timeoutMs?: number;
  /**
   * Widen affected tests with the workspace graph: tests whose code depends on the changed
   * files. `repoPath` maps worktree paths to the graph's workspace-relative paths.
   */
  readonly graph?: { readonly root: string; readonly repoPath: string };
  /** `addons.ponytail.shortcutComments: "forbid"`: new `shortcut:` comments fail lint. */
  readonly forbidShortcuts?: boolean;
  /** Gate tables from the change's snapshot. */
  readonly gateTables?: ResolveInput["gateTables"];
}

const FAILING: ReadonlySet<GateStatus> = new Set(["fail", "missing", "not-check-only", "timeout"]);

/** Tests run only when format, lint and types passed; their output would be noise otherwise. */
const TEST_GATES: ReadonlySet<GateType> = new Set(["test", "testAffected"]);

async function runOne(input: RunGatesInput, gate: ResolvedGate): Promise<GateResult> {
  const before = await snapshot(input.worktree);
  const bins = gate.binDirs.map((b) => join(input.worktree, b));
  // Gates run code the agents wrote: no credentials, pushes blocked, sandboxed where possible.
  const env = {
    ...agentProcessEnv(),
    ...cacheEnv(input.root, input.repo.name),
    ...QUIET_ENV,
    PATH: [...bins, process.env.PATH ?? ""].join(delimiter),
  };
  const argv = ["sh", "-c", gate.command];
  const res = await exec(
    sandboxEnabled(input.config.security.sandbox)
      ? sandboxArgv(
          seatbeltProfile(
            checkoutPolicy(input.root, input.worktree, [join(input.root, ".factory", "cache")]),
          ),
          argv,
        )
      : argv,
    {
      cwd: join(input.worktree, gate.cwd),
      env,
      replaceEnv: true,
      timeoutMs: input.timeoutMs ?? 15 * 60_000,
    },
  );
  const base = {
    type: gate.type,
    cwd: gate.cwd,
    command: gate.command,
    source: gate.source,
    exitCode: res.code,
    durationMs: res.durationMs,
  };
  const max = input.config.tokens.gateOutputMaxLines;

  const modified = await changedSince(before);
  if (modified.length > 0) {
    await restore(before, modified);
    return {
      ...base,
      status: "not-check-only",
      modified,
      output: `gate is not check-only: \`${gate.command}\` modified ${modified.join(", ")} (restored)`,
    };
  }
  if (res.timedOut)
    return { ...base, status: "timeout", output: `gate timed out: \`${gate.command}\`` };
  const raw = `${res.stdout}\n${res.stderr}`;
  return {
    ...base,
    status: res.code === 0 ? "pass" : "fail",
    output: res.code === 0 ? "" : compactOutput(raw, max),
  };
}

/** Worktree-relative files the graph says depend on `changed`. */
function relatedFiles(root: string, repoPath: string, changed: readonly string[]): string[] {
  const prefix = repoPath === "." ? "" : `${repoPath}/`;
  return [
    ...dependentFiles(
      root,
      changed.map((f) => prefix + f),
    ),
  ]
    .filter((f) => f.startsWith(prefix))
    .map((f) => f.slice(prefix.length));
}

/** Resolves and runs one repo's gates in a worktree, sequentially. */
export async function runGates(input: RunGatesInput): Promise<GateReport> {
  const changed = input.mode === "task" ? await changedFiles(input.worktree, input.base) : [];
  const related = input.graph ? relatedFiles(input.graph.root, input.graph.repoPath, changed) : [];
  const plan = resolveGates({
    config: input.config,
    repo: input.repo,
    worktree: input.worktree,
    mode: input.mode,
    base: input.base,
    changed,
    files: worktreeFiles(input.worktree),
    related,
    ...(input.gateTables ? { gateTables: input.gateTables } : {}),
  });

  const results: GateResult[] = [
    ...plan.missing.map(
      (m): GateResult => ({
        type: m.type,
        cwd: m.cwd,
        status: "missing",
        durationMs: 0,
        output: m.reason,
      }),
    ),
    ...plan.skipped.map(
      (s): GateResult => ({
        type: s.type,
        cwd: s.cwd,
        status: "skipped",
        durationMs: 0,
        output: s.reason,
      }),
    ),
  ];
  let failedBeforeTests = results.some((r) => FAILING.has(r.status));
  for (const gate of plan.gates) {
    if (TEST_GATES.has(gate.type) && failedBeforeTests) {
      results.push({
        type: gate.type,
        cwd: gate.cwd,
        command: gate.command,
        status: "skipped",
        durationMs: 0,
        output: "skip: format, lint or types failed",
      });
      continue;
    }
    const result = await runOne(input, gate);
    results.push(result);
    if (!TEST_GATES.has(gate.type) && FAILING.has(result.status)) failedBeforeTests = true;
  }

  if (input.forbidShortcuts) {
    const found = await newShortcuts(input.worktree, input.base);
    results.push({
      type: "lint",
      cwd: ".",
      command: "no new shortcut: comments (addons.ponytail.shortcutComments: forbid)",
      status: found.length === 0 ? "pass" : "fail",
      durationMs: 0,
      output: found.map((s) => `${s.file}:${s.line}: shortcut: ${s.text}`).join("\n"),
    });
  }

  const order = ["format", "lint", "types", "test", "testAffected"];
  results.sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));
  return {
    repo: input.repo.name,
    mode: input.mode,
    base: input.base,
    passed: !results.some((r) => FAILING.has(r.status)),
    changed,
    results,
  };
}
