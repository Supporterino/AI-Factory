import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { redact, secretEnvValues } from "./redact.ts";

/**
 * Tool-call and gate logs: `.factory/logs/<change>/<YYYY-MM-DD>.jsonl`, one JSON object per
 * line, redacted before it touches the disk, pruned after `logs.retentionDays`.
 */

export interface LogEntry {
  readonly kind: string;
  readonly [key: string]: unknown;
}

const logDir = (root: string, changeId: string): string => join(root, ".factory", "logs", changeId);

export function appendLog(
  root: string,
  changeId: string,
  entry: LogEntry,
  options: { redact?: boolean; env?: Readonly<Record<string, string | undefined>> } = {},
): void {
  const dir = logDir(root, changeId);
  mkdirSync(dir, { recursive: true });
  const at = new Date();
  let line = JSON.stringify({ at: at.toISOString(), ...entry });
  if (options.redact ?? true) line = redact(line, secretEnvValues(options.env ?? process.env));
  appendFileSync(join(dir, `${at.toISOString().slice(0, 10)}.jsonl`), `${line}\n`);
}

/** Deletes log files older than `retentionDays` and empty change dirs. Returns removed paths. */
export function pruneLogs(root: string, retentionDays: number, now = Date.now()): string[] {
  const base = join(root, ".factory", "logs");
  if (!existsSync(base)) return [];
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
  const removed: string[] = [];
  for (const change of readdirSync(base)) {
    const dir = join(base, change);
    if (!statSync(dir).isDirectory()) continue;
    for (const file of readdirSync(dir)) {
      const abs = join(dir, file);
      if (statSync(abs).mtimeMs < cutoff) {
        rmSync(abs, { force: true });
        removed.push(abs);
      }
    }
    if (readdirSync(dir).length === 0) rmdirSync(dir);
  }
  return removed;
}
