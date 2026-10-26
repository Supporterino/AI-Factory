import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { ContractConfig } from "../config/schema.ts";
import { baseOf, dirOf, type FileEntry, isWithin } from "./walk.ts";

/** A code repo as contract detection sees it. */
export interface ScannedRepo {
  readonly name: string;
  /** Absolute path. */
  readonly root: string;
  readonly files: readonly FileEntry[];
}

const MAX_SPEC_BYTES = 1024 * 1024;
const MAX_TEXT_BYTES = 256 * 1024;
const MAX_TEXT_FILES = 3000;
const TEST_DIR = /(^|\/)(test|tests|testdata|fixtures|__tests__|examples?)(\/|$)/;
const TEXT_FILE =
  /\.(json|ya?ml|toml|ts|tsx|js|jsx|mjs|cjs|go|py|rs|proto|md|txt|sh|mk)$|(^|\/)(Makefile|justfile|Taskfile\.ya?ml|Dockerfile)$/;
const LOCKFILE =
  /(^|\/)(package-lock\.json|bun\.lockb?|yarn\.lock|pnpm-lock\.yaml|go\.sum|Cargo\.lock|uv\.lock|poetry\.lock)$/;

function read(root: string, rel: string): string | undefined {
  try {
    return readFileSync(join(root, rel), "utf8");
  } catch {
    return undefined;
  }
}

