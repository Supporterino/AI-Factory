#!/usr/bin/env bun
/**
 * `opencode serve` stand-in for progress tests: the endpoints `OpencodeRuntime` touches plus
 * one SSE stream per turn (`/api/event`) with tool, step and usage events. Foreign sessions
 * and unknown/malformed events are mixed in on purpose; the runtime must ignore them.
 */
const TURN_MS = 120;
const SESSION = "ses_events";

const portArg = process.argv.indexOf("--port");
const port = Number(portArg === -1 ? 0 : process.argv[portArg + 1]);
let turnEnd = 0;
let prompted = false;
let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
const encoder = new TextEncoder();

const json = (data: unknown): Response =>
  new Response(JSON.stringify({ data }), { headers: { "content-type": "application/json" } });

const messages = (): unknown[] => {
  if (!prompted || Date.now() < turnEnd) return [];
  return [
    { id: "m3", type: "idle", outcome: "succeeded" },
    { id: "m2", type: "assistant", content: [{ type: "text", text: "done" }] },
    { id: "m1", type: "user" },
  ];
};

const send = (type: string, data: Record<string, unknown>): void => {
  controller?.enqueue(encoder.encode(`data: ${JSON.stringify({ type, data })}\n\n`));
};

const stream = new ReadableStream<Uint8Array>({
  start(streamController) {
    controller = streamController;
  },
});

Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname === "/api/plugin") return new Response("ok");
    if (pathname === "/api/event")
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    if (pathname === "/api/agent") return json([{ id: "implementer-app" }]);
    if (pathname === "/api/session" && req.method === "POST") return json({ id: SESSION });
    if (pathname === `/api/session/${SESSION}`) return json({ cost: 0.02, tokens: {} });
    if (pathname === `/api/session/${SESSION}/message`) return json(messages());
    if (pathname === `/api/session/${SESSION}/prompt` && req.method === "POST") {
      prompted = true;
      turnEnd = Date.now() + TURN_MS;
      setTimeout(() => {
        send("session.step.started", {
          sessionID: SESSION,
          model: { providerID: "stub", id: "claude-stub" },
        });
        send("session.tool.input.started", {
          sessionID: SESSION,
          assistantMessageID: "m2",
          id: "t1",
          name: "bash",
        });
        send("session.tool.called", {
          sessionID: SESSION,
          assistantMessageID: "m2",
          id: "t1",
          input: { command: "bun test" },
        });
        send("session.step.ended", {
          sessionID: SESSION,
          tokens: {
            input: 10,
            output: 2,
            reasoning: 1,
            cache: { read: 5, write: 1 },
          },
          cost: 0.01,
        });
        send("session.tool.success", {
          sessionID: SESSION,
          assistantMessageID: "m2",
          id: "t1",
        });
        // Foreign session, unknown type and malformed JSON: all ignored.
        send("session.tool.called", {
          sessionID: "ses_other",
          assistantMessageID: "m9",
          id: "t9",
          input: { command: "rm -rf /" },
        });
        send("session.unknown.event", { sessionID: SESSION, id: "x" });
        controller?.enqueue(encoder.encode("data: not-json\n\n"));
      }, 10);
      return new Response(null, { status: 204 });
    }
    if (pathname === `/api/session/${SESSION}/interrupt` && req.method === "POST")
      return new Response(null, { status: 204 });
    if (pathname === `/api/experimental/session/${SESSION}/wait` && req.method === "POST") {
      const left = turnEnd - Date.now();
      if (left > 0) await Bun.sleep(left);
      return new Response(null, { status: 204 });
    }
    return new Response("not found", { status: 404 });
  },
});
