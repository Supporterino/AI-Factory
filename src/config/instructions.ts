import { relative } from "node:path";
import type { FactoryConfig } from "./schema.ts";

const repoOf = (config: FactoryConfig, name: string): string =>
  config.repos.find((r) => r.name === name)?.path ?? name;

/** Workspace-relative instruction paths, with a repo's paths prefixed by its checkout. */
export function instructionPaths(config: FactoryConfig, repo?: string): string[] {
  const repoPaths =
    repo === undefined
      ? []
      : (config.instructions.repos[repo] ?? []).map((path) => {
          const base = repoOf(config, repo);
          return base === "." ? path : `${base}/${path}`;
        });
  return [...new Set([...config.instructions.workspace, ...repoPaths])];
}

/** Instruction paths as seen from a repo checkout (reviewer/tester session cwd). */
export function sessionInstructionPaths(
  config: FactoryConfig,
  repoName: string,
  repoPath: string,
): string[] {
  return instructionPaths(config, repoName).map((path) => {
    const rel = relative(repoPath, path);
    return rel === "" ? path : rel;
  });
}

/** Every instruction path in the workspace, for the root opencode config. */
export function allInstructionPaths(config: FactoryConfig): string[] {
  return [
    ...new Set([
      ...config.instructions.workspace,
      ...Object.keys(config.instructions.repos).flatMap((repo) => instructionPaths(config, repo)),
    ]),
  ];
}
