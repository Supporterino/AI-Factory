import { existsSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { join, relative } from "node:path";
import { artifactDir, artifactFile } from "../artifacts/paths.ts";
import { addUsage, type Usage, ZERO_USAGE } from "../runtime/types.ts";
import { factoryDir, readJson, withFileLock, writeJsonAtomic } from "../state/files.ts";

/**
 * Token usage (§11): every agent session is recorded per change in `.factory/usage/<id>.json`
 * (from opencode's per-session token counts). Reported in `status` and the change reports,
 * never used to block or stop a run.
 */

export interface UsageEntry {
  readonly at: string;
  readonly sessionId: string;
  readonly agent: string;
  readonly model: string;
  /** Task id, or a step name ("intake", "design", "explore:backend", "review:frontend", …). */
  readonly step: string;
  /** "attempt" (with its number), "conflict" (merge-conflict resolution) or "step". */
  readonly kind: "attempt" | "conflict" | "step";
  readonly attempt?: number;
  readonly usage: Usage;
}

export interface UsageLedger {
  readonly version: 1;
  readonly changeId: string;
  readonly entries: UsageEntry[];
  /** Present only in the committed snapshot: logs stay local, so the count travels with it. */
  readonly wastedReads?: number;
}

const usageFile = (root: string, id: string): string => factoryDir(root, "usage", `${id}.json`);

function readLedger(file: string): UsageLedger | undefined {
  try {
    const ledger = readJson(file) as UsageLedger;
    return Array.isArray(ledger?.entries) ? ledger : undefined;
  } catch {
    return undefined;
  }
}

/** The change's ledger; a corrupt one reads as empty, since usage never stops a run (P15). */
export function loadUsage(root: string, id: string): UsageLedger {
  const file = usageFile(root, id);
  const empty: UsageLedger = { version: 1, changeId: id, entries: [] };
  if (!existsSync(file)) return empty;
  return readLedger(file) ?? empty;
}

export function recordUsage(root: string, id: string, entry: UsageEntry): Promise<void> {
  return withFileLock(`${usageFile(root, id)}.lock`, () => {
    const file = usageFile(root, id);
    // A corrupt ledger is kept aside for inspection and a new one started.
    if (existsSync(file) && readLedger(file) === undefined) renameSync(file, `${file}.corrupt`);
    const ledger = loadUsage(root, id);
    writeJsonAtomic(usageFile(root, id), { ...ledger, entries: [...ledger.entries, entry] });
  });
}

/** Everything the model read or wrote: fresh input, cache reads and writes, output, reasoning. */
export const totalTokens = (u: Usage): number =>
  u.input + u.cacheRead + u.cacheWrite + u.output + u.reasoning;

export interface UsageSummary {
  readonly total: Usage;
  readonly sessions: number;
  readonly byAgent: Record<string, Usage>;
  readonly byStep: Record<string, Usage>;
  readonly byModel: Record<string, Usage>;
  /** Attempts after the first plus conflict resolutions. */
  readonly retryOverhead: Usage;
  /** Steps sorted by total tokens, largest first. */
  readonly top: { step: string; tokens: number }[];
  /** Repeated reads of unchanged files logged by the plugin. */
  readonly wastedReads: number;
}

const bump = (map: Record<string, Usage>, key: string, u: Usage): void => {
  map[key] = addUsage(map[key] ?? ZERO_USAGE, u);
};

/**
 * Counts the plugin's `waste` log lines for a change. Logs never leave the machine, so when
 * they are gone (fresh clone, `land` cleanup) the committed snapshot's own count is used.
 */
export function wastedReads(root: string, id: string): number {
  const dir = factoryDir(root, "logs", id);
  if (!existsSync(dir)) return snapshotWastedReads(root, id);
  let n = 0;
  for (const f of readdirSync(dir)) {
    for (const line of readFileSync(join(dir, f), "utf8").split("\n"))
      if (line.includes('"kind":"waste"')) n++;
  }
  return n;
}

/** The `wastedReads` recorded in the committed snapshot, if there is one. */
function snapshotWastedReads(root: string, id: string): number {
  const file = artifactFile(root, "usage", `${id}.json`);
  if (!existsSync(file)) return 0;
  const value = readLedger(file)?.wastedReads;
  return typeof value === "number" ? value : 0;
}

export function summarizeUsage(root: string, id: string): UsageSummary {
  const ledger = loadUsage(root, id);
  let total = ZERO_USAGE;
  let retryOverhead = ZERO_USAGE;
  const byAgent: Record<string, Usage> = {};
  const byStep: Record<string, Usage> = {};
  const byModel: Record<string, Usage> = {};
  for (const e of ledger.entries) {
    total = addUsage(total, e.usage);
    bump(byAgent, e.agent, e.usage);
    bump(byStep, e.step, e.usage);
    bump(byModel, e.model, e.usage);
    if (e.kind === "conflict" || (e.kind === "attempt" && (e.attempt ?? 1) > 1))
      retryOverhead = addUsage(retryOverhead, e.usage);
  }
  const top = Object.entries(byStep)
    .map(([step, u]) => ({ step, tokens: totalTokens(u) }))
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 5);
  return {
    total,
    sessions: ledger.entries.length,
    byAgent,
    byStep,
    byModel,
    retryOverhead,
    top,
    wastedReads: wastedReads(root, id),
  };
}