function topLevelKeys(root: string, rel: string): Record<string, unknown> | undefined {
  const text = read(root, rel);
  if (text === undefined) return undefined;
  try {
    // YAML is a superset of JSON; templated files (Helm) are expected to be odd, so stay quiet.
    const value: unknown = parseYaml(text, { logLevel: "silent" });
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

interface FoundContract {
  readonly kind: ContractConfig["kind"];
  readonly path: string;
  /** Text that marks a reference to this contract in a consumer repo. */
  readonly needles: readonly string[];
  /** Generated/custom contracts: the command that regenerates or validates it. */
  readonly command?: string;
  readonly outputs?: string[];
  readonly validate?: Record<string, string>;
}

/** Contract files a repo provides. Test and example directories are ignored. */
function findProvided(repo: ScannedRepo): FoundContract[] {
  const found: FoundContract[] = [];
  const candidates = repo.files.filter((f) => !TEST_DIR.test(f.path) && f.size <= MAX_SPEC_BYTES);
  const chartDirs = new Set(
    candidates.filter((f) => baseOf(f.path) === "Chart.yaml").map((f) => dirOf(f.path)),
  );

  const protoDirs: string[] = [];
  const protoPackages = new Set<string>();

  // Generated artifacts are contracts too. The command is the repo's own script, so the
  // factory does not guess a toolchain.
  const pkgText = read(repo.root, "package.json");
  let scripts: Record<string, unknown> = {};
  if (pkgText !== undefined) {
    try {
      scripts = (JSON.parse(pkgText) as { scripts?: Record<string, unknown> }).scripts ?? {};
    } catch {
      scripts = {};
    }
  }
  const runner = /bun\.lockb?/.test(repo.files.map((f) => f.path).join("\n"))
    ? "bun run"
    : "npm run";
  for (const binding of ["src/bindings.ts", "bindings.ts"]) {
    if (candidates.some((f) => f.path === binding) && typeof scripts["gen:bindings"] === "string") {
      found.push({
        kind: "ipc",
        path: binding,
        needles: [binding],
        command: `${runner} gen:bindings`,
        outputs: [binding],
      });
    }
  }
  if (
    candidates.some((f) => f.path === "src/routeTree.gen.ts") &&
    typeof scripts.build === "string"
  ) {
    found.push({
      kind: "generated",
      path: "src/routeTree.gen.ts",
      needles: ["src/routeTree.gen.ts"],
      command: `${runner} build`,
      outputs: ["src/routeTree.gen.ts"],
    });
  }
  for (const dir of ["operator/config/crd/bases", "config/crd/bases"]) {
    if (!candidates.some((f) => f.path.startsWith(`${dir}/`))) continue;
    const taskfile = read(repo.root, "Taskfile.yml") ?? read(repo.root, "Taskfile.yaml");
    if (taskfile !== undefined && /^ {2}manifests:/m.test(taskfile)) {
      const root = dir.includes("/config/crd/bases")
        ? dir.slice(0, dir.indexOf("/config/crd/bases"))
        : ".";
      const outputs = [
        dir,
        ...["config/rbac", "api/v1alpha1/zz_generated.deepcopy.go"].map((path) =>
          root === "." ? path : `${root}/${path}`,
        ),
      ].filter((path) => candidates.some((f) => f.path === path || f.path.startsWith(`${path}/`)));
      found.push({
        kind: "crd",
        path: dir,
        needles: [],
        command: "task manifests generate",
        outputs,
      });
      break;
    }
  }

  for (const file of candidates) {
    const name = baseOf(file.path);
    if (name === "values.schema.json" && chartDirs.has(dirOf(file.path))) {
      found.push({ kind: "helm-values", path: file.path, needles: [] });
    } else if (name.endsWith(".proto")) {
      protoDirs.push(dirOf(file.path));
      const pkg = read(repo.root, file.path)?.match(/^package\s+([\w.]+)\s*;/m)?.[1];
      if (pkg) protoPackages.add(pkg);
    } else if (/\.(ya?ml|json)$/.test(name) && name !== "package.json") {
      const keys = topLevelKeys(repo.root, file.path);
      if (keys === undefined) continue;
      if (typeof keys.openapi === "string" || typeof keys.swagger === "string") {
        found.push({ kind: "openapi", path: file.path, needles: [file.path] });
      } else if (
        name.endsWith(".schema.json") &&
        typeof keys.$schema === "string" &&
        keys.$schema.includes("json-schema")
      ) {
        found.push({ kind: "json-schema", path: file.path, needles: [file.path] });
      }
    }
  }

  // One proto contract per top-most directory holding .proto files.
  const tops = [...new Set(protoDirs)]
    .sort((a, b) => a.length - b.length)
    .filter((dir, i, all) => !all.slice(0, i).some((other) => isWithin(dir, other)));
  for (const dir of tops) {
    found.push({ kind: "proto", path: dir, needles: [...protoPackages].sort() });
  }
  return found;
}

function textFiles(repo: ScannedRepo): string[] {
  return repo.files
    .filter((f) => f.size <= MAX_TEXT_BYTES && TEXT_FILE.test(f.path) && !LOCKFILE.test(f.path))
    .slice(0, MAX_TEXT_FILES)
    .map((f) => f.path);
}

function mentions(repo: ScannedRepo, needles: readonly string[]): boolean {
  if (needles.length === 0) return false;
  return textFiles(repo).some((rel) => {
    const text = read(repo.root, rel);
    return text !== undefined && needles.some((n) => text.includes(n));
  });
}

/**
 * Proposes contracts. Consumers are a heuristic for the user to confirm:
 * - openapi / json-schema: another repo mentions the provider-relative spec path
 * - proto: another repo mentions one of the proto package names
 * - helm-values: the chart's values.yaml mentions another repo by name
 */
export function detectContracts(repos: readonly ScannedRepo[]): ContractConfig[] {
  const contracts: ContractConfig[] = [];
  for (const provider of repos) {
    const others = repos.filter((r) => r.name !== provider.name);
    for (const found of findProvided(provider)) {
      let consumers: string[];
      if (found.kind === "helm-values") {
        const values = read(provider.root, `${dirOf(found.path)}/values.yaml`) ?? "";
        consumers = others
          .filter((r) => new RegExp(`(^|[^a-z0-9-])${r.name}([^a-z0-9-]|$)`, "m").test(values))
          .map((r) => r.name);
      } else {
        consumers = others.filter((r) => mentions(r, found.needles)).map((r) => r.name);
      }
      contracts.push({
        kind: found.kind,
        provider: provider.name,
        path: found.path,
        consumers: consumers.sort(),
        ...(found.command === undefined ? {} : { command: found.command }),
        ...(found.outputs === undefined ? {} : { outputs: found.outputs }),
        ...(found.validate === undefined ? {} : { validate: found.validate }),
      });
    }
  }
  return contracts.sort((a, b) => contractKey(a).localeCompare(contractKey(b)));
}

export function contractKey(c: Pick<ContractConfig, "kind" | "provider" | "path">): string {
  return `${c.kind}:${c.provider}:${c.path}`;
}
