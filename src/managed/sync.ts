import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { execOk } from "../exec.ts";
import type { LockEntry } from "../lock/lock.ts";
import { BLOCK_MARKERS, type BlockMarkers, type ManagedFile } from "../render/workspace.ts";
import { FACTORY_VERSION } from "../version.ts";

/**
 * Writes managed files without ever overwriting a user's edit silently (§10):
 * - unchanged since the last render → overwritten with the new render;
 * - edited by the user → kept (`update` merges it later);
 * - deleted by the user → not recreated unless `restore`;
 * - existing but never rendered by the factory → conflict unless `force`.
 */

export type SyncAction =
  | "create"
  | "update"
  | "unchanged"
  | "keep-user-edit"
  | "keep-deleted"
  | "skip-unmanaged"
  | "conflict"
  | "overwrite"
  | "remove"
  | "keep-removed-edit";

export interface PlannedChange {
  readonly path: string;
  readonly action: SyncAction;
  /** For create/update/overwrite/unchanged: what to render. */
  readonly file?: ManagedFile;
}

export interface SyncOptions {
  /** Paths the user owns completely (`unmanaged` in the config). */
  readonly unmanaged: readonly string[];
  /** Recreate files the user deleted. */
  readonly restore?: boolean;
  /** Overwrite pre-existing files the factory never rendered. */
  readonly force?: boolean;
  /** Paths created moments ago by a tool the factory ran (e.g. `openspec init`): take them over. */
  readonly adopt?: readonly string[];
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function markersFor(path: string): BlockMarkers {
  const markers = BLOCK_MARKERS[path.slice(path.lastIndexOf("/") + 1)];
  if (markers === undefined) throw new Error(`no block markers for ${path}`);
  return markers;
}

/** Character range of the managed block (marker lines included), if present. */
function findBlock(
  text: string,
  markers: BlockMarkers,
): { start: number; end: number } | undefined {
  const start = text.indexOf(markers.start);
  if (start === -1) return undefined;
  const endMarker = text.indexOf(markers.end, start);
  if (endMarker === -1) return undefined;
  return { start, end: endMarker + markers.end.length };
}

function readOptional(abs: string): string | undefined {
  return existsSync(abs) ? readFileSync(abs, "utf8") : undefined;
}

/** The text the factory owns in a file as it is now, or undefined when absent. */
function currentOwned(root: string, path: string, mode: "file" | "block"): string | undefined {
  const text = readOptional(join(root, path));
  if (text === undefined || mode === "file") return text;
  const block = findBlock(text, markersFor(path));
  return block ? text.slice(block.start, block.end) : undefined;
}

export function planSync(
  root: string,
  files: readonly ManagedFile[],
  previous: Readonly<Record<string, LockEntry>>,
  options: SyncOptions,
): PlannedChange[] {
  const unmanaged = new Set(options.unmanaged);
  const plan: PlannedChange[] = [];

  for (const file of files) {
    if (unmanaged.has(file.path)) {
      plan.push({ path: file.path, action: "skip-unmanaged" });
      continue;
    }
    const prev = previous[file.path];
    const current = currentOwned(root, file.path, file.mode);
    let action: SyncAction;
    if (current === undefined) {
      action = prev !== undefined && !options.restore ? "keep-deleted" : "create";
    } else if (current === file.content) {
      action = "unchanged";
    } else if (prev !== undefined) {
      action = sha256(current) === prev.sha256 ? "update" : "keep-user-edit";
    } else if (options.adopt?.includes(file.path)) {
      action = "create";
    } else {
      action = options.force ? "overwrite" : "conflict";
    }
    plan.push({ path: file.path, action, file });
  }

  const rendered = new Set(files.map((f) => f.path));
  for (const [path, prev] of Object.entries(previous)) {
    if (rendered.has(path) || unmanaged.has(path)) continue;
    const current = currentOwned(root, path, prev.mode);
    if (current === undefined) continue; // already gone; the entry is dropped
    plan.push({ path, action: sha256(current) === prev.sha256 ? "remove" : "keep-removed-edit" });
  }
  return plan.sort((a, b) => a.path.localeCompare(b.path));
}

function writeAtomic(abs: string, text: string): void {
  mkdirSync(dirname(abs), { recursive: true });
  const tmp = `${abs}.ai-factory-tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, abs);
}

/** Inserts or replaces the managed block, leaving the rest of the file alone. */
function writeBlock(abs: string, path: string, block: string): void {
  const text = readOptional(abs) ?? "";
  const range = findBlock(text, markersFor(path));
  let next: string;
  if (range) {
    next = text.slice(0, range.start) + block + text.slice(range.end);
  } else if (text === "") {
    next = `${block}\n`;
  } else {
    next = `${text.replace(/\n*$/, "\n")}\n${block}\n`;
  }
  writeAtomic(abs, next);
}

function removeOwned(root: string, path: string, mode: "file" | "block"): void {
  const abs = join(root, path);
  if (mode === "file") {
    rmSync(abs, { force: true });
    return;
  }
  const text = readFileSync(abs, "utf8");
  const range = findBlock(text, markersFor(path));
  if (range === undefined) return;
  const rest = (text.slice(0, range.start) + text.slice(range.end)).replace(/\n{3,}/g, "\n\n");
  writeAtomic(abs, rest.trim() === "" ? "" : rest);
}

async function writeBlob(root: string, content: string): Promise<string> {
  return execOk(["git", "hash-object", "-w", "--stdin"], { cwd: root, input: content });
}

/** Applies a plan; returns the new lock entries for every managed path. */
export async function executeSync(
  root: string,
  plan: readonly PlannedChange[],
  previous: Readonly<Record<string, LockEntry>>,
): Promise<Record<string, LockEntry>> {
  const managed: Record<string, LockEntry> = {};
  for (const change of plan) {
    const prev = previous[change.path];
    const file = change.file;
    switch (change.action) {
      case "create":
      case "update":
      case "overwrite":
      case "unchanged": {
        if (file === undefined) throw new Error(`no render for ${change.path}`);
        if (change.action !== "unchanged") {
          const abs = join(root, file.path);
          if (file.mode === "block") writeBlock(abs, file.path, file.content);
          else writeAtomic(abs, file.content);
        }
        managed[file.path] = {
          template: file.template,
          templateVersion: FACTORY_VERSION,
          mode: file.mode,
          sha256: sha256(file.content),
          blob: await writeBlob(root, file.content),
        };
        break;
      }
      case "keep-user-edit":
      case "keep-deleted":
        // Keep the old entry: it is the merge base for `update`.
        if (prev !== undefined) managed[change.path] = prev;
        break;
      case "remove":
        if (prev !== undefined) removeOwned(root, change.path, prev.mode);
        break;
      case "skip-unmanaged":
      case "keep-removed-edit":
      case "conflict":
        break;
    }
  }
  return managed;
}
