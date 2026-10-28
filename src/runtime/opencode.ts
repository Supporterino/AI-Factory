import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { allModels, type FactoryConfig } from "../config/schema.ts";
import { TransientError } from "../errors.ts";
import { agentGitEnv } from "../git/hooks.ts";
import { appendLog } from "../logs/log.ts";
import { sandboxEnabled } from "../policy/sandbox.ts";
import { sessionContextFile } from "../policy/session-files.ts";
import { toolBin } from "../tools.ts";
import { PROVIDER_ENV, scrubList } from "./credentials.ts";
import type {
  AgentRuntime,
  AgentSession,
  SessionActivity,
  SessionSpec,
  Turn,
  Usage,
} from "./types.ts";

/**
 * Drives one private `opencode serve` per CLI run (ADR-0001; verified end to end in
 * docs/research/opencode-e2e.md): REST over HTTP Basic auth, one session per agent call,
 * the role's model passed explicitly, a curated environment, and every permission prompt
 * rejected (headless `ask` would wait forever).
 */

/** System variables the server (and the agents' shells) may see. */
const ENV_ALLOW = [
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
];
const PROXY_ENV = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
];

export function providersOf(config: FactoryConfig): string[] {
  return [...new Set(allModels(config).map((m) => m.split("/")[0] ?? ""))].filter(Boolean);
}

export function serverEnv(
  root: string,
  config: FactoryConfig,
  password: string,
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  const keep = [
    ...ENV_ALLOW,
    ...PROXY_ENV,
    ...providersOf(config).flatMap((p) => PROVIDER_ENV[p] ?? []),
  ];
  for (const name of keep) {
    const value = base[name];
    if (value !== undefined) env[name] = value;
  }
  return {
    ...env,
    ...agentGitEnv({}),
    OPENCODE_PASSWORD: password,
    OPENCODE_DB: join(root, ".factory", "opencode", "opencode.db"),
    AI_FACTORY_WORKSPACE: root,
    // The plugin removes these from every shell it lets run, and sandboxes the shell.
    AI_FACTORY_SCRUB: scrubList().join(","),
    AI_FACTORY_SANDBOX: sandboxEnabled(config.security.sandbox) ? "seatbelt" : "off",
    AI_FACTORY_GRAPH: join(root, "graphify-out", "graph.json"),
    NO_COLOR: "1",
  };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      const port = typeof address === "object" && address ? address.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

export function splitModel(model: string): { providerID: string; id: string; variant?: string } {
  const slash = model.indexOf("/");
  const [id = "", variant] = model.slice(slash + 1).split("#");
  return { providerID: model.slice(0, slash), id, ...(variant ? { variant } : {}) };
}

interface ServerMessage {
  readonly type: string;
  readonly outcome?: string;
  readonly content?: { type: string; text?: string }[];
  readonly error?: { message?: string };
}

/** The parts of an opencode SSE event this runtime reads (all optional; events vary by version). */
interface ServerEvent {
  readonly type?: string;
  readonly data?: {
    readonly sessionID?: string;
    readonly id?: string;
    readonly assistantMessageID?: string;
    readonly name?: string;
    readonly input?: unknown;
    readonly action?: string;
    readonly resources?: string[];
    readonly model?: {
      readonly providerID?: string;
      readonly id?: string;
      readonly modelID?: string;
    };
    readonly tokens?: {
      readonly input?: number;
      readonly output?: number;
      readonly reasoning?: number;
      readonly cache?: { readonly read?: number; readonly write?: number };
    };
    readonly cost?: number;
    readonly error?: { readonly message?: string };
    readonly reason?: string;
  };
}

const toolKey = (message: string, id: string): string => `${message}\0${id}`;

/** Per-step usage from `session.step.ended`; absent on older servers, so it is optional. */
function stepUsage(data: NonNullable<ServerEvent["data"]>): Usage | undefined {
  const tokens = data.tokens;
  if (tokens === undefined) return undefined;
  return {
    input: tokens.input ?? 0,
    output: tokens.output ?? 0,
    reasoning: tokens.reasoning ?? 0,
    cacheRead: tokens.cache?.read ?? 0,
    cacheWrite: tokens.cache?.write ?? 0,
    cost: data.cost ?? 0,
  };
}

interface SessionInfo {
  readonly outcome?: string;
  readonly cost?: number;
  readonly tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
  };
}

