import type { GateEvent, GateInfo, GateReport } from "../gates/run.ts";
import { redactProcess } from "../logs/redact.ts";
import type { SessionActivity, Usage } from "../runtime/types.ts";
import type { TaskEvent } from "../scheduler/scheduler.ts";
import { formatTokens, totalTokens } from "../usage/usage.ts";
import { formatDuration } from "../util/duration.ts";

/**
 * Progress lines for a running pipeline: one line when a step or session starts and ends,
 * gate-level lines only when they matter, a heartbeat while agents work, and failures. It
 * reads like a build log: appended only, no cursor movement, so a redirect keeps every line.
 *
 * `verbose` adds one line per tool call and per gate; `quiet` keeps banners, merges,
 * failures and the final summary.
 */

export type Verbosity = "quiet" | "normal" | "verbose";

export interface ProgressOptions {
  readonly out: (line: string) => void;
  readonly verbosity?: Verbosity;
  /** Change id, for "merging into change/<id>". */
  readonly changeId?: string;
  /** Retry budget shown as "attempt 1/4"; from `gates.maxRetries`. */
  readonly maxAttempts?: number;
  /** 0 disables the heartbeat (tests call `tick` themselves). */
  readonly heartbeatMs?: number;
  readonly now?: () => number;
}

export interface AgentStart {
  readonly step: string;
  readonly agent: string;
  readonly model: string;
  /** Human label (the task title); capped in the line. */
  readonly label?: string;
  /** 1 for the first attempt; omitted for one-shot steps. */
  readonly attempt?: number;
}

export interface AgentEnd {
  readonly step: string;
  readonly outcome: "succeeded" | "failed" | "interrupted";
  readonly durationMs: number;
  readonly usage: Usage;
  readonly problem?: string;
}

export interface TaskCounts {
  readonly merged: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly pending: number;
  readonly total: number;
}

const DEFAULT_HEARTBEAT_MS = 30_000;
/** Gates shorter than this are only interesting when verbose or failing. */
const SLOW_GATE_MS = 10_000;
const DETAIL_MAX = 100;
const TITLE_MAX = 60;
const HEARTBEAT_MAX = 220;

const ICON = {
  start: "▶",
  gate: "⚙",
  ok: "✓",
  fail: "✗",
  retry: "↻",
  merge: "⇢",
  warn: "!",
  stop: "⊘",
  tool: "·",
  wait: "…",
} as const;

interface ActiveSession {
  readonly step: string;
  readonly startedAt: number;
  last: string | undefined;
  tokens: number;
}

/** A gate or dependency install: no tool activity, but it can run for minutes. */
interface ActiveStage {
  readonly step: string;
  readonly label: string;
  readonly startedAt: number;
}

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

const cap = (text: string, max: number): string => {
  const clean = oneLine(text);
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
};

/** Fields worth showing from a tool input; file contents are never printed. */
const DETAIL_KEYS = [
  "command",
  "filePath",
  "path",
  "file",
  "pattern",
  "query",
  "url",
  "description",
] as const;

/** `bash: bun test`, `edit: src/greet.ts`; redacted because commands can carry credentials. */
export function describeTool(tool: string, input: unknown): string {
  if (typeof input !== "object" || input === null) return tool;
  const record = input as Record<string, unknown>;
  for (const key of DETAIL_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "")
      return cap(`${tool}: ${redactProcess(value)}`, DETAIL_MAX);
  }
  return tool;
}

/** `pass` → `✓`, a missing/timeout/not-check-only gate → `✗`, skipped → `–`. */
const GATE_ICON: Record<string, string> = {
  pass: ICON.ok,
  skipped: "–",
  fail: ICON.fail,
  missing: ICON.fail,
  timeout: ICON.fail,
  "not-check-only": ICON.fail,
};

