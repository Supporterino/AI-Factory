import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, join, relative } from "node:path";
import type { z } from "zod";
import { formatZodIssues } from "../config/load.ts";
import { PreconditionError } from "../errors.ts";

/** `.factory/` layout: gitignored runtime state of the workspace. */
export const factoryDir = (root: string, ...parts: string[]): string =>
  join(root, ".factory", ...parts);

/**
 * A state file that does not parse (audit P15): named, with a way out, instead of an internal
 * error in every command that reads it.
 */
export class CorruptStateError extends PreconditionError {
  constructor(
    readonly file: string,
    reason: string,
    readonly fix: string,
  ) {
    super(`${file} is corrupt (${reason})`, [fix]);
  }
}

/** Reads and validates a state file; undefined when it does not exist. */
export function readState<T>(
  root: string,
  path: string,
  schema: z.ZodType<T>,
  fix: string,
): T | undefined {
  if (!existsSync(path)) return undefined;
  const file = relative(root, path);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new CorruptStateError(file, err instanceof Error ? err.message : String(err), fix);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success)
    throw new CorruptStateError(file, formatZodIssues(parsed.error).join("; "), fix);
  return parsed.data;
}

/** For commands that report state: the value, or the corruption to show in its place. */
export function readOrCorrupt<T>(
  read: () => T,
): { value: T; corrupt?: undefined } | { value?: undefined; corrupt: CorruptStateError } {
  try {
    return { value: read() };
  } catch (err) {
    if (err instanceof CorruptStateError) return { corrupt: err };
    throw err;
  }
}

/** Writes JSON via a temp file and rename, so readers never see a partial file. */
export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

export function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Whether a process with this pid exists on this host. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

interface LockOwner {
  readonly pid: number;
  readonly host: string;
  readonly at: number;
}

const STALE_AFTER_MS = 60_000;

function lockIsStale(path: string): boolean {
  try {
    const owner = readJson(path) as LockOwner;
    if (owner.host === hostname() && !pidAlive(owner.pid)) return true;
    return Date.now() - owner.at > STALE_AFTER_MS;
  } catch {
    // Unreadable (half-written) lock: stale once it is old enough.
    try {
      return Date.now() - statSync(path).mtimeMs > STALE_AFTER_MS;
    } catch {
      return true;
    }
  }
}

/**
 * Runs `fn` while holding an exclusive lock file (`O_EXCL` create). Waits with backoff;
 * breaks locks whose owner died or that are older than a minute. Locks are only held for a
 * read-modify-write, never across long work.
 */
export async function withFileLock<T>(
  path: string,
  fn: () => T | Promise<T>,
  timeoutMs = 10_000,
): Promise<T> {
  mkdirSync(dirname(path), { recursive: true });
  const started = Date.now();
  for (let delay = 5; ; delay = Math.min(delay * 2, 200)) {
    try {
      const fd = openSync(path, "wx");
      writeFileSync(
        fd,
        JSON.stringify({ pid: process.pid, host: hostname(), at: Date.now() } satisfies LockOwner),
      );
      closeSync(fd);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (lockIsStale(path)) {
        rmSync(path, { force: true });
        continue;
      }
      if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for lock ${path}`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(path, { force: true });
  }
}
