import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { parseJsonc } from "../config/jsonc.ts";
import type { ContractConfig, FactoryConfig, Language, RepoConfig } from "../config/schema.ts";
import { git } from "../exec.ts";
import { detectContracts, type ScannedRepo } from "./contracts.ts";
import { detectLanguages } from "./languages.ts";
import { listFiles } from "./walk.ts";

export interface DetectedRepo {
  readonly name: string;
  readonly path: string;
  readonly role: "orchestration" | "code";
  readonly languages: Language[];
  readonly subPaths?: { path: string; languages: Language[] }[];
  readonly defaultBranch?: string;
  /** False for a submodule that is registered but not checked out. */
  readonly initialized: boolean;
}

export interface Detection {
  readonly layout: FactoryConfig["layout"];
  readonly repos: DetectedRepo[];
  readonly contracts: ContractConfig[];
  /** Existing `opencode.json` instruction paths, proposed for the v3 config. */
  readonly instructions: { workspace: string[]; repos: Record<string, string[]> };
  /** Package scripts that look like end-to-end suites, proposed as full-suite gates. */
  readonly e2e: { repo: string; command: string }[];
  /** Taskfile tasks that map to a whole-repo check (docs, kustomize, chart, verify). */
  readonly tasks: { repo: string; names: string[] }[];
  readonly notes: string[];
}

const WALK = { maxDepth: 6, maxFiles: 20_000 } as const;

/** Lowercase, dash-separated repo name derived from a path. */
export function repoNameFrom(path: string): string {
  const name = basename(path)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return name === "" ? "repo" : name;
}

function uniqueName(wanted: string, taken: Set<string>): string {
  let name = wanted;
  for (let i = 2; taken.has(name); i++) name = `${wanted}-${i}`;
  taken.add(name);
  return name;
}

interface Submodule {
  readonly key: string;
  readonly path: string;
}

async function readSubmodules(root: string): Promise<Submodule[]> {
  const res = await git(
    ["config", "--file", ".gitmodules", "--get-regexp", "^submodule\\..*\\.path$"],
    { cwd: root },
  );
  // Exit 1 means "no matching keys": an empty .gitmodules.
  if (res.code !== 0) return [];
  return res.stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const space = line.indexOf(" ");
      const key = line.slice("submodule.".length, space - ".path".length);
      return { key, path: line.slice(space + 1).trim() };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** The remote's default branch (origin/HEAD), falling back to the checked-out branch. */
async function defaultBranchOf(dir: string): Promise<string | undefined> {
  const remoteHead = await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], {
    cwd: dir,
  });
  if (remoteHead.code === 0) return remoteHead.stdout.trim().replace(/^origin\//, "");
  const current = await git(["branch", "--show-current"], { cwd: dir });
  const branch = current.stdout.trim();
  return current.code === 0 && branch !== "" ? branch : undefined;
}

function isInitialized(dir: string): boolean {
  return existsSync(join(dir, ".git"));
}

