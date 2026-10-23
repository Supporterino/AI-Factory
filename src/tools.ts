import { exec, GRAPHIFY_ENV, OPENSPEC_ENV } from "./exec.ts";
import { GIT, GRAPHIFY, OPENCODE, OPENSPEC } from "./versions.ts";

/** External tools the factory drives. */
export type ToolName = "git" | "opencode" | "openspec" | "graphify";

interface ToolSpec {
  readonly bin: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly min: string;
  readonly maxExclusive?: string;
  readonly install: string;
}

export const TOOL_SPECS: Readonly<Record<ToolName, ToolSpec>> = {
  git: {
    bin: "git",
    min: GIT.min,
    install: "install git >= 2.31 (Xcode CLT or your package manager)",
  },
  opencode: {
    bin: "opencode",
    min: OPENCODE.min,
    maxExclusive: OPENCODE.maxExclusive,
    install: `npm install --global ${OPENCODE.npmCli}@${OPENCODE.tested}`,
  },
  openspec: {
    bin: "openspec",
    env: OPENSPEC_ENV,
    min: OPENSPEC.min,
    maxExclusive: OPENSPEC.maxExclusive,
    install: `npm install --global ${OPENSPEC.npm}@${OPENSPEC.tested}`,
  },
  graphify: {
    bin: "graphify",
    env: GRAPHIFY_ENV,
    min: GRAPHIFY.min,
    maxExclusive: GRAPHIFY.maxExclusive,
    install: `uv tool install ${GRAPHIFY.pypi}==${GRAPHIFY.tested}`,
  },
};

/**
 * Binary for a tool. `AI_FACTORY_<TOOL>_BIN` overrides PATH lookup (used by tests and by
 * users with several installs).
 */
export function toolBin(name: ToolName, env: NodeJS.ProcessEnv = process.env): string {
  return env[`AI_FACTORY_${name.toUpperCase()}_BIN`] ?? TOOL_SPECS[name].bin;
}

export function toolEnv(name: ToolName): Readonly<Record<string, string>> {
  return TOOL_SPECS[name].env ?? {};
}

/** First x.y.z in a `--version` output ("opencode v2.1.2", "git version 2.54.0 (…)"). */
export function parseVersion(output: string): string | undefined {
  return output.match(/(\d+)\.(\d+)\.(\d+)/)?.[0];
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return Math.sign(diff);
  }
  return 0;
}

export type ToolStatus =
  | { tool: ToolName; ok: true; version: string }
  | { tool: ToolName; ok: false; version?: string; problem: string; fix: string };

export async function checkTool(name: ToolName, cwd: string): Promise<ToolStatus> {
  const spec = TOOL_SPECS[name];
  const res = await exec([toolBin(name), "--version"], {
    cwd,
    env: toolEnv(name),
    timeoutMs: 30_000,
  });
  const version = res.code === 0 ? parseVersion(res.stdout + res.stderr) : undefined;
  if (version === undefined) {
    return { tool: name, ok: false, problem: "not found", fix: spec.install };
  }
  if (compareVersions(version, spec.min) < 0) {
    return {
      tool: name,
      ok: false,
      version,
      problem: `${version} < ${spec.min}`,
      fix: spec.install,
    };
  }
  if (spec.maxExclusive !== undefined && compareVersions(version, spec.maxExclusive) >= 0) {
    return {
      tool: name,
      ok: false,
      version,
      problem: `${version} is newer than supported (< ${spec.maxExclusive})`,
      fix: spec.install,
    };
  }
  return { tool: name, ok: true, version };
}

export function checkTools(names: readonly ToolName[], cwd: string): Promise<ToolStatus[]> {
  return Promise.all(names.map((n) => checkTool(n, cwd)));
}
