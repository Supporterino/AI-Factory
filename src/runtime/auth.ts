import { type FactoryConfig, providerIds } from "../config/schema.ts";
import { exec } from "../exec.ts";
import { toolBin } from "../tools.ts";

/**
 * opencode 2.x stores `opencode auth login` credentials in the `credential` table of its
 * SQLite database, not in `auth.json` (2.2 imports the legacy file once). The factory points
 * `OPENCODE_DB` at a private database, so its server cannot see the user's credentials.
 *
 * This bridge reads the user's store with `opencode auth export` (with the user's environment,
 * never the private DB) and reconciles only the providers the config names into the private
 * server through `/api/credential`. Nothing here writes to the user's DB, and no secret is
 * ever logged.
 */

export type CredentialValue =
  | { readonly type: "key"; readonly key: string; readonly metadata?: Record<string, unknown> }
  | {
      readonly type: "oauth";
      readonly methodID: string;
      readonly refresh: string;
      readonly access: string;
      readonly expires: number;
      readonly metadata?: Record<string, unknown>;
    }
  | {
      readonly type: "external";
      readonly methodID: string;
      readonly metadata?: Record<string, unknown>;
    };

export interface StoredCredential {
  readonly id: string;
  readonly integrationID: string;
  readonly label: string;
  readonly active: boolean;
  readonly value: CredentialValue;
}

export interface CredentialApi {
  request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ readonly status: number; readonly data: T }>;
}

export interface CredentialSyncSummary {
  readonly created: number;
  readonly updated: number;
  readonly removed: number;
  readonly activated: number;
  readonly skipped: number;
  readonly failed: number;
}

const EXPORT_ENV = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TMPDIR",
  "TZ",
  "XDG_DATA_HOME",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "OPENCODE_DB",
  "OPENCODE_CONFIG",
  "OPENCODE_CONFIG_CONTENT",
  "OPENCODE_CONFIG_DIR",
  "OPENCODE_LOG_LEVEL",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
];

