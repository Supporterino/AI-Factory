import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { z } from "zod";
import { ConfigError } from "../errors.ts";
import { git } from "../exec.ts";
import { parseJsonc } from "./jsonc.ts";
import { CONFIG_FILE, CONFIG_SCHEMA_VERSION, FactoryConfig } from "./schema.ts";

export interface LoadedConfig {
  readonly root: string;
  readonly file: string;
  /** Raw file text, kept so edits can preserve comments. */
  readonly text: string;
  readonly config: FactoryConfig;
}

/** Nearest ancestor of `start` (inclusive) that contains `factory.config.jsonc`. */
export function findConfigRoot(start: string): string | undefined {
  // Real path, so it compares equal to what git reports (/var vs /private/var on macOS).
  let dir = realpathSync(resolve(start));
  for (;;) {
    if (existsSync(join(dir, CONFIG_FILE))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * The workspace root: the nearest config root, else the outermost git superproject
 * containing `start` (so running inside a submodule finds the AI repo).
 */
export async function findWorkspaceRoot(start: string): Promise<string | undefined> {
  const configRoot = findConfigRoot(start);
  if (configRoot) return configRoot;
  const top = await git(["rev-parse", "--show-toplevel"], { cwd: start });
  if (top.code !== 0) return undefined;
  let root = top.stdout.trim();
  for (;;) {
    const sup = await git(["rev-parse", "--show-superproject-working-tree"], { cwd: root });
    const parent = sup.stdout.trim();
    if (sup.code !== 0 || parent === "") return root;
    root = parent;
  }
}

export function formatZodIssues(error: z.ZodError): string[] {
  return error.issues.map((i) => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`);
}

export function parseConfigText(text: string, file: string): FactoryConfig {
  const { value, errors } = parseJsonc(text);
  if (errors.length > 0) {
    throw new ConfigError(`${file} is not valid JSONC`, errors);
  }
  const version = (value as { schemaVersion?: unknown } | undefined)?.schemaVersion;
  if (typeof version === "number" && version < CONFIG_SCHEMA_VERSION) {
    throw new ConfigError(
      `${file} uses config schemaVersion ${version}; this factory needs ${CONFIG_SCHEMA_VERSION}`,
      ["run `ai-factory update` to migrate it"],
    );
  }
  const parsed = FactoryConfig.safeParse(value);
  if (!parsed.success) {
    throw new ConfigError(`${file} is invalid`, formatZodIssues(parsed.error));
  }
  return parsed.data;
}

export function loadConfig(root: string): LoadedConfig {
  const file = join(root, CONFIG_FILE);
  if (!existsSync(file)) {
    throw new ConfigError(`no ${CONFIG_FILE} in ${root}`, ["run `ai-factory init` first"]);
  }
  const text = readFileSync(file, "utf8");
  return { root, file, text, config: parseConfigText(text, CONFIG_FILE) };
}
