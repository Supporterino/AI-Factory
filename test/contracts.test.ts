import { describe, expect, test } from "bun:test";
import { diffOpenApi, referencedRemovedPaths } from "../src/contracts/openapi.ts";
import { diffProto, parseProto } from "../src/contracts/proto.ts";
import { diffSchema, localResolver } from "../src/contracts/schema-diff.ts";

const api = (paths: Record<string, unknown>, schemas: Record<string, unknown> = {}) => ({
  openapi: "3.0.3",
  info: { title: "t", version: "1" },
  paths,
  components: { schemas },
});

const health = (props: Record<string, unknown>, req: string[] = ["status"]) => ({
  "/health": {
    get: {
      responses: {
        "200": {
          description: "ok",
          content: { "application/json": { schema: { $ref: "#/components/schemas/Health" } } },
        },
      },
    },
  },
  _schemas: { Health: { type: "object", required: req, properties: props } },
});

function doc(variant: ReturnType<typeof health>, extraPaths: Record<string, unknown> = {}) {
  const { _schemas, ...paths } = variant;
  return api({ ...paths, ...extraPaths }, _schemas);
}

const messages = (a: unknown, b: unknown) => diffOpenApi(a, b).map((x) => `${x.at}: ${x.message}`);

describe("OpenAPI breaking-change diff", () => {
  const base = doc(health({ status: { type: "string", enum: ["ok", "degraded"] } }));

  test("compatible changes pass", () => {
    const next = doc(
      health({ status: { type: "string", enum: ["ok", "degraded"] }, uptime: { type: "integer" } }),
      {
        "/version": { get: { responses: { "200": { description: "v" } } } },
      },
    );
    expect(messages(base, next)).toEqual([]);
  });

  test("removed operations, removed or optional response fields, widened enums break", () => {
    expect(messages(base, api({}))).toEqual(["GET /health: operation was removed"]);
    expect(messages(base, doc(health({}, [])))).toEqual([
      "GET /health response 200 application/json/status: was removed",
    ]);
    expect(
      messages(base, doc(health({ status: { type: "string", enum: ["ok", "degraded"] } }, []))),
    ).toEqual([
      "GET /health response 200 application/json/status: is no longer guaranteed (was required)",
    ]);
    expect(
      messages(base, doc(health({ status: { type: "string", enum: ["ok", "degraded", "down"] } }))),
    ).toEqual(['GET /health response 200 application/json/status: may now return "down"']);
    expect(
      messages(
        base,
        doc(health({ status: { type: ["string", "null"], enum: ["ok", "degraded"] } })),
      ),
    ).toEqual(["GET /health response 200 application/json/status: may now be of type null"]);
  });

  test("new required parameters, required bodies and narrowed request schemas break", () => {
    const op = (parameters: unknown[], requestBody?: unknown) =>
      api({
        "/users/{id}": {
          put: {
            parameters,
            ...(requestBody ? { requestBody } : {}),
            responses: { "204": { description: "" } },
          },
        },
      });
    const body = (schema: unknown, required = false) => ({
      required,
      content: { "application/json": { schema } },
    });
    const before = op(
      [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      body({ type: "object", properties: { name: { type: "string" } } }),
    );
    const renamedParam = op(
      [{ name: "userId", in: "path", required: true, schema: { type: "string" } }],
      body({ type: "object", properties: { name: { type: "string" } } }),
    );
    expect(messages(before, renamedParam)).toEqual([]);
    const after = op(
      [
        { name: "id", in: "path", required: true, schema: { type: "integer" } },
        { name: "tenant", in: "header", required: true, schema: { type: "string" } },
      ],
      body(
        {
          type: "object",
          required: ["email"],
          properties: { name: { type: "string", maxLength: 10 }, email: { type: "string" } },
        },
        true,
      ),
    );
    expect(messages(before, after)).toEqual([
      "PUT /users/{} parameter path:{}: no longer accepts type string",
      "PUT /users/{} parameter header:tenant: new required parameter",
      "PUT /users/{} requestBody: request body became required",
      "PUT /users/{} requestBody application/json/email: is now required",
      "PUT /users/{} requestBody application/json/name: maxLength tightened to 10",
    ]);
  });

  test("consumers still referencing removed paths are reported", () => {
    const old = api({ "/users/{id}": {}, "/health": {} });
    const next = api({ "/health": {} });
    expect(referencedRemovedPaths(old, next, ["fetch(`/users/${id}`)", "GET /health"])).toEqual([
      "/users/{id}",
    ]);
    expect(referencedRemovedPaths(old, next, ["/users-list"])).toEqual([]);
  });
});

describe("JSON Schema (input direction, e.g. Helm values)", () => {
  const diff = (a: unknown, b: unknown) =>
    diffSchema(a, b, "input", "", {
      oldResolve: localResolver(a),
      newResolve: localResolver(b),
    }).map((x) => `${x.at}: ${x.message}`);
  const values = {
    type: "object",
    properties: {
      replicas: { type: "integer", minimum: 1 },
      image: { type: "object", properties: { tag: { type: "string" } } },
      mode: { enum: ["a", "b"] },
    },
  };

  test("adding optional values is compatible", () => {
    expect(
      diff(values, { ...values, properties: { ...values.properties, debug: { type: "boolean" } } }),
    ).toEqual([]);
  });

  test("required values, removed enum values, tighter limits and closed objects break", () => {
    const next = {
      type: "object",
      required: ["image"],
      additionalProperties: false,
      properties: {
        replicas: { type: "integer", minimum: 2 },
        image: { type: "object", properties: { tag: { type: "string" } } },
        mode: { enum: ["a"] },
      },
    };
    expect(diff(values, next)).toEqual([
      ": no longer accepts additional properties",
      "/image: is now required",
      "/replicas: minimum tightened to 2",
      '/mode: no longer accepts "b"',
    ]);
  });
});

describe("proto diff", () => {
  const v1 = `syntax = "proto3";
package shop.v1;
// Orders
message Order {
  string id = 1;
  repeated Item items = 2;
  map<string, string> labels = 3;
  oneof payment { string card = 4; string iban = 5; }
  message Item { string sku = 1; }
}
enum Status { STATUS_UNSPECIFIED = 0; STATUS_OPEN = 1; STATUS_CLOSED = 2; }
service Orders {
  rpc Get (GetRequest) returns (Order);
  rpc Watch (GetRequest) returns (stream Order);
}
message GetRequest { string id = 1; }`;

  test("additions and reserved removals are compatible", () => {
    const v2 = v1
      .replace(
        "  repeated Item items = 2;",
        '  reserved 2;\n  reserved "items";\n  string note = 6;',
      )
      .replace("STATUS_CLOSED = 2;", "reserved 2;");
    expect(diffProto(parseProto(v1), parseProto(v2))).toEqual([]);
  });

  test("removed fields, changed types and labels, removed values and rpcs break", () => {
    const v2 = v1
      .replace("  string id = 1;\n  repeated", "  int64 id = 1;\n  repeated")
      .replace("repeated Item items = 2;", "Item items = 2;")
      .replace("map<string, string> labels = 3;", "")
      .replace("STATUS_CLOSED = 2;", "")
      .replace("rpc Watch (GetRequest) returns (stream Order);", "")
      .replace(
        "rpc Get (GetRequest) returns (Order);",
        "rpc Get (stream GetRequest) returns (Order);",
      );
    expect(diffProto(parseProto(v1), parseProto(v2)).map((b) => `${b.at}: ${b.message}`)).toEqual([
      "shop.v1.Order.id = 1: type changed from string to int64",
      "shop.v1.Order.items = 2: label changed from repeated to singular",
      "shop.v1.Order.labels = 3: field was removed without reserving its number",
      "shop.v1.Status.STATUS_CLOSED = 2: enum value was removed without reserving its number",
      "shop.v1.Orders/Get: signature changed from (GetRequest) → (Order) to (stream GetRequest) → (Order)",
      "shop.v1.Orders/Watch: rpc was removed",
    ]);
  });
});
