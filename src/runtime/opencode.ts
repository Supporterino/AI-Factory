import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import type { FactoryConfig } from "../config/schema.ts";
import { agentGitEnv } from "../git/hooks.ts";
import { appendLog } from "../logs/log.ts";
import { sessionContextFile } from "../policy/session-files.ts";
import { toolBin } from "../tools.ts";
import type { AgentRuntime, AgentSession, SessionSpec, Turn, Usage } from "./types.ts";

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

/** Credential variables per provider id; only providers named in `models` get theirs. */
const PROVIDER_ENV: Readonly<Record<string, readonly string[]>> = {
  anthropic: ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"],
  openai: ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_ORG_ID"],
  google: ["GOOGLE_GENERATIVE_AI_API_KEY", "GEMINI_API_KEY"],
  "google-vertex": [
    "GOOGLE_APPLICATION_CREDENTIALS",
    "GOOGLE_CLOUD_PROJECT",
    "GOOGLE_CLOUD_LOCATION",
    "VERTEX_LOCATION",
  ],
  "amazon-bedrock": [
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_REGION",
    "AWS_PROFILE",
    "AWS_BEARER_TOKEN_BEDROCK",
  ],
  azure: ["AZURE_API_KEY", "AZURE_RESOURCE_NAME", "AZURE_OPENAI_API_KEY", "AZURE_OPENAI_ENDPOINT"],
  openrouter: ["OPENROUTER_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  groq: ["GROQ_API_KEY"],
  xai: ["XAI_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  gitlab: ["GITLAB_TOKEN", "GITLAB_INSTANCE_URL"],
};

export function providersOf(config: FactoryConfig): string[] {
  const models = Object.values(config.models).filter((m): m is string => typeof m === "string");
  return [...new Set(models.map((m) => m.split("/")[0] ?? ""))].filter(Boolean);
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

export interface OpencodeRuntimeOptions {
  readonly root: string;
  readonly config: FactoryConfig;
  /** Change id for logs. */
  readonly changeId: string;
  /** Per prompt wall-clock limit. */
  readonly turnTimeoutMs?: number;
  readonly startTimeoutMs?: number;
  /** Base environment the curated server env is taken from (default: process.env). */
  readonly baseEnv?: NodeJS.ProcessEnv;
}

export class OpencodeRuntime implements AgentRuntime {
  readonly #opts: OpencodeRuntimeOptions;
  #proc?: ChildProcess;
  #base = "";
  #auth = "";
  readonly #events = new AbortController();
  readonly #loaded = new Set<string>();

  constructor(opts: OpencodeRuntimeOptions) {
    this.#opts = opts;
  }

  async #api<T>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<{ status: number; data: T }> {
    const res = await fetch(this.#base + path, {
      method,
      headers: {
        authorization: this.#auth,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal ? { signal } : {}),
    });
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

  async start(): Promise<void> {
    if (this.#proc) return;
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
        throw new Error(`opencode serve exited (${this.#proc.exitCode}): ${stderr}`);
      try {
        if ((await this.#api("GET", "/api/plugin")).status === 200) break;
      } catch {
        // Not listening yet.
      }
      if (Date.now() > deadline) throw new Error(`opencode serve did not start: ${stderr}`);
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
    let event: {
      type?: string;
      data?: { id?: string; sessionID?: string; action?: string; resources?: string[] };
    };
    try {
      event = JSON.parse(raw);
    } catch {
      return;
    }
    if (event.type !== "permission.asked" || !event.data?.id || !event.data.sessionID) return;
    const { id, sessionID } = event.data;
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

  /** opencode loads agents per directory asynchronously; wait until ours is visible. */
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
   */
  async #awaitTurn(
    id: string,
    marker: string | undefined,
    stop: AbortSignal,
  ): Promise<ServerMessage[]> {
    for (;;) {
      await this.#api("POST", `/api/experimental/session/${id}/wait`, undefined, stop);
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

    const timeout = AbortSignal.timeout(this.#opts.turnTimeoutMs ?? 30 * 60_000);
    const stop = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let interrupted = false;
    let messages: ServerMessage[];
    try {
      messages = await this.#awaitTurn(id, marker, stop);
    } catch {
      interrupted = true;
      await this.#api("POST", `/api/session/${id}/interrupt`);
      await this.#api("POST", `/api/experimental/session/${id}/wait`);
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