export class Progress {
  readonly #out: (line: string) => void;
  readonly #verbosity: Verbosity;
  readonly #maxAttempts: number;
  readonly #heartbeatMs: number;
  readonly #now: () => number;
  readonly #active = new Map<string, ActiveSession>();
  readonly #gates = new Map<string, ActiveStage>();
  readonly #installs = new Map<string, ActiveStage>();
  #changeId: string | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: ProgressOptions) {
    this.#out = options.out;
    this.#verbosity = options.verbosity ?? "normal";
    this.#changeId = options.changeId;
    this.#maxAttempts = Math.max(1, options.maxAttempts ?? 4);
    this.#heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.#now = options.now ?? Date.now;
  }

  get verbosity(): Verbosity {
    return this.#verbosity;
  }

  /** The change whose merge lines this progress reports (queue continuation changes it). */
  setChangeId(id: string): void {
    this.#changeId = id;
  }

  get #normal(): boolean {
    return this.#verbosity !== "quiet";
  }

  now(): number {
    return this.#now();
  }

  line(text: string): void {
    this.#out(text);
  }

  /** A sub-step line: shown in `normal` and `verbose`, hidden in `quiet`. */
  note(text: string): void {
    if (this.#normal) this.line(text);
  }

  agentStarted(input: AgentStart): void {
    if (!this.#normal) return;
    const parts: string[] = [];
    if (input.label !== undefined && input.label.trim() !== "")
      parts.push(cap(input.label, TITLE_MAX));
    parts.push(`${input.agent} (${input.model})`);
    if (input.attempt !== undefined) parts.push(`attempt ${input.attempt}/${this.#maxAttempts}`);
    this.line(`  ${ICON.start} [${input.step}] ${parts.join(" · ")}`);
    this.#active.set(input.step, {
      step: input.step,
      startedAt: this.#now(),
      last: undefined,
      tokens: 0,
    });
    this.#startHeartbeat();
  }

  agentFinished(end: AgentEnd): void {
    this.#active.delete(end.step);
    this.#stopHeartbeatIfIdle();
    if (!this.#normal) return;
    const icon =
      end.outcome === "succeeded" ? ICON.ok : end.outcome === "interrupted" ? ICON.stop : ICON.fail;
    const word =
      end.outcome === "succeeded"
        ? "session done"
        : end.outcome === "interrupted"
          ? "session interrupted"
          : "session failed";
    const tokens = totalTokens(end.usage);
    const tail = [
      `${word} in ${formatDuration(end.durationMs)}`,
      ...(tokens > 0 ? [`${formatTokens(tokens)} tok`] : []),
    ];
    if (end.problem !== undefined && end.problem.trim() !== "")
      tail[0] = `${tail[0]}: ${cap(end.problem, DETAIL_MAX)}`;
    this.line(`  ${icon} [${end.step}] ${tail.join(" · ")}`);
  }

  /** Live activity inside a session: heartbeat material, and lines when they matter. */
  activity(step: string, activity: SessionActivity): void {
    if (!this.#normal) return;
    const session = this.#active.get(step);
    switch (activity.kind) {
      case "step-done":
        if (session) session.tokens += totalTokens(activity.usage);
        return;
      case "step-started":
        return;
      case "retry":
        this.line(
          `  ${ICON.warn} [${step}] rate limited; retrying${activity.reason === undefined ? "" : `: ${cap(activity.reason, DETAIL_MAX)}`}`,
        );
        return;
      default:
        break;
    }
    const detail =
      activity.kind === "tool" ? describeTool(activity.tool, activity.input) : activity.tool;
    if (session) session.last = detail;
    if (activity.kind === "tool") {
      if (this.#verbosity === "verbose") this.line(`  ${ICON.tool} [${step}] ${detail}`);
      return;
    }
    // A failed tool call is worth a line even in normal mode: the agent may still recover,
    // but the user should see why a turn stalls or gets long.
    if (activity.status === "failed")
      this.line(
        `  ${ICON.fail} [${step}] ${detail} failed${activity.error === undefined ? "" : `: ${cap(activity.error, DETAIL_MAX)}`}`,
      );
  }

  gate(step: string, event: GateEvent, stage = "gates"): void {
    if (!this.#normal) return;
    const label = (gate: GateInfo): string => gate.name ?? gate.type;
    if (event.phase === "plan") {
      const names = [...new Set(event.gates.map((g) => g.name ?? g.type))];
      if (names.length > 0) this.line(`  ${ICON.gate} [${step}] ${stage}: ${names.join(", ")}`);
      return;
    }
    if (event.phase === "start") {
      const gate = label(event.gate);
      this.#gates.set(`${step}\0${gate}`, { step, label: gate, startedAt: this.#now() });
      this.#startHeartbeat();
      if (this.#verbosity === "verbose")
        this.line(
          `  ${ICON.gate} [${step}] ${gate} started${event.gate.command ? ` (${cap(event.gate.command, 70)})` : ""}`,
        );
      return;
    }
    this.#gates.delete(`${step}\0${label(event.gate)}`);
    this.#stopHeartbeatIfIdle();
    const failed = event.status !== "pass" && event.status !== "skipped";
    if (!failed && this.#verbosity !== "verbose" && event.durationMs < SLOW_GATE_MS) return;
    const icon = GATE_ICON[event.status] ?? ICON.fail;
    const note = event.status === "skipped" ? " skipped" : failed ? ` ${event.status}` : "";
    this.line(
      `  ${icon} [${step}] ${label(event.gate)}${note} ${formatDuration(event.durationMs)}`,
    );
  }

  gatesDone(step: string, report: GateReport, durationMs: number, stage = "gates"): void {
    if (!this.#normal) return;
    const failing = report.results
      .filter((r) => r.status !== "pass" && r.status !== "skipped")
      .map((r) => r.name ?? r.type);
    if (report.passed) {
      this.line(`  ${ICON.ok} [${step}] ${stage} passed in ${formatDuration(durationMs)}`);
      return;
    }
    const why = failing.length === 0 ? "no gate ran" : failing.join(", ");
    this.line(`  ${ICON.fail} [${step}] ${stage} failed (${why}) in ${formatDuration(durationMs)}`);
  }

  install(
    step: string,
    repo: string,
    phase: "start" | "done" | "failed",
    durationMs = 0,
    detail?: string,
  ): void {
    if (!this.#normal) return;
    const key = `${step}\0${repo}`;
    if (phase === "start") {
      this.#installs.set(key, { step, label: `install ${repo}`, startedAt: this.#now() });
      this.#startHeartbeat();
      this.line(`  ${ICON.gate} [${step}] installing dependencies in ${repo}`);
      return;
    }
    this.#installs.delete(key);
    this.#stopHeartbeatIfIdle();
    if (phase === "failed") {
      this.line(
        `  ${ICON.fail} [${step}] dependency install failed in ${repo}${detail === undefined ? "" : `: ${cap(detail, DETAIL_MAX)}`}`,
      );
      return;
    }
    if (this.#verbosity === "verbose" || durationMs >= SLOW_GATE_MS)
      this.line(`  ${ICON.ok} [${step}] dependencies ready in ${formatDuration(durationMs)}`);
  }

  task(event: TaskEvent): void {
    switch (event.type) {
      case "started":
        // `agentStarted` prints the task with its label; the event only marks the transition.
        return;
      case "retry":
        if (!this.#normal) return;
        this.line(
          `  ${ICON.retry} [${event.task.id}] ${event.reason}; retrying (attempt ${event.attempt}/${this.#maxAttempts})`,
        );
        return;
      case "failed":
        this.line(`  ${ICON.fail} [${event.task.id}] failed: ${cap(event.reason, DETAIL_MAX)}`);
        return;
      case "merging":
        if (!this.#normal) return;
        this.line(
          `  ${ICON.merge} [${event.task.id}] merging${this.#changeId === undefined ? "" : ` into change/${this.#changeId}`}`,
        );
        return;
      case "merged":
        this.line(`  ${ICON.ok} ${event.task.id} merged (${event.task.repo})`);
        return;
      case "conflict":
        this.line(
          `  ${ICON.warn} [${event.task.id}] merge conflict in ${event.files.length} file${event.files.length === 1 ? "" : "s"}: ${event.files.join(", ")} · one resolution attempt`,
        );
        return;
      case "requeued":
        this.line(
          `  ${ICON.warn} [${event.task.id}] requeued to run alone in ${event.task.repo}: ${event.reason}`,
        );
        return;
      case "transient":
        this.line(
          `  ${ICON.warn} [${event.task.id}] infrastructure error: ${cap(event.reason, DETAIL_MAX)}; retrying without spending the budget`,
        );
        return;
      case "interrupted":
        this.line(`  ${ICON.stop} [${event.task.id}] interrupted; the work is kept`);
        return;
      case "waiting":
        if (!this.#normal) return;
        this.line(
          `  ${ICON.wait} waiting: ${event.tasks.map((t) => `${t.id} (${t.reason})`).join(", ")}`,
        );
        return;
    }
  }

  implementSummary(counts: TaskCounts, elapsedMs: number): void {
    if (counts.total === 0) return;
    const parts = [`${counts.merged}/${counts.total} merged`];
    if (counts.failed > 0) parts.push(`${counts.failed} failed`);
    if (counts.cancelled > 0) parts.push(`${counts.cancelled} cancelled`);
    if (counts.pending > 0) parts.push(`${counts.pending} pending`);
    this.line(`implement: ${parts.join(", ")} in ${formatDuration(elapsedMs)}`);
  }

  /** One heartbeat line for every session, gate and install that is still running. */
  tick(): void {
    if (!this.#normal) return;
    const now = this.#now();
    const sessions = [...this.#active.values()].map((session) => {
      const bits = [`${session.step} ${formatDuration(now - session.startedAt)}`];
      if (session.last !== undefined) bits.push(session.last);
      if (session.tokens > 0) bits.push(`${formatTokens(session.tokens)} tok`);
      return bits.join(" · ");
    });
    const stages = [...this.#gates.values(), ...this.#installs.values()].map(
      (stage) => `[${stage.step}] ${stage.label} ${formatDuration(now - stage.startedAt)}`,
    );
    const entries = [...sessions, ...stages];
    if (entries.length === 0) return;
    const total = entries.length;
    let text = `  ${ICON.wait} running ${total}: ${entries.join(" · ")}`;
    // With many agents the line grows; drop items rather than wrapping the terminal.
    while (text.length > HEARTBEAT_MAX && entries.length > 1) {
      entries.pop();
      text = `  ${ICON.wait} running ${total}: ${entries.join(" · ")} · +${total - entries.length} more`;
    }
    this.line(text);
  }

  #startHeartbeat(): void {
    if (this.#heartbeatMs <= 0 || this.#timer !== undefined) return;
    this.#timer = setInterval(() => this.tick(), this.#heartbeatMs);
    // A heartbeat must never keep the process (or a test runner) alive.
    this.#timer.unref?.();
  }

  #stopHeartbeat(): void {
    if (this.#timer === undefined) return;
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  #stopHeartbeatIfIdle(): void {
    if (this.#active.size + this.#gates.size + this.#installs.size === 0) this.#stopHeartbeat();
  }

  /** Stops the timer and forgets running sessions (the CLI's `finally`). */
  stop(): void {
    this.#stopHeartbeat();
    this.#active.clear();
    this.#gates.clear();
    this.#installs.clear();
  }
}