function readScripts(dir: string): Record<string, string> {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      scripts?: Record<string, unknown>;
    };
    return Object.fromEntries(
      Object.entries(pkg.scripts ?? {}).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

function packageRunner(dir: string): string {
  if (existsSync(join(dir, "bun.lock")) || existsSync(join(dir, "bun.lockb"))) return "bun run";
  if (existsSync(join(dir, "pnpm-lock.yaml"))) return "pnpm run";
  if (existsSync(join(dir, "yarn.lock"))) return "yarn";
  return "npm run";
}

function e2eScript(dir: string): string | undefined {
  const scripts = readScripts(dir);
  const name =
    scripts["test:e2e"] !== undefined ? "test:e2e" : scripts.e2e !== undefined ? "e2e" : undefined;
  return name === undefined ? undefined : `${packageRunner(dir)} ${name}`;
}

function taskNames(dir: string): string[] {
  for (const file of ["Taskfile.yml", "Taskfile.yaml"]) {
    const path = join(dir, file);
    if (!existsSync(path)) continue;
    try {
      const doc = parseYaml(readFileSync(path, "utf8"), { logLevel: "silent" }) as {
        tasks?: Record<string, unknown>;
      } | null;
      return Object.keys(doc?.tasks ?? {}).sort();
    } catch {
      return [];
    }
  }
  return [];
}

/** Instructions an existing opencode config would inject, as workspace-relative paths. */
function readInstructions(dir: string): string[] {
  for (const file of [
    "opencode.json",
    "opencode.jsonc",
    ".opencode/opencode.json",
    ".opencode/opencode.jsonc",
  ]) {
    if (!existsSync(join(dir, file))) continue;
    try {
      const text = readFileSync(join(dir, file), "utf8");
      const value = parseJsonc(text).value as { instructions?: unknown } | undefined;
      const list = Array.isArray(value?.instructions) ? value.instructions : [];
      return list.filter(
        (v): v is string =>
          typeof v === "string" &&
          !v.startsWith("/") &&
          !v.startsWith("~") &&
          !v.includes("://") &&
          !v.split("/").includes(".."),
      );
    } catch {
      return [];
    }
  }
  return [];
}

function withOptional(
  base: Omit<DetectedRepo, "subPaths" | "defaultBranch">,
  subPaths: DetectedRepo["subPaths"],
  defaultBranch: string | undefined,
): DetectedRepo {
  return {
    ...base,
    ...(subPaths && subPaths.length > 0 ? { subPaths } : {}),
    ...(defaultBranch ? { defaultBranch } : {}),
  };
}

/** Detects layout, repos, languages and contracts. Never writes anything. */
export async function detectWorkspace(root: string): Promise<Detection> {
  const notes: string[] = [];
  const repos: DetectedRepo[] = [];
  const scanned: ScannedRepo[] = [];
  const taken = new Set<string>();
  const instructions: Detection["instructions"] = {
    workspace: readInstructions(root),
    repos: {},
  };
  const e2e: Detection["e2e"] = [];
  const tasks: Detection["tasks"] = [];

  const submodules = existsSync(join(root, ".gitmodules")) ? await readSubmodules(root) : [];
  const layout = submodules.length > 0 ? "submodules" : "single";

  if (layout === "single") {
    const files = listFiles(root, WALK);
    const { languages, subPaths } = detectLanguages(root, files);
    const name = uniqueName(repoNameFrom(root), taken);
    repos.push(
      withOptional(
        { name, path: ".", role: "code", languages, initialized: true },
        subPaths,
        await defaultBranchOf(root),
      ),
    );
    scanned.push({ name, root, files });
    const singleE2e = e2eScript(root);
    if (singleE2e !== undefined) e2e.push({ repo: name, command: singleE2e });
    tasks.push({ repo: name, names: taskNames(root) });
    if (languages.length === 0) notes.push("no language markers found in the repository");
  } else {
    taken.add("ai");
    repos.push({ name: "ai", path: ".", role: "orchestration", languages: [], initialized: true });
    for (const sub of submodules) {
      const dir = join(root, sub.path);
      const name = uniqueName(repoNameFrom(sub.path), taken);
      if (!isInitialized(dir)) {
        notes.push(
          `submodule ${sub.path} is not initialised; languages unknown (run \`git submodule update --init ${sub.path}\`)`,
        );
        repos.push({ name, path: sub.path, role: "code", languages: [], initialized: false });
        continue;
      }
      const files = listFiles(dir, WALK);
      const { languages, subPaths } = detectLanguages(dir, files);
      if (languages.length === 0) notes.push(`no language markers found in ${sub.path}`);
      repos.push(
        withOptional(
          { name, path: sub.path, role: "code", languages, initialized: true },
          subPaths,
          await defaultBranchOf(dir),
        ),
      );
      const inherited = readInstructions(dir);
      if (inherited.length > 0) instructions.repos[name] = inherited;
      const repoE2e = e2eScript(dir);
      if (repoE2e !== undefined) e2e.push({ repo: name, command: repoE2e });
      tasks.push({ repo: name, names: taskNames(dir) });
      scanned.push({ name, root: dir, files });
    }
  }

  return {
    layout,
    repos,
    contracts: detectContracts(scanned),
    instructions,
    e2e,
    tasks,
    notes,
  };
}

/** The config entry for a detected repo (drops detection-only fields). */
export function toRepoConfig(repo: DetectedRepo): RepoConfig {
  const { initialized: _initialized, ...rest } = repo;
  return rest;
}