function usageOf(s: SessionInfo): Usage {
  return {
    input: s.tokens?.input ?? 0,
    output: s.tokens?.output ?? 0,
    reasoning: s.tokens?.reasoning ?? 0,
    cacheRead: s.tokens?.cache?.read ?? 0,
    cacheWrite: s.tokens?.cache?.write ?? 0,
    cost: s.cost ?? 0,
  };
}

const minus = (a: Usage, b: Usage): Usage => ({
  input: a.input - b.input,
  output: a.output - b.output,
  reasoning: a.reasoning - b.reasoning,
  cacheRead: a.cacheRead - b.cacheRead,
  cacheWrite: a.cacheWrite - b.cacheWrite,
  cost: a.cost - b.cost,
});

/**
 * Upper bound on one `/wait` long-poll. That request sends no response headers until the
 * turn goes idle, and Node's fetch defaults to a 300 s headers timeout, so an agent turn
 * longer than 5 minutes used to fail with a bogus "server unreachable". A poll that runs
 * out is simply retried; the turn limit itself stays `turnTimeoutMs`.
 */
const WAIT_POLL_MS = 60_000;

/** True for the timeouts thrown by `AbortSignal.timeout` and by undici's fetch. */
function isTimeout(err: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current !== null && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const { name, cause } = current as { name?: unknown; cause?: unknown };
    if (name === "TimeoutError" || name === "HeadersTimeoutError" || name === "BodyTimeoutError")
      return true;
    current = cause;
  }
  return false;
}

export interface OpencodeRuntimeOptions {
  readonly root: string;
  readonly config: FactoryConfig;
  /** Change id for logs. */
  readonly changeId: string;
  /** Per prompt wall-clock limit (default 60 minutes; `runtime.turnTimeoutMinutes`). */
  readonly turnTimeoutMs?: number;
  readonly startTimeoutMs?: number;
  /** Bound on one `/wait` long-poll (tests shorten it); expiry retries the poll. */
  readonly waitPollMs?: number;
  /** Base environment the curated server env is taken from (default: process.env). */
  readonly baseEnv?: NodeJS.ProcessEnv;
}

export class OpencodeRuntime implements AgentRuntime {
  readonly #opts: OpencodeRuntimeOptions;
  #proc?: ChildProcess;
  #base = "";
  #auth = "";
  #events = new AbortController();
  readonly #loaded = new Set<string>();
  /** Session id → its progress callback (registered on `open`). */
  readonly #activity = new Map<string, (activity: SessionActivity) => void>();
  /** `assistantMessageID\0toolID` → tool name: `session.tool.called` does not repeat it. */
  readonly #toolNames = new Map<string, string>();

  constructor(opts: OpencodeRuntimeOptions) {
    this.#opts = opts;
  }

  async #api<T>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<{ status: number; data: T }> {
    let res: Response;
    try {
      res = await fetch(this.#base + path, {
        method,
        headers: {
          authorization: this.#auth,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      const detail = err instanceof Error ? err.message : String(err);
      // A client-side limit, not a dead server: saying "unreachable" sends readers to the
      // wrong layer. (The bounded /wait poll makes this rare; see WAIT_POLL_MS.)
      if (isTimeout(err))
        throw new TransientError(
          `opencode client timed out during ${method} ${path}${this.#alive() ? "" : " (the server exited)"}: ${detail}`,
        );
      // Connection refused or reset: the server is gone, which is not the agent's fault.
      throw new TransientError(
        `opencode server unreachable${this.#alive() ? "" : " (it exited)"}: ${detail}`,
      );
    }
    const text = await res.text();
    let json: unknown = text;
    try {
      json = JSON.parse(text);
    } catch {
      // Empty bodies (204) and plain-text errors stay as text.
    }
    const data = (
      typeof json === "object" && json !== null && "data" in json
        ? (json as { data: T }).data
        : json
    ) as T;
    return { status: res.status, data };
  }

  #alive(): boolean {
    return (
      this.#proc !== undefined && this.#proc.exitCode === null && this.#proc.signalCode === null
    );
  }