export interface WorkspaceUsageFilter {
  /** Inclusive UTC day, `YYYY-MM-DD`. */
  readonly since?: string;
  /** Inclusive UTC day, `YYYY-MM-DD`. */
  readonly until?: string;
  readonly changes?: readonly string[];
  readonly agents?: readonly string[];
  readonly models?: readonly string[];
}

export type UsageDimension = "change" | "agent" | "model" | "day";

/** Everything the factory spent in one workspace, across every change and quick task. */
export interface WorkspaceUsageSummary {
  readonly total: Usage;
  readonly sessions: number;
  readonly changes: number;
  readonly entries: number;
  readonly first?: string;
  readonly last?: string;
  readonly retryOverhead: Usage;
  readonly wastedReads: number;
  readonly byChange: Record<string, Usage>;
  readonly sessionsByChange: Record<string, number>;
  readonly byAgent: Record<string, Usage>;
  readonly byModel: Record<string, Usage>;
  readonly byDay: Record<string, Usage>;
  /** Ledger files that could not be read; the report still covers the rest. */
  readonly corrupt: string[];
}

interface UsageFile {
  readonly id: string;
  readonly file: string;
  readonly ledger: UsageLedger | undefined;
}

function usageFiles(root: string): UsageFile[] {
  const files = new Map<string, UsageFile>();
  for (const dir of [factoryDir(root, "usage"), artifactDir(root, "usage")]) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -".json".length);
      // The live local ledger wins; the committed snapshot covers ids that are gone.
      if (files.has(id)) continue;
      const file = join(dir, name);
      files.set(id, { id, file, ledger: readLedger(file) });
    }
  }
  return [...files.values()];
}

const matches = (entry: UsageEntry, filter: WorkspaceUsageFilter, id: string): boolean => {
  if (filter.changes !== undefined && !filter.changes.includes(id)) return false;
  if (filter.agents !== undefined && !filter.agents.includes(entry.agent)) return false;
  if (filter.models !== undefined && !filter.models.includes(entry.model)) return false;
  const day = entry.at.slice(0, 10);
  if (filter.since !== undefined && day < filter.since) return false;
  if (filter.until !== undefined && day > filter.until) return false;
  return true;
};

/**
 * Aggregates every ledger (changes, quick tasks, intake): the live `.factory/usage/<id>.json`
 * and, when artifacts are tracked, the committed `factory-records/usage/<id>.json`. Read-only:
 * a corrupt ledger is listed and skipped, never fatal.
 */
export function summarizeWorkspaceUsage(
  root: string,
  filter: WorkspaceUsageFilter = {},
): WorkspaceUsageSummary {
  let total = ZERO_USAGE;
  let retryOverhead = ZERO_USAGE;
  let sessions = 0;
  let entries = 0;
  let first: string | undefined;
  let last: string | undefined;
  const byChange: Record<string, Usage> = {};
  const sessionsByChange: Record<string, number> = {};
  const byAgent: Record<string, Usage> = {};
  const byModel: Record<string, Usage> = {};
  const byDay: Record<string, Usage> = {};
  const included = new Set<string>();
  const corrupt: string[] = [];

  for (const file of usageFiles(root)) {
    if (file.ledger === undefined) {
      corrupt.push(relative(root, file.file));
      continue;
    }
    for (const entry of file.ledger.entries) {
      if (!matches(entry, filter, file.id)) continue;
      included.add(file.id);
      total = addUsage(total, entry.usage);
      sessions += 1;
      entries += 1;
      bump(byChange, file.id, entry.usage);
      sessionsByChange[file.id] = (sessionsByChange[file.id] ?? 0) + 1;
      bump(byAgent, entry.agent, entry.usage);
      bump(byModel, entry.model, entry.usage);
      bump(byDay, entry.at.slice(0, 10), entry.usage);
      if (entry.kind === "conflict" || (entry.kind === "attempt" && (entry.attempt ?? 1) > 1))
        retryOverhead = addUsage(retryOverhead, entry.usage);
      if (first === undefined || entry.at < first) first = entry.at;
      if (last === undefined || entry.at > last) last = entry.at;
    }
  }

  let wasted = 0;
  for (const id of included) wasted += wastedReads(root, id);
  return {
    total,
    sessions,
    changes: included.size,
    entries,
    ...(first === undefined ? {} : { first }),
    ...(last === undefined ? {} : { last }),
    retryOverhead,
    wastedReads: wasted,
    byChange,
    sessionsByChange,
    byAgent,
    byModel,
    byDay,
    corrupt,
  };
}

