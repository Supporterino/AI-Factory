#!/usr/bin/env bun
/**
 * Minimal `opencode serve` stand-in for runtime tests: just the endpoints `OpencodeRuntime`
 * touches for one prompt. The scripted turn lasts ~600 ms and `/wait` only answers once it
 * is over, so a client that bounds its long-poll has to poll more than once.
 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";

// The runtime exports the user's stored credentials before its first session. Tests keep
// that bridge empty; `test/auth-sync.test.ts` exercises the reconciliation directly.
if (process.argv[2] === "auth") {
  if (process.argv[3] === "export") console.log("[]");
  process.exit(0);
}

const TURN_MS = 600;
const SESSION = "ses_test";

const portArg = process.argv.indexOf("--port");
const port = Number(portArg === -1 ? 0 : process.argv[portArg + 1]);
let turnEnd = 0;
let prompted = false;

const json = (data: unknown): Response =>
  new Response(JSON.stringify({ data }), { headers: { "content-type": "application/json" } });

const messages = (): unknown[] => {
  if (!prompted || Date.now() < turnEnd) return [];
  return [
    { id: "m3", type: "idle", outcome: "succeeded" },
    {
      id: "m2",
      type: "assistant",
      content: [{ type: "text", text: "done" }],
    },
    { id: "m1", type: "user" },
  ];
};

Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname === "/api/plugin") return new Response("ok");
    if (pathname === "/api/credential" && req.method === "GET") return json([]);
    if (pathname === "/api/event") return new Response("");
    if (pathname === "/api/agent") return json([{ id: "implementer-app" }]);
    if (pathname === "/api/session" && req.method === "POST") return json({ id: SESSION });
    if (pathname === `/api/session/${SESSION}`) return json({ cost: 0.02, tokens: {} });
    if (pathname === `/api/session/${SESSION}/message`) return json(messages());
    if (pathname === `/api/session/${SESSION}/prompt` && req.method === "POST") {
      prompted = true;
      turnEnd = Date.now() + TURN_MS;
      return new Response(null, { status: 204 });
    }
    if (pathname === `/api/session/${SESSION}/interrupt` && req.method === "POST")
      return new Response(null, { status: 204 });
    if (pathname === `/api/experimental/session/${SESSION}/wait` && req.method === "POST") {
      // Observability for the test: one line per long-poll (an aborted poll still wrote it).
      appendFileSync(join(process.cwd(), ".factory", "wait.log"), "wait\n");
      const left = turnEnd - Date.now();
      if (left > 0) await Bun.sleep(left);
      return new Response(null, { status: 204 });
    }
    return new Response("not found", { status: 404 });
  },
});