  /** The server's pid while it runs (tests use it to simulate a crash). */
  get serverPid(): number | undefined {
    return this.#alive() ? this.#proc?.pid : undefined;
  }

  /** Starts the server, or starts a new one if the previous one died (audit P5). */
  async start(): Promise<void> {
    if (this.#alive()) return;
    if (this.#proc !== undefined) {
      this.#events.abort();
      this.#events = new AbortController();
      this.#loaded.clear();
      this.#toolNames.clear();
    }
    const password = randomBytes(18).toString("base64url");
    const port = await freePort();
    mkdirSync(join(this.#opts.root, ".factory", "opencode"), { recursive: true });
    this.#base = `http://127.0.0.1:${port}`;
    this.#auth = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
    this.#proc = spawn(
      toolBin("opencode"),
      ["serve", "--hostname", "127.0.0.1", "--port", String(port)],
      {
        cwd: this.#opts.root,
        env: serverEnv(this.#opts.root, this.#opts.config, password, this.#opts.baseEnv),
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let stderr = "";
    this.#proc.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-4000);
    });
    const deadline = Date.now() + (this.#opts.startTimeoutMs ?? 30_000);
    for (;;) {
      if (this.#proc.exitCode !== null)
        throw new TransientError(`opencode serve exited (${this.#proc.exitCode}): ${stderr}`);
      try {
        if ((await this.#api("GET", "/api/plugin")).status === 200) break;
      } catch {
        // Not listening yet.
      }
      if (Date.now() > deadline)
        throw new TransientError(`opencode serve did not start: ${stderr}`);
      await new Promise((r) => setTimeout(r, 200));
    }
    void this.#watchEvents();
  }

  /** Rejects every permission prompt (allow/deny-only rule sets should never produce one). */
  async #watchEvents(): Promise<void> {
    try {
      const res = await fetch(`${this.#base}/api/event`, {
        headers: { authorization: this.#auth, accept: "text/event-stream" },
        signal: this.#events.signal,
      });
      const reader = res.body?.getReader();
      if (!reader) return;
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += decoder.decode(value, { stream: true });
        for (let i = buf.indexOf("\n\n"); i !== -1; i = buf.indexOf("\n\n")) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = chunk
            .split("\n")
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trimStart())
            .join("\n");
          if (data) await this.#onEvent(data);
        }
      }
    } catch {
      // Stream closed (shutdown or server exit).
    }
  }

  async #onEvent(raw: string): Promise<void> {
    let event: ServerEvent;
    try {
      event = JSON.parse(raw) as ServerEvent;
    } catch {
      return;
    }
    const sessionID = event.data?.sessionID;
    if (typeof sessionID === "string") {
      const listener = this.#activity.get(sessionID);
      if (listener !== undefined) {
        const activity = this.#activityOf(event);
        if (activity !== undefined) {
          // Progress is display-only: a broken terminal must never break the session.
          try {
            listener(activity);
          } catch {
            // Ignored on purpose.
          }
        }
      }
    }
    if (event.type !== "permission.asked" || !event.data?.id || !sessionID) return;
    const { id } = event.data;
    appendLog(this.#opts.root, this.#opts.changeId, {
      kind: "permission-rejected",
      session: sessionID,
      action: event.data.action,
      resources: event.data.resources,
    });
    const reply = await this.#api("POST", `/api/session/${sessionID}/permission/${id}/reply`, {
      decision: "reject",
    });
    if (reply.status >= 400) await this.#api("POST", `/api/session/${sessionID}/interrupt`);
  }

