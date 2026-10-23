import { type Breaking, type DiffContext, diffSchema, localResolver } from "./schema-diff.ts";

/**
 * OpenAPI 3.x breaking-change diff (§7 step 9): removed paths and operations, new required
 * parameters or request bodies, removed success responses and media types, and schema
 * changes in the direction that breaks consumers (requests: narrowing; responses: widening).
 */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;

/** `/users/{id}` and `/users/{userId}` are the same operation. */
export const normalizePath = (path: string): string => path.replace(/\{[^}]+\}/g, "{}");

function deref(v: unknown, resolve: (ref: string) => unknown): Obj | undefined {
  let current = v;
  for (let i = 0; i < 10 && isObj(current) && typeof current.$ref === "string"; i++)
    current = resolve(current.$ref);
  return isObj(current) ? current : undefined;
}

interface Param {
  readonly key: string;
  readonly required: boolean;
  readonly schema: unknown;
}

function params(pathItem: Obj, op: Obj, resolve: (ref: string) => unknown): Map<string, Param> {
  const out = new Map<string, Param>();
  for (const list of [pathItem.parameters, op.parameters]) {
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      const p = deref(raw, resolve);
      if (!p || typeof p.name !== "string" || typeof p.in !== "string") continue;
      const key = `${p.in}:${p.in === "path" ? "{}" : p.name}`;
      out.set(key, { key, required: p.required === true || p.in === "path", schema: p.schema });
    }
  }
  return out;
}

function content(v: unknown, resolve: (ref: string) => unknown): Record<string, unknown> {
  const body = deref(v, resolve);
  return body && isObj(body.content) ? body.content : {};
}

function operations(
  doc: Obj,
): Map<string, { path: string; method: string; pathItem: Obj; op: Obj }> {
  const out = new Map<string, { path: string; method: string; pathItem: Obj; op: Obj }>();
  const paths = isObj(doc.paths) ? doc.paths : {};
  for (const [path, item] of Object.entries(paths)) {
    if (!isObj(item)) continue;
    for (const method of METHODS) {
      const op = item[method];
      if (isObj(op))
        out.set(`${method.toUpperCase()} ${normalizePath(path)}`, {
          path,
          method,
          pathItem: item,
          op,
        });
    }
  }
  return out;
}

export function isOpenApi3(doc: unknown): boolean {
  return isObj(doc) && typeof doc.openapi === "string" && doc.openapi.startsWith("3");
}

export function diffOpenApi(oldDoc: unknown, newDoc: unknown): Breaking[] {
  if (!isObj(oldDoc) || !isObj(newDoc)) return [];
  const oldResolve = localResolver(oldDoc);
  const newResolve = localResolver(newDoc);
  const ctx: DiffContext = { oldResolve, newResolve };
  const out: Breaking[] = [];
  const oldOps = operations(oldDoc);
  const newOps = operations(newDoc);

  for (const [key, o] of oldOps) {
    const n = newOps.get(key);
    if (n === undefined) {
      out.push({ at: key, message: "operation was removed" });
      continue;
    }
    // Parameters.
    const op = params(o.pathItem, o.op, oldResolve);
    const np = params(n.pathItem, n.op, newResolve);
    for (const [pk, p] of np) {
      const before = op.get(pk);
      if (p.required && !before?.required)
        out.push({
          at: `${key} parameter ${pk}`,
          message: before ? "became required" : "new required parameter",
        });
      if (before)
        out.push(...diffSchema(before.schema, p.schema, "input", `${key} parameter ${pk}`, ctx));
    }
    // Request body.
    const oBody = deref(o.op.requestBody, oldResolve);
    const nBody = deref(n.op.requestBody, newResolve);
    if (nBody?.required === true && oBody?.required !== true)
      out.push({ at: `${key} requestBody`, message: "request body became required" });
    const oReq = content(o.op.requestBody, oldResolve);
    const nReq = content(n.op.requestBody, newResolve);
    for (const [media, m] of Object.entries(oReq)) {
      const nm = nReq[media];
      if (nm === undefined) {
        if (Object.keys(nReq).length > 0)
          out.push({ at: `${key} requestBody ${media}`, message: "media type no longer accepted" });
        continue;
      }
      if (isObj(m) && isObj(nm))
        out.push(...diffSchema(m.schema, nm.schema, "input", `${key} requestBody ${media}`, ctx));
    }
    // Responses.
    const oRes = isObj(o.op.responses) ? o.op.responses : {};
    const nRes = isObj(n.op.responses) ? n.op.responses : {};
    for (const [status, r] of Object.entries(oRes)) {
      const nr = nRes[status];
      if (nr === undefined) {
        if (/^2\d\d$|^2XX$|^default$/i.test(status))
          out.push({ at: `${key} response ${status}`, message: "response was removed" });
        continue;
      }
      const oc = content(r, oldResolve);
      const nc = content(nr, newResolve);
      for (const [media, m] of Object.entries(oc)) {
        const nm = nc[media];
        if (nm === undefined) {
          out.push({
            at: `${key} response ${status} ${media}`,
            message: "media type is no longer returned",
          });
          continue;
        }
        if (isObj(m) && isObj(nm))
          out.push(
            ...diffSchema(m.schema, nm.schema, "output", `${key} response ${status} ${media}`, ctx),
          );
      }
    }
  }
  return out;
}

/** `/users/{id}` → regex for literal mentions like "/users/42" or `/users/${id}`. */
function pathPattern(path: string): RegExp {
  const parts = path.split(/\{[^}]+\}/).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`(?<![\\w/])${parts.join("[^/\\s\"'`]+")}(?![\\w/{])`);
}

/**
 * Consumer validation: paths of the old contract that a consumer's source still mentions but
 * the new contract no longer has.
 */
export function referencedRemovedPaths(
  oldDoc: unknown,
  newDoc: unknown,
  sources: readonly string[],
): string[] {
  if (!isObj(oldDoc) || !isObj(newDoc)) return [];
  const newPaths = new Set(Object.keys(isObj(newDoc.paths) ? newDoc.paths : {}).map(normalizePath));
  const removed = Object.keys(isObj(oldDoc.paths) ? oldDoc.paths : {}).filter(
    (p) => !newPaths.has(normalizePath(p)) && p !== "/",
  );
  return removed.filter((p) => {
    const re = pathPattern(p);
    return sources.some((text) => re.test(text));
  });
}