/** The env for `opencode auth export`: the user's store, without the factory's own vars. */
export function credentialExportEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of EXPORT_ENV) {
    const value = base[name];
    if (value !== undefined) env[name] = value;
  }
  return { ...env, NO_COLOR: "1" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function credentialValue(value: unknown): CredentialValue | undefined {
  if (!isRecord(value)) return undefined;
  if (value.type === "key" && typeof value.key === "string") {
    return {
      type: "key",
      key: value.key,
      ...(isRecord(value.metadata) ? { metadata: value.metadata } : {}),
    };
  }
  if (
    value.type === "oauth" &&
    typeof value.methodID === "string" &&
    typeof value.refresh === "string" &&
    typeof value.access === "string" &&
    typeof value.expires === "number"
  ) {
    return {
      type: "oauth",
      methodID: value.methodID,
      refresh: value.refresh,
      access: value.access,
      expires: value.expires,
      ...(isRecord(value.metadata) ? { metadata: value.metadata } : {}),
    };
  }
  if (value.type === "external" && typeof value.methodID === "string") {
    return {
      type: "external",
      methodID: value.methodID,
      ...(isRecord(value.metadata) ? { metadata: value.metadata } : {}),
    };
  }
  return undefined;
}

/** Parse `opencode auth export`; `undefined` means the command failed or printed junk. */
export function parseCredentialExport(raw: string): StoredCredential[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  const out: StoredCredential[] = [];
  for (const entry of parsed) {
    if (!isRecord(entry)) continue;
    const value = credentialValue(entry.value);
    if (
      typeof entry.id !== "string" ||
      typeof entry.integrationID !== "string" ||
      typeof entry.label !== "string" ||
      value === undefined
    )
      continue;
    out.push({
      id: entry.id,
      integrationID: entry.integrationID,
      label: entry.label,
      active: entry.active === true,
      value,
    });
  }
  return out;
}

/**
 * Read the user's stored credentials. Uses the user's environment (so `XDG_*` and a custom
 * `OPENCODE_DB` are honoured) and never the private server's database. `undefined` means the
 * export failed, so callers must not treat it as "no credentials" and prune anything.
 */
export async function readStoredCredentials(
  root: string,
  base: NodeJS.ProcessEnv = process.env,
): Promise<StoredCredential[] | undefined> {
  // The binary override lives in the process env (like the server spawn), while `base` is the
  // curated environment handed to the child.
  const res = await exec([toolBin("opencode"), "auth", "export"], {
    cwd: root,
    env: credentialExportEnv(base),
    replaceEnv: true,
    timeoutMs: 15_000,
  });
  if (res.code !== 0) return undefined;
  return parseCredentialExport(res.stdout);
}

/** The providers whose credentials the private server may see. */
export function credentialProviders(config: FactoryConfig): string[] {
  const out = new Set(providerIds(config));
  const search = config.websearch;
  if (search !== false && search.provider !== "random") out.add(search.provider);
  return [...out].sort();
}

export function scopeCredentials(
  entries: readonly StoredCredential[],
  providers: readonly string[],
): StoredCredential[] {
  const wanted = new Set(providers);
  return entries.filter((entry) => wanted.has(entry.integrationID));
}

const metadata = (value: CredentialValue): string =>
  JSON.stringify("metadata" in value ? (value.metadata ?? {}) : {});

/** Whether a private credential must be replaced by the user's current copy. */
function needsReplace(current: StoredCredential, next: StoredCredential): boolean {
  if (current.value.type !== next.value.type) return true;
  if (current.value.type === "key" && next.value.type === "key")
    return current.value.key !== next.value.key || metadata(current.value) !== metadata(next.value);
  if (current.value.type === "oauth" && next.value.type === "oauth") {
    // The private server refreshes OAuth tokens and writes them back to its own DB. Keep that
    // copy unless it has expired and the user's copy is newer; overwriting with a stale
    // refresh token can rotate the token family and break both stores.
    return (
      current.value.expires > 0 &&
      current.value.expires <= Date.now() &&
      next.value.expires > current.value.expires
    );
  }
  // External credentials are references to a connector source; keep an existing one.
  return false;
}

const createBody = (entry: StoredCredential): Record<string, unknown> => ({
  id: entry.id,
  integrationID: entry.integrationID,
  label: entry.label,
  activate: entry.active,
  value: entry.value,
});

const credentialPath = (id: string): string => `/api/credential/${encodeURIComponent(id)}`;

/**
 * Make the private server's credential table mirror the scoped part of the user's store:
 * remove credentials the user logged out of (or that are no longer configured), create
 * missing ones, update rotated API keys, and keep the same active account.
 */
export async function syncCredentials(
  api: CredentialApi,
  scoped: readonly StoredCredential[],
): Promise<CredentialSyncSummary> {
  const listed = await api.request<StoredCredential[]>("GET", "/api/credential");
  if (listed.status === 404)
    throw new Error("opencode does not expose /api/credential (unsupported version)");
  if (listed.status >= 400) throw new Error(`GET /api/credential failed (${listed.status})`);
  const current = Array.isArray(listed.data) ? listed.data : [];
  const wanted = new Set(scoped.map((entry) => entry.id));

  let removed = 0;
  let created = 0;
  let updated = 0;
  let activated = 0;
  let skipped = 0;
  let failed = 0;

  for (const entry of current) {
    if (wanted.has(entry.id)) continue;
    try {
      const res = await api.request("DELETE", credentialPath(entry.id));
      if (res.status >= 400 && res.status !== 404) failed += 1;
      else removed += 1;
    } catch {
      failed += 1;
    }
  }

  // Create inactive credentials first so the source's active one wins in every integration.
  const ordered = [...scoped].sort((a, b) => Number(a.active) - Number(b.active));
  for (const entry of ordered) {
    const existing = current.find((candidate) => candidate.id === entry.id);
    try {
      if (existing === undefined) {
        const res = await api.request("POST", "/api/credential", createBody(entry));
        if (res.status === 409) skipped += 1;
        else if (res.status >= 400) failed += 1;
        else created += 1;
        continue;
      }
      if (!needsReplace(existing, entry)) {
        skipped += 1;
        continue;
      }
      const deleted = await api.request("DELETE", credentialPath(entry.id));
      if (deleted.status >= 400 && deleted.status !== 404) {
        failed += 1;
        continue;
      }
      const res = await api.request("POST", "/api/credential", createBody(entry));
      if (res.status >= 400) failed += 1;
      else updated += 1;
    } catch {
      failed += 1;
    }
  }

  // Preserve the user's active account after all creates/replacements.
  for (const entry of scoped) {
    if (!entry.active) continue;
    try {
      const res = await api.request("POST", `${credentialPath(entry.id)}/activate`);
      if (res.status >= 400 && res.status !== 404) failed += 1;
      else activated += 1;
    } catch {
      failed += 1;
    }
  }

  return { created, updated, removed, activated, skipped, failed };
}
