import { existsSync, readdirSync } from "node:fs";
import { z } from "zod";
import { FACTORY_VERSION } from "../version.ts";
import {
  CorruptStateError,
  factoryDir,
  readState,
  withFileLock,
  writeJsonAtomic,
} from "./files.ts";

/**
 * Run state: `.factory/runs/<id>.json`. Only the CLI writes it (§8); every write is atomic and
 * read-modify-writes hold a lock, so `status`, `abort` and `resume` work during a run and a
 * crash leaves a resumable file.
 */

export const PHASES = [
  "intake",
  "design",
  "awaiting-approval",
  "queued",
  "implementing",
  "reviewing",
  "contracts",
  "full-suite",
  "closing",
  "done",
  "paused",
  "aborted",
] as const;
export type Phase = (typeof PHASES)[number];

export const TASK_STATUSES = [
  "pending",
  "running",
  "merging",
  "merged",
  "failed",
  "cancelled",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

const HistoryEntry = z.strictObject({
  at: z.string(),
  event: z.string(),
  detail: z.string().optional(),
});

export const TaskState = z.strictObject({
  id: z.string(),
  title: z.string(),
  repo: z.string(),
  deps: z.array(z.string()),
  touches: z.array(z.string()),
  /** "task" from tasks.md; "test", "review-fix" and "suite-fix" are follow-ups the CLI adds. */
  kind: z.enum(["task", "test", "review-fix", "suite-fix", "contract-fix"]).default("task"),
  status: z.enum(TASK_STATUSES),
  /** Gate failures plus merge-conflict resolution attempts (§8). Rate-limit waits never count. */
  failures: z.int().min(0).default(0),
  /** Requeued to run alone in its repo after an unresolved merge conflict. */
  serial: z.boolean().default(false),
  worktree: z.string().optional(),
  branch: z.string().optional(),
  commit: z.string().optional(),
  /** Merge sequence number of this task's merge (graph coverage, ADR-0007). */
  mergeSeq: z.int().min(0).optional(),
  /** Compacted output of the last failed gate run; fed back on the next attempt. */
  lastGateOutput: z.string().optional(),
  lastError: z.string().optional(),
  /** The current work passed its gates: a resumed task goes straight to the merge (audit P8). */
  gatesPassed: z.boolean().default(false),
  /** Dependencies are installed in the task's worktree; a failed install is retried (P12). */
  installed: z.boolean().default(false),
  history: z.array(HistoryEntry).default([]),
});
export type TaskState = z.infer<typeof TaskState>;

/** One question an agent raised, and what the user did with it. */
export const Clarification = z.strictObject({
  /** "intake" or "design". */
  step: z.string(),
  question: z.string(),
  status: z.enum(["answered", "skipped", "unanswered"]),
  answer: z.string().optional(),
  at: z.string(),
});
export type Clarification = z.infer<typeof Clarification>;

export const RunState = z.strictObject({
  version: z.literal(1),
  id: z.string(),
  /** Factory version the run started with; `update --force` keeps it on its snapshot. */
  factoryVersion: z.string(),
  /** `openspec` for a change adopted from an existing OpenSpec folder (ADR-0038). */
  origin: z.enum(["factory", "openspec"]).default("factory"),
  /** Adoption timestamp; only set for adopted changes. */
  adoptedAt: z.string().optional(),
  /**
   * An adopted change whose OpenSpec tasks are already checked: approval keeps those tasks
   * as merged instead of restarting them (ADR-0038).
   */
  preserveProgress: z.boolean().default(false),
  request: z.string().default(""),
  createdAt: z.string(),
  updatedAt: z.string(),
  phase: z.enum(PHASES),
  pausedReason: z.string().optional(),
  abortRequested: z.boolean().default(false),
  branches: z
    .record(z.string(), z.strictObject({ branch: z.string(), base: z.string() }))
    .default({}),
  tasks: z.array(TaskState).default([]),
  /** Incremented on every task merge; graph updates record the sequence they cover. */
  mergeSeq: z.int().min(0).default(0),
  /** Highest merge sequence a finished graph update covers. */
  graphSeq: z.int().min(0).default(0),
  /** `withinRepo: "serial"`: the task whose work is in each repo checkout (audit P10). */
  serialOwner: z.record(z.string(), z.string()).default({}),
  /** Intake result. */
  summary: z.string().default(""),
  likelyRepos: z.array(z.string()).default([]),
  /** Workspace-relative dir of an AI-repo draft worktree while another change is active. */
  draft: z.string().optional(),
  /** Repos whose review and tester pass already ran (each runs once per change). */
  reviewed: z.array(z.string()).default([]),
  /** Full-suite fix rounds used. */
  suiteRounds: z.int().min(0).default(0),
  /** Latest handoff per task or step, for the report. */
  handoffs: z.record(z.string(), z.unknown()).default({}),
  /** Questions the intake orchestrator and architect raised, and the user's answers. */
  clarifications: z.array(Clarification).default([]),
  /** Gate summary of the last full-suite run per repo. */
  fullSuite: z
    .record(z.string(), z.strictObject({ passed: z.boolean(), output: z.string() }))
    .default({}),
  /** Contract fix rounds used, whether the cross-repo review ran, last gate results. */
  contractRounds: z.int().min(0).default(0),
  contractReviewed: z.boolean().default(false),
  contractResults: z
    .record(z.string(), z.strictObject({ passed: z.boolean(), summary: z.string() }))
    .default({}),
  /** Provisional pointer bump commit (submodules layout). */
  pointerCommit: z.string().optional(),
  /** Close steps already done, so a resumed close skips them (audit P6). */
  pointersBumped: z.boolean().default(false),
  pointers: z.array(z.string()).default([]),
  archivedAs: z.string().optional(),
  archiveCommit: z.string().optional(),
  reportPath: z.string().optional(),
});
export type RunState = z.infer<typeof RunState>;

export const runFile = (root: string, id: string): string => factoryDir(root, "runs", `${id}.json`);
const lockFile = (root: string, id: string): string => factoryDir(root, "runs", `${id}.json.lock`);

export const now = (): string => new Date().toISOString();

export function newRun(id: string, request: string, phase: Phase = "intake"): RunState {
  const at = now();
  return RunState.parse({
    version: 1,
    id,
    factoryVersion: FACTORY_VERSION,
    request,
    createdAt: at,
    updatedAt: at,
    phase,
  });
}

export function loadRun(root: string, id: string): RunState | undefined {
  return readState(
    root,
    runFile(root, id),
    RunState,
    "fix it, or delete it to forget the change (its branches and worktrees stay)",
  );
}

export function saveRun(root: string, state: RunState): RunState {
  const next = { ...state, updatedAt: now() };
  writeJsonAtomic(runFile(root, state.id), next);
  return next;
}

/** Read-modify-write under the run's lock. `mutate` may change the draft in place. */
export function updateRun(
  root: string,
  id: string,
  mutate: (draft: RunState) => void,
): Promise<RunState> {
  return withFileLock(lockFile(root, id), () => {
    const current = loadRun(root, id);
    if (current === undefined) throw new Error(`no run state for ${id}`);
    const draft = structuredClone(current);
    mutate(draft);
    return saveRun(root, RunState.parse(draft));
  });
}

export interface RunScan {
  readonly runs: RunState[];
  /** Run files that do not parse: listed, never fatal for the others (audit P15). */
  readonly corrupt: { readonly id: string; readonly error: CorruptStateError }[];
}

export function scanRuns(root: string): RunScan {
  const dir = factoryDir(root, "runs");
  const scan: { runs: RunState[]; corrupt: RunScan["corrupt"][number][] } = {
    runs: [],
    corrupt: [],
  };
  if (!existsSync(dir)) return scan;
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".json"))) {
    const id = f.slice(0, -".json".length);
    try {
      const run = loadRun(root, id);
      if (run !== undefined) scan.runs.push(run);
    } catch (err) {
      if (!(err instanceof CorruptStateError)) throw err;
      scan.corrupt.push({ id, error: err });
    }
  }
  return scan;
}

export function listRuns(root: string): RunState[] {
  return scanRuns(root).runs;
}

const MAX_HISTORY = 50;

/** Appends to a task's history, keeping the most recent entries. */
export function recordTask(task: TaskState, event: string, detail?: string): void {
  task.history.push({ at: now(), event, ...(detail === undefined ? {} : { detail }) });
  if (task.history.length > MAX_HISTORY) task.history.splice(0, task.history.length - MAX_HISTORY);
}
