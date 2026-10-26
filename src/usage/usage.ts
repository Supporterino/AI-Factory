import { existsSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
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

/** Counts the plugin's `waste` log lines for a change. */
export function wastedReads(root: string, id: string): number {
  const dir = factoryDir(root, "logs", id);
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const f of readdirSync(dir)) {
    for (const line of readFileSync(join(dir, f), "utf8").split("\n"))
      if (line.includes('"kind":"waste"')) n++;
  }
  return n;
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
