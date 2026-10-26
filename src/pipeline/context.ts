import { join } from "node:path";
import { type FactoryConfig, modelFor, type RepoConfig, type Role } from "../config/schema.ts";
import type { Handoff } from "../handoff/schema.ts";
import { appendLog } from "../logs/log.ts";
import type { AgentRole } from "../policy/permissions.ts";
import { promptForHandoff } from "../runtime/handoff.ts";
import { limited, RateLimiter } from "../runtime/rate-limit.ts";
import {
  type AgentRuntime,
  type AgentSession,
  addUsage,
  type SessionSpec,
  type Usage,
} from "../runtime/types.ts";
import { loadRun, type RunState, updateRun } from "../state/run.ts";
import { recordUsage, type UsageEntry } from "../usage/usage.ts";
import { Semaphore } from "../util/semaphore.ts";

/** Everything a pipeline step needs; one per CLI command invocation. */
export interface PipelineDeps {
  readonly runtime: AgentRuntime;
  /** Progress lines for the user. */
  readonly out: (line: string) => void;
  readonly signal: AbortSignal;
}

export interface AgentCall {
  readonly changeId: string;
  readonly agent: string;
  readonly role: AgentRole;
  readonly modelRole: Role;
  readonly context: Omit<SessionSpec["context"], "changeId" | "role">;
  readonly title: string;
  readonly prompt: string;
  /** Usage bookkeeping: task id or step name, and the attempt kind (§11). */
  readonly step: string;
  readonly kind?: UsageEntry["kind"];
  readonly attempt?: number;
  /** Follow-up prompts in the same session when `retry` returns text (design repair). */
  readonly retry?: (handoff: Handoff | undefined, attempt: number) => Promise<string | undefined>;
}

export interface AgentResult {
  readonly handoff?: Handoff;
  readonly problem?: string;
  readonly outcome: "succeeded" | "failed" | "interrupted";
  readonly usage: Usage;
  readonly sessionId: string;
  readonly model: string;
}

/** `ai-factory abort` was requested for the change: stop at the next safe point. */
export class ChangeAborted extends Error {
  constructor(readonly changeId: string) {
    super(`${changeId} was aborted`);
  }
}

export class Pipeline {
  readonly limiter = new RateLimiter();
  readonly agents: Semaphore;
  readonly gates: Semaphore;

  constructor(
    readonly root: string,
    readonly config: FactoryConfig,
    readonly deps: PipelineDeps,
  ) {
    this.agents = new Semaphore(config.parallel.maxAgents);
    this.gates = new Semaphore(config.parallel.maxGateProcesses);
  }

  codeRepos(): RepoConfig[] {
    return this.config.repos.filter((r) => r.role === "code");
  }

  repo(name: string): RepoConfig {
    const repo = this.config.repos.find((r) => r.name === name);
    if (repo === undefined) throw new Error(`unknown repo ${name}`);
    return repo;
  }

  repoDir(repo: RepoConfig): string {
    return join(this.root, repo.path);
  }

  out(line: string): void {
    this.deps.out(line);
  }

  run(id: string): RunState {
    const run = loadRun(this.root, id);
    if (run === undefined) throw new Error(`no run state for ${id}`);
    return run;
  }

  update(id: string, mutate: (draft: RunState) => void): Promise<RunState> {
    return updateRun(this.root, id, mutate);
  }

  /** Whether `ai-factory abort` asked this change to stop. */
  abortRequested(id: string): boolean {
    return id !== "intake" && loadRun(this.root, id)?.abortRequested === true;
  }

  /**
   * A signal that fires on SIGINT/SIGTERM or when `abort` marks the change (polled), so a
   * running session is interrupted either way.
   */
  #callSignal(id: string): { signal: AbortSignal; stop: () => void } {
    const controller = new AbortController();
    const timer = setInterval(() => {
      if (this.abortRequested(id)) controller.abort();
    }, 1000);
    return {
      signal: AbortSignal.any([this.deps.signal, controller.signal]),
      stop: () => clearInterval(timer),
    };
  }

  /** One agent session: open, prompt for a handoff (one repair), optional follow-ups. */
  async call(call: AgentCall): Promise<AgentResult> {
    if (this.abortRequested(call.changeId)) throw new ChangeAborted(call.changeId);
    const watch = this.#callSignal(call.changeId);
    try {
      return await this.#call(call, watch.signal);
    } finally {
      watch.stop();
    }
  }

  async #call(call: AgentCall, signal: AbortSignal): Promise<AgentResult> {
    const first = modelFor(this.config, call.modelRole, {
      ...(call.context.repo === undefined ? {} : { repo: call.context.repo }),
      agent: call.agent,
    });
    let model = first;
    let raw: AgentSession | undefined;
    let lastError: unknown;
    for (const candidate of [first, ...this.config.models.fallback]) {
      try {
        raw = await this.deps.runtime.open({
          agent: call.agent,
          model: candidate,
          title: call.title,
          context: { ...call.context, changeId: call.changeId, role: call.role },
        });
        model = candidate;
        break;
      } catch (err) {
        lastError = err;
      }
    }
    if (raw === undefined) {
      throw lastError instanceof Error
        ? lastError
        : new Error(`could not open a session for ${call.agent}`);
    }
    const provider = model.split("/")[0] ?? model;
    const session = limited(raw, this.limiter, provider);
    let turn = await promptForHandoff(session, call.prompt, signal);
    let usage = turn.usage;
    for (let attempt = 1; call.retry && turn.outcome === "succeeded"; attempt++) {
      const next = await call.retry(turn.handoff, attempt);
      if (next === undefined) break;
      turn = await promptForHandoff(session, next, signal);
      usage = addUsage(usage, turn.usage);
    }
    appendLog(
      this.root,
      call.changeId,
      {
        kind: "session",
        session: raw.id,
        agent: call.agent,
        model,
        title: call.title,
        outcome: turn.outcome,
        usage,
        ...(turn.problem ? { problem: turn.problem } : {}),
      },
      { redact: this.config.logs.redact },
    );
    const entry: UsageEntry = {
      at: new Date().toISOString(),
      sessionId: raw.id,
      agent: call.agent,
      model,
      step: call.step,
      kind: call.kind ?? "step",
      ...(call.attempt === undefined ? {} : { attempt: call.attempt }),
      usage,
    };
    // Intake runs before the change id exists; `intake` records its entry under the id.
    if (call.changeId !== "intake") await recordUsage(this.root, call.changeId, entry);
    return {
      ...(turn.handoff ? { handoff: turn.handoff } : {}),
      ...(turn.problem ? { problem: turn.problem } : {}),
      outcome: turn.outcome,
      usage,
      sessionId: raw.id,
      model,
    };
  }
}
