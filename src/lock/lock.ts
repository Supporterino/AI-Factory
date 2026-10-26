import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { formatZodIssues } from "../config/load.ts";
import { CONFIG_SCHEMA_VERSION } from "../config/schema.ts";
import { ConfigError, PreconditionError } from "../errors.ts";
import { compareVersions } from "../tools.ts";
import { FACTORY_VERSION, runVersion } from "../version.ts";
import { GIT, GRAPHIFY, OPENCODE, OPENSPEC } from "../versions.ts";

export const LOCK_FILE = "factory.lock.json";
export const LOCK_VERSION = 1;

export const LockEntry = z.strictObject({
  /** Template id, e.g. "agents/implementer". */
  template: z.string().min(1),
  /** Factory version whose template produced the content. */
  templateVersion: z.string().min(1),
  mode: z.enum(["file", "block"]),
  /** sha256 of the content as rendered (the block text for block files). */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** git blob id of the rendered content: the merge base for `update` (ADR-0014). */
  blob: z.string().regex(/^[0-9a-f]{40,64}$/),
});
export type LockEntry = z.infer<typeof LockEntry>;

const ToolPin = z.strictObject({
  min: z.string(),
  maxExclusive: z.string().optional(),
  tested: z.string(),
});

export const Lock = z.strictObject({
  lockVersion: z.literal(LOCK_VERSION),
  factoryVersion: z.string(),
  configSchemaVersion: z.int(),
  tools: z.strictObject({ git: ToolPin, opencode: ToolPin, openspec: ToolPin, graphify: ToolPin }),
  graph: z.strictObject({ schemaVersion: z.int() }),
  /** Pinned add-ons with their verified content hash (§10). */
  addons: z
    .strictObject({
      ponytail: z
        .strictObject({ ref: z.string(), contentSha256: z.string(), files: z.array(z.string()) })
        .optional(),
    })
    .default({}),
  managed: z.record(z.string(), LockEntry),
});
export type Lock = z.infer<typeof Lock>;

/** The lock this factory version writes, with the given managed entries. */
export function buildLock(
  managed: Readonly<Record<string, LockEntry>>,
  addons: Lock["addons"] = {},
): Lock {
  const sorted = Object.fromEntries(Object.entries(managed).sort(([a], [b]) => a.localeCompare(b)));
  return {
    lockVersion: LOCK_VERSION,
    factoryVersion: FACTORY_VERSION,
    configSchemaVersion: CONFIG_SCHEMA_VERSION,
    tools: {
      git: { min: GIT.min, tested: GIT.tested },
      opencode: { min: OPENCODE.min, maxExclusive: OPENCODE.maxExclusive, tested: OPENCODE.tested },
      openspec: { min: OPENSPEC.min, maxExclusive: OPENSPEC.maxExclusive, tested: OPENSPEC.tested },
      graphify: { min: GRAPHIFY.min, maxExclusive: GRAPHIFY.maxExclusive, tested: GRAPHIFY.tested },
    },
    graph: { schemaVersion: GRAPHIFY.graphSchemaVersion },
    addons,
    managed: sorted,
  };
}

export function serializeLock(lock: Lock): string {
  return `${JSON.stringify(lock, null, 2)}\n`;
}

export function readLock(root: string): Lock | undefined {
  const file = join(root, LOCK_FILE);
  if (!existsSync(file)) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new ConfigError(`${LOCK_FILE} is not valid JSON`, [String(err)]);
  }
  const parsed = Lock.safeParse(value);
  if (!parsed.success)
    throw new ConfigError(`${LOCK_FILE} is invalid`, formatZodIssues(parsed.error));
  return parsed.data;
}

/**
 * An older CLI must not rewrite a workspace a newer one installed: its templates, migrations
 * and lock format would silently go back a version. `allow` opts in on purpose.
 */
export function ensureNotNewer(lock: Lock | undefined, allow = false): void {
  if (lock === undefined || allow) return;
  if (compareVersions(lock.factoryVersion, FACTORY_VERSION) <= 0) return;
  throw new PreconditionError(
    `this workspace was installed by ai-factory ${lock.factoryVersion}; this is ${FACTORY_VERSION}, which would downgrade it`,
    [
      `run the matching version: ${runVersion(lock.factoryVersion)} <command>`,
      "or pass --allow-downgrade to go back on purpose",
    ],
  );
}