const sortedUsage = (map: Record<string, Usage>): [string, Usage][] =>
  Object.entries(map).sort((a, b) => totalTokens(b[1]) - totalTokens(a[1]));

/** The `usage` command's tables; `dimensions` selects which ones to print. */
export function workspaceUsageReport(
  summary: WorkspaceUsageSummary,
  dimensions: readonly UsageDimension[] = ["change", "agent", "model"],
): string[] {
  const total = totalTokens(summary.total);
  const share = (u: Usage): string =>
    total === 0 ? "0%" : `${Math.round((totalTokens(u) / total) * 100)}%`;
  const lines = [
    `Total: ${usageLine(summary.total)} over ${summary.sessions} session${summary.sessions === 1 ? "" : "s"} in ${summary.changes} change${summary.changes === 1 ? "" : "s"}.`,
  ];
  if (summary.first !== undefined)
    lines.push(`Period: ${summary.first.slice(0, 10)} → ${summary.last?.slice(0, 10) ?? ""}`);
  lines.push(
    `Retry overhead: ${formatTokens(totalTokens(summary.retryOverhead))} tokens (${share(summary.retryOverhead)}) · wasted re-reads: ${summary.wastedReads}`,
    "",
  );
  for (const dimension of dimensions) {
    if (dimension === "change") {
      lines.push(
        "By change",
        "| Change | Tokens | Share | Cost | Sessions |",
        "|---|---|---|---|---|",
        ...sortedUsage(summary.byChange).map(
          ([id, u]) =>
            `| ${id} | ${formatTokens(totalTokens(u))} | ${share(u)} | ${formatCost(u.cost)} | ${summary.sessionsByChange[id] ?? 0} |`,
        ),
        "",
      );
    } else if (dimension === "day") {
      lines.push(
        "By day",
        "| Day | Tokens | Share | Cost |",
        "|---|---|---|---|",
        ...Object.entries(summary.byDay)
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(
            ([day, u]) =>
              `| ${day} | ${formatTokens(totalTokens(u))} | ${share(u)} | ${formatCost(u.cost)} |`,
          ),
        "",
      );
    } else {
      const title = dimension === "agent" ? "Agent" : "Model";
      const map = dimension === "agent" ? summary.byAgent : summary.byModel;
      lines.push(
        `By ${dimension}`,
        `| ${title} | Tokens | Share | Cost |`,
        "|---|---|---|---|",
        ...sortedUsage(map).map(
          ([name, u]) =>
            `| ${name} | ${formatTokens(totalTokens(u))} | ${share(u)} | ${formatCost(u.cost)} |`,
        ),
        "",
      );
    }
  }
  return lines;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export const formatCost = (usd: number): string => (usd > 0 ? `$${usd.toFixed(2)}` : "cost n/a");

/** One line: "12.3k tokens (8.1k cached read) · 1.2k out · $0.42". */
export function usageLine(u: Usage): string {
  return `${formatTokens(totalTokens(u))} tokens (${formatTokens(u.cacheRead)} cache read, ${formatTokens(u.output)} out) · ${formatCost(u.cost)}`;
}

/** The report section (§11): totals, by agent, top consumers, retry overhead, wasted re-reads. */
export function usageReport(summary: UsageSummary): string[] {
  const total = totalTokens(summary.total);
  const share = (u: Usage): string =>
    total === 0 ? "0%" : `${Math.round((totalTokens(u) / total) * 100)}%`;
  return [
    "## Usage",
    "",
    `Total: ${usageLine(summary.total)} over ${summary.sessions} session${summary.sessions === 1 ? "" : "s"}.`,
    "",
    "| Agent | Tokens | Share | Cost |",
    "|---|---|---|---|",
    ...Object.entries(summary.byAgent)
      .sort((a, b) => totalTokens(b[1]) - totalTokens(a[1]))
      .map(
        ([agent, u]) =>
          `| ${agent} | ${formatTokens(totalTokens(u))} | ${share(u)} | ${formatCost(u.cost)} |`,
      ),
    "",
    // Per task and step (§14), largest first.
    "| Task or step | Tokens | Share | Cost |",
    "|---|---|---|---|",
    ...Object.entries(summary.byStep)
      .sort((a, b) => totalTokens(b[1]) - totalTokens(a[1]))
      .map(
        ([step, u]) =>
          `| ${step} | ${formatTokens(totalTokens(u))} | ${share(u)} | ${formatCost(u.cost)} |`,
      ),
    "",
    `Top consumers: ${summary.top.map((t) => `${t.step} (${formatTokens(t.tokens)})`).join(", ") || "none"}.`,
    `Retry overhead: ${formatTokens(totalTokens(summary.retryOverhead))} tokens (${share(summary.retryOverhead)}).`,
    `Wasted re-reads of unchanged files: ${summary.wastedReads}.`,
    "",
  ];
}
