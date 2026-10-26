import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAllDocuments } from "yaml";
import { LANGUAGES, type Language } from "../config/schema.ts";
import { baseOf, dirOf, type FileEntry, isWithin } from "./walk.ts";

export interface LanguageDetection {
  /** Union over the whole repo, in canonical order. */
  readonly languages: Language[];
  /** Directories whose languages differ from their nearest marked ancestor. */
  readonly subPaths: { path: string; languages: Language[] }[];
}

const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_YAML_CHECKS = 500;

export function sortLanguages(langs: Iterable<Language>): Language[] {
  const set = new Set(langs);
  return LANGUAGES.filter((l) => set.has(l));
}

function readText(root: string, rel: string): string | undefined {
  try {
    return readFileSync(join(root, rel), "utf8");
  } catch {
    return undefined;
  }
}

function usesReact(root: string, packageJsonPath: string): boolean {
  const text = readText(root, packageJsonPath);
  if (text === undefined) return false;
  let pkg: unknown;
  try {
    pkg = JSON.parse(text);
  } catch {
    return false;
  }
  if (typeof pkg !== "object" || pkg === null) return false;
  const record = pkg as Record<string, unknown>;
  return ["dependencies", "devDependencies", "peerDependencies"].some((key) => {
    const deps = record[key];
    return typeof deps === "object" && deps !== null && "react" in deps;
  });
}

/** A plain Kubernetes manifest: every YAML document is a map with string apiVersion and kind. */
function isK8sManifest(root: string, rel: string): boolean {
  const text = readText(root, rel);
  if (text === undefined || !text.includes("apiVersion") || !text.includes("kind")) return false;
  try {
    const docs = parseAllDocuments(text, { logLevel: "silent" }).filter((d) => d.contents !== null);
    return (
      docs.length > 0 &&
      docs.every((d) => {
        if (d.errors.length > 0) return false;
        const value: unknown = d.toJS();
        if (typeof value !== "object" || value === null) return false;
        const rec = value as Record<string, unknown>;
        return typeof rec.apiVersion === "string" && typeof rec.kind === "string";
      })
    );
  } catch {
    return false;
  }
}

const TAURI_CONFIGS = new Set(["tauri.conf.json", "tauri.conf.json5", "Tauri.toml"]);

/**
 * Tauri v2 only: the `tauri` dependency's major version in the Cargo.toml next to the config,
 * or (for `workspace = true` and the like) a config without the v1 keys `distDir`/`devPath`.
 */
function isTauriV2(root: string, dir: string, configPath: string): boolean {
  const cargo = readText(root, dir === "." ? "Cargo.toml" : `${dir}/Cargo.toml`) ?? "";
  const major =
    cargo.match(/^\s*tauri\s*=\s*(?:\{[^}\n]*?version\s*=\s*)?"[\^~=<>]*(\d+)/m)?.[1] ??
    cargo.match(
      /^\[(?:[\w.-]+\.)?dependencies\.tauri\][^[]*?^\s*version\s*=\s*"[\^~=<>]*(\d+)/ms,
    )?.[1];
  if (major !== undefined) return major === "2";
  const config = readText(root, configPath) ?? "";
  return !/\bdistDir\b|\bdevPath\b/.test(config);
}

/**
 * Detects languages from manifests and markers:
 * - package.json → typescript (the TS/JS profile); a react dependency adds react
 * - pyproject.toml / requirements*.txt → python; go.mod → go; Cargo.toml → rust
 * - Chart.yaml or plain Kubernetes manifests → helm
 * - tauri.conf.json / tauri.conf.json5 / Tauri.toml of a Tauri v2 app → tauri (with rust from
 *   its Cargo.toml; the tauri profile runs the cargo gates there)
 */
export function detectLanguages(root: string, files: readonly FileEntry[]): LanguageDetection {
  const byDir = new Map<string, Set<Language>>();
  const mark = (dir: string, lang: Language): void => {
    const set = byDir.get(dir) ?? new Set<Language>();
    set.add(lang);
    byDir.set(dir, set);
  };

  const chartDirs = files.filter((f) => baseOf(f.path) === "Chart.yaml").map((f) => dirOf(f.path));
  let yamlChecks = 0;

  for (const file of files) {
    const name = baseOf(file.path);
    const dir = dirOf(file.path);
    if (name === "package.json") {
      mark(dir, "typescript");
      if (file.size <= MAX_MANIFEST_BYTES && usesReact(root, file.path)) mark(dir, "react");
    } else if (name === "pyproject.toml" || /^requirements.*\.txt$/.test(name)) {
      mark(dir, "python");
    } else if (name === "go.mod") {
      mark(dir, "go");
    } else if (name === "Cargo.toml") {
      mark(dir, "rust");
    } else if (TAURI_CONFIGS.has(name)) {
      if (isTauriV2(root, dir, file.path)) mark(dir, "tauri");
    } else if (name === "Chart.yaml") {
      mark(dir, "helm");
    } else if (
      /\.ya?ml$/.test(name) &&
      file.size <= MAX_MANIFEST_BYTES &&
      yamlChecks < MAX_YAML_CHECKS &&
      !chartDirs.some((chart) => isWithin(dir, chart))
    ) {
      yamlChecks++;
      // Manifests are grouped by their top-level directory (k8s/base, k8s/prod → k8s).
      if (isK8sManifest(root, file.path))
        mark(dir === "." ? "." : (dir.split("/")[0] ?? "."), "helm");
    }
  }

  const languages = sortLanguages([...byDir.values()].flatMap((s) => [...s]));
  const rootSet = sortLanguages(byDir.get(".") ?? []);

  // Shallow directories first, so each dir is compared with its nearest marked ancestor.
  const dirs = [...byDir.keys()]
    .filter((d) => d !== ".")
    .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
  const emitted: { path: string; languages: Language[] }[] = [];
  for (const dir of dirs) {
    const own = sortLanguages(byDir.get(dir) ?? []);
    const ancestor = [...emitted].reverse().find((e) => isWithin(dir, e.path));
    const reference = ancestor?.languages ?? rootSet;
    if (own.join(",") !== reference.join(",")) emitted.push({ path: dir, languages: own });
  }

  return { languages, subPaths: emitted.sort((a, b) => a.path.localeCompare(b.path)) };
}
