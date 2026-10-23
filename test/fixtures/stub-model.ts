/**
 * A scripted Anthropic-compatible model server for end-to-end runs of the real opencode
 * binary (ported from the slice-6 spike). Each request's step is chosen from the number of
 * tool results already in the conversation, so it is stateless.
 */

export type StubStep = { tool: string; input: Record<string, unknown> } | { text: string };

interface Message {
  readonly content?: unknown;
}

function toolResults(messages: readonly Message[]): number {
  let n = 0;
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const part of m.content as { type?: string }[]) if (part?.type === "tool_result") n++;
  }
  return n;
}

const event = (type: string, data: Record<string, unknown>): string =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

export interface StubServer {
  readonly baseURL: string;
  readonly requests: unknown[];
  stop(): void;
}

export function startStubModel(script: readonly StubStep[]): StubServer {
  const requests: unknown[] = [];
  let n = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const body = (await req.json().catch(() => ({}))) as {
        model?: string;
        messages?: Message[];
        tools?: unknown[];
      };
      requests.push(body);
      if (!new URL(req.url).pathname.endsWith("/messages"))
        return new Response("not found", { status: 404 });
      const step: StubStep =
        (body.tools ?? []).length === 0
          ? { text: "Title" }
          : (script[Math.min(toolResults(body.messages ?? []), script.length - 1)] ?? {
              text: "done",
            });
      const id = `msg_stub_${++n}`;
      const out = [
        event("message_start", {
          message: {
            id,
            type: "message",
            role: "assistant",
            model: body.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: {
              input_tokens: 1234,
              output_tokens: 1,
              cache_creation_input_tokens: 1000,
              cache_read_input_tokens: 200,
            },
          },
        }),
      ];
      if ("tool" in step) {
        out.push(
          event("content_block_start", {
            index: 0,
            content_block: { type: "tool_use", id: `toolu_${n}`, name: step.tool, input: {} },
          }),
        );
        out.push(
          event("content_block_delta", {
            index: 0,
            delta: { type: "input_json_delta", partial_json: JSON.stringify(step.input) },
          }),
        );
      } else {
        out.push(
          event("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
        );
        out.push(
          event("content_block_delta", {
            index: 0,
            delta: { type: "text_delta", text: step.text },
          }),
        );
      }
      out.push(event("content_block_stop", { index: 0 }));
      out.push(
        event("message_delta", {
          delta: { stop_reason: "tool" in step ? "tool_use" : "end_turn", stop_sequence: null },
          usage: { output_tokens: 42 },
        }),
      );
      out.push(event("message_stop", {}));
      return new Response(out.join(""), { headers: { "content-type": "text/event-stream" } });
    },
  });
  return { baseURL: `http://127.0.0.1:${server.port}/v1`, requests, stop: () => server.stop(true) };
}