  /** Tool name cached from `session.tool.input.started`, when the event itself lacks it. */
  #toolName(data: NonNullable<ServerEvent["data"]>): string {
    if (typeof data.id === "string" && typeof data.assistantMessageID === "string") {
      const name = this.#toolNames.get(toolKey(data.assistantMessageID, data.id));
      if (name !== undefined) return name;
    }
    return typeof data.name === "string" ? data.name : "tool";
  }

  /** The opencode event stream as display progress; unknown and foreign events are ignored. */
  #activityOf(event: ServerEvent): SessionActivity | undefined {
    const data = event.data;
    if (data === undefined) return undefined;
    switch (event.type) {
      case "session.step.started": {
        const model = data.model;
        const name =
          model === undefined
            ? undefined
            : [model.providerID, model.id ?? model.modelID]
                .filter((p) => p !== undefined)
                .join("/");
        return { kind: "step-started", ...(name ? { model: name } : {}) };
      }
      case "session.tool.input.started": {
        if (
          typeof data.id === "string" &&
          typeof data.assistantMessageID === "string" &&
          typeof data.name === "string"
        ) {
          this.#toolNames.set(toolKey(data.assistantMessageID, data.id), data.name);
        }
        return undefined;
      }
      case "session.tool.called":
        return {
          kind: "tool",
          tool: this.#toolName(data),
          ...(data.input === undefined ? {} : { input: data.input }),
        };
      case "session.tool.success":
      case "session.tool.failed": {
        const tool = this.#toolName(data);
        const error = data.error?.message;
        if (typeof data.id === "string" && typeof data.assistantMessageID === "string")
          this.#toolNames.delete(toolKey(data.assistantMessageID, data.id));
        return {
          kind: "tool-done",
          tool,
          status: event.type === "session.tool.failed" ? "failed" : "ok",
          ...(typeof error === "string" ? { error } : {}),
        };
      }
      case "session.step.ended": {
        const usage = stepUsage(data);
        return usage === undefined ? undefined : { kind: "step-done", usage };
      }
      case "session.retry.scheduled": {
        const reason = data.error?.message ?? data.reason;
        return { kind: "retry", ...(typeof reason === "string" ? { reason } : {}) };
      }
      default:
        return undefined;
    }
  }

  /**
   * opencode loads agents per directory asynchronously; wait until ours is visible. 2.2.0 can
   * return 503 while plugins settle, so any non-array response is treated as "not yet".
   */
  async #awaitAgent(directory: string, agent: string): Promise<void> {
    const key = `${directory}\0${agent}`;
    if (this.#loaded.has(key)) return;
    const q = `location%5Bdirectory%5D=${encodeURIComponent(directory)}`;
    for (let i = 0; i < 100; i++) {
      const res = await this.#api<{ id: string }[]>("GET", `/api/agent?${q}`);
      if (Array.isArray(res.data) && res.data.some((a) => a.id === agent)) {
        this.#loaded.add(key);
        return;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(
      `opencode did not load agent ${agent} for ${directory} (check .opencode/agents)`,
    );
  }

  async open(spec: SessionSpec): Promise<AgentSession> {
    await this.start();
    await this.#awaitAgent(spec.context.directory, spec.agent);
    const created = await this.#api<{ id: string }>("POST", "/api/session", {
      agent: spec.agent,
      model: splitModel(spec.model),
      location: { directory: spec.context.directory },
      title: spec.title,
    });
    const id = created.data?.id;
    if (created.status >= 400 || typeof id !== "string") {
      throw new Error(
        `opencode session create failed (${created.status}): ${JSON.stringify(created.data)}`,
      );
    }
    if (spec.onActivity !== undefined) this.#activity.set(id, spec.onActivity);
    // The plugin refuses every tool call of a session without its context file.
    const file = sessionContextFile(this.#opts.root, id);
    mkdirSync(join(this.#opts.root, ".factory", "sessions"), { recursive: true });
    writeFileSync(file, JSON.stringify({ sessionId: id, ...spec.context }, null, 2));
    return {
      id,
      prompt: (text, signal) => this.#prompt(id, text, signal),
    };
  }

  async #session(id: string): Promise<SessionInfo> {
    return (await this.#api<SessionInfo>("GET", `/api/session/${id}`)).data ?? {};
  }

  /** Newest first. 200 is the server's page limit (larger values are rejected). */
  async #recent(id: string): Promise<(ServerMessage & { id?: string })[]> {
    const res = await this.#api<(ServerMessage & { id?: string })[]>(
      "GET",
      `/api/session/${id}/message?order=desc&limit=200`,
    );
    return Array.isArray(res.data) ? res.data : [];
  }

  /** Messages newer than `marker` (the newest message before our prompt), newest first. */
  #since(
    messages: (ServerMessage & { id?: string })[],
    marker: string | undefined,
  ): ServerMessage[] {
    const cut = marker === undefined ? -1 : messages.findIndex((m) => m.id === marker);
    return cut === -1 ? messages : messages.slice(0, cut);
  }

  /**
   * Waits until the turn started by our prompt finished: the newest message is an `idle`
   * entry newer than our user message. (`/wait` alone can return before the queued prompt
   * starts executing.)
   *
   * `/wait` is polled in short slices so no single request outlives the HTTP client's
   * 300 s headers timeout (see WAIT_POLL_MS). Only `stop` ends the turn; a slice expiring
   * just means "still working".
   */
  async #awaitTurn(
    id: string,
    marker: string | undefined,
    stop: AbortSignal,
  ): Promise<ServerMessage[]> {
    const pollMs = this.#opts.waitPollMs ?? WAIT_POLL_MS;
    for (;;) {
      const poll = AbortSignal.any([stop, AbortSignal.timeout(pollMs)]);
      try {
        await this.#api("POST", `/api/experimental/session/${id}/wait`, undefined, poll);
      } catch (err) {
        // Our slice ran out mid-turn: inspect the messages, then poll again. A stop or a
        // genuine connection failure is the real end of the turn (or of the run).
        if (stop.aborted || !poll.aborted) throw err;
      }
      const all = await this.#recent(id);
      const fresh = this.#since(all, marker);
      const markerSeen = marker === undefined || all.some((m) => m.id === marker);
      if (fresh[0]?.type === "idle" && (fresh.some((m) => m.type === "user") || !markerSeen))
        return fresh;
      if (stop.aborted) throw new Error("aborted");
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  async #prompt(id: string, text: string, signal?: AbortSignal): Promise<Turn> {
    const before = usageOf(await this.#session(id));
    const marker = (await this.#recent(id))[0]?.id;
    const sent = await this.#api("POST", `/api/session/${id}/prompt`, { text });
    if (sent.status >= 400)
      throw new Error(`opencode prompt failed (${sent.status}): ${JSON.stringify(sent.data)}`);

    const timeout = AbortSignal.timeout(this.#opts.turnTimeoutMs ?? 60 * 60_000);
    const stop = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let interrupted = false;
    let messages: ServerMessage[];
    try {
      messages = await this.#awaitTurn(id, marker, stop);
    } catch (err) {
      if (err instanceof TransientError) throw err; // the server died mid-turn
      interrupted = true;
      await this.#api("POST", `/api/session/${id}/interrupt`);
      try {
        await this.#api(
          "POST",
          `/api/experimental/session/${id}/wait`,
          undefined,
          AbortSignal.timeout(this.#opts.waitPollMs ?? WAIT_POLL_MS),
        );
      } catch {
        // Best effort: the message list below shows whatever the turn produced.
      }
      messages = this.#since(await this.#recent(id), marker);
    }

    const after = await this.#session(id);
    const last = messages.find((m) => m.type === "assistant");
    const textOut = (last?.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n");
    const idle = messages.find((m) => m.type === "idle");
    const finalOutcome = idle?.outcome ?? after.outcome;
    const outcome =
      interrupted || finalOutcome === "interrupted"
        ? "interrupted"
        : finalOutcome === "failed"
          ? "failed"
          : "succeeded";
    const error = last?.error?.message ?? (timeout.aborted ? "turn timed out" : undefined);
    return {
      text: textOut,
      outcome,
      usage: minus(usageOf(after), before),
      ...(error ? { error } : {}),
    };
  }

  async close(): Promise<void> {
    this.#events.abort();
    this.#activity.clear();
    this.#toolNames.clear();
    const proc = this.#proc;
    if (!proc || proc.exitCode !== null) return;
    proc.kill("SIGTERM");
    await Promise.race([
      new Promise((r) => proc.once("exit", r)),
      new Promise((r) => setTimeout(r, 5000)),
    ]);
    if (proc.exitCode === null) proc.kill("SIGKILL");
  }
}
