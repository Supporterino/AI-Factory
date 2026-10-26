import { rmSync } from "node:fs";
import { hostname } from "node:os";
import { z } from "zod";
import { factoryDir, pidAlive, readState, withFileLock, writeJsonAtomic } from "./files.ts";
import { now } from "./run.ts";

/**
 * One active change per workspace (§11). `.factory/active.lock` names the change that owns
 * the workspace from the start of implementation until close or abort, paused or not. Its
 * `pid` is the process currently driving it (null when nobody is); a dead pid is a stale
 * driver that `resume` may replace.
 */

const ActiveLock = z.strictObject({
  changeId: z.string(),
  pid: z.int().nullable(),
  host: z.string(),
  since: z.string(),
});
export type ActiveLock = z.infer<typeof ActiveLock>;

const activeFile = (root: string): string => factoryDir(root, "active.lock");
const guard = (root: string): string => factoryDir(root, "active.lock.guard");

export function readActive(root: string): ActiveLock | undefined {
  return readState(
    root,
    activeFile(root),
    ActiveLock,
    "if no ai-factory process is running: rm .factory/active.lock, then `ai-factory resume <change-id>`",
  );
}

/** A driver is live when its process exists (only checkable on the same host). */
export function driverAlive(lock: ActiveLock): boolean {
  if (lock.pid === null) return false;
  return lock.host !== hostname() || pidAlive(lock.pid);
}

export type ClaimResult =
  | { status: "acquired"; tookOver: boolean }
  | { status: "busy"; holder: ActiveLock }
  | { status: "running"; holder: ActiveLock };

/**
 * Makes `id` the active change driven by this process. Busy if another change is active;
 * "running" if another live process already drives this change.
 */
export function claimActive(root: string, id: string, pid = process.pid): Promise<ClaimResult> {
  return withFileLock(guard(root), (): ClaimResult => {
    const current = readActive(root);
    if (current !== undefined && current.changeId !== id)
      return { status: "busy", holder: current };
    if (current !== undefined && current.pid !== pid && driverAlive(current)) {
      return { status: "running", holder: current };
    }
    writeJsonAtomic(activeFile(root), {
      changeId: id,
      pid,
      host: hostname(),
      since: current?.since ?? now(),
    } satisfies ActiveLock);
    return {
      status: "acquired",
      tookOver: current !== undefined && current.pid !== null && current.pid !== pid,
    };
  });
}

/** The process stops driving the change; the change stays active (paused, waiting). */
export function releaseDriver(root: string, id: string): Promise<void> {
  return withFileLock(guard(root), () => {
    const current = readActive(root);
    if (current?.changeId === id) writeJsonAtomic(activeFile(root), { ...current, pid: null });
  });
}

/** The change no longer owns the workspace (closed or aborted). */
export function releaseActive(root: string, id: string): Promise<void> {
  return withFileLock(guard(root), () => {
    if (readActive(root)?.changeId === id) rmSync(activeFile(root), { force: true });
  });
}

const Queue = z.strictObject({
  entries: z.array(z.strictObject({ changeId: z.string(), approvedAt: z.string() })),
});
export type Queue = z.infer<typeof Queue>;

const queueFile = (root: string): string => factoryDir(root, "queue.json");

export function readQueue(root: string): Queue {
  return (
    readState(
      root,
      queueFile(root),
      Queue,
      "rm .factory/queue.json, then `ai-factory resume` each approved change that was waiting",
    ) ?? { entries: [] }
  );
}

/** Approved changes waiting for the active one to close, in approval order. */
export function enqueue(root: string, id: string): Promise<Queue> {
  return withFileLock(guard(root), () => {
    const queue = readQueue(root);
    if (!queue.entries.some((e) => e.changeId === id))
      queue.entries.push({ changeId: id, approvedAt: now() });
    writeJsonAtomic(queueFile(root), queue);
    return queue;
  });
}

export function removeFromQueue(root: string, id: string): Promise<void> {
  return withFileLock(guard(root), () => {
    const queue = readQueue(root);
    writeJsonAtomic(queueFile(root), { entries: queue.entries.filter((e) => e.changeId !== id) });
  });
}

/** The next queued change, removed from the queue. */
export function dequeue(root: string): Promise<string | undefined> {
  return withFileLock(guard(root), () => {
    const queue = readQueue(root);
    const [next, ...rest] = queue.entries;
    writeJsonAtomic(queueFile(root), { entries: rest });
    return next?.changeId;
  });
}
