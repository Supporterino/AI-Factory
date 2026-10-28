import { parseJsonc } from "../config/jsonc.ts";
import { CONFIG_SCHEMA_VERSION } from "../config/schema.ts";
import { ConfigError } from "../errors.ts";
import { graphExcludeDefaults } from "./001-graph-exclude-defaults.ts";
import { configV3 } from "./002-config-v3.ts";
import { artifactsV4 } from "./003-artifacts.ts";
import type { Migration } from "./types.ts";

/** Every config migration, in order. Add new ones as `NNN-<name>.ts` and list them here. */
export const MIGRATIONS: readonly Migration[] = [graphExcludeDefaults, configV3, artifactsV4];

export function schemaVersionOf(text: string): number | undefined {
  const { value } = parseJsonc(text);
  const v = (value as { schemaVersion?: unknown } | undefined)?.schemaVersion;
  return typeof v === "number" ? v : undefined;
}

export interface MigrationResult {
  readonly text: string;
  readonly from: number;
  readonly to: number;
  readonly applied: string[];
}

/** Applies every pending migration in order. Pure: text in, text out. */
export function migrateConfigText(
  text: string,
  migrations: readonly Migration[] = MIGRATIONS,
): MigrationResult {
  const from = schemaVersionOf(text);
  if (from === undefined) throw new ConfigError("factory.config.jsonc has no schemaVersion");
  if (from > CONFIG_SCHEMA_VERSION) {
    throw new ConfigError(
      `factory.config.jsonc has schemaVersion ${from}, newer than this factory (${CONFIG_SCHEMA_VERSION})`,
      ["install a newer ai-factory"],
    );
  }
  let current = from;
  let out = text;
  const applied: string[] = [];
  while (current < CONFIG_SCHEMA_VERSION) {
    const step = migrations.find((m) => m.from === current);
    if (step === undefined)
      throw new ConfigError(`no migration from config schemaVersion ${current}`);
    out = step.migrate(out);
    if (schemaVersionOf(out) !== step.to)
      throw new ConfigError(`migration ${step.name} did not set schemaVersion ${step.to}`);
    applied.push(`${String(step.from).padStart(3, "0")}-${step.name}`);
    current = step.to;
  }
  return { text: out, from, to: current, applied };
}
