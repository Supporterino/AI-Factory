/**
 * Breaking-change detection between two JSON Schemas (also OpenAPI 3 schema objects).
 *
 * Direction decides what breaks:
 * - "input": data written by consumers and checked against the schema (requests, Helm
 *   values, plain JSON Schema contracts). Narrowing breaks: new required properties, removed
 *   types or enum values, tighter limits, closing additionalProperties.
 * - "output": data the provider produces for consumers (responses). Widening or removing
 *   breaks: removed or no-longer-required properties, new types or enum values.
 */

export type Direction = "input" | "output";

export interface Breaking {
  /** JSON-pointer-like location in the contract. */
  readonly at: string;
  readonly message: string;
}

type Schema = Record<string, unknown>;

export type Resolver = (ref: string) => unknown;

const isObj = (v: unknown): v is Schema => typeof v === "object" && v !== null && !Array.isArray(v);

/** Follows `$ref` chains (bounded). */
function deref(schema: unknown, resolve: Resolver): Schema | undefined {
  let current = schema;
  for (let i = 0; i < 20 && isObj(current) && typeof current.$ref === "string"; i++)
    current = resolve(current.$ref);
  return isObj(current) ? current : undefined;
}

function types(s: Schema): Set<string> | undefined {
  const t = s.type;
  const out = new Set<string>(
    typeof t === "string"
      ? [t]
      : Array.isArray(t)
        ? t.filter((x): x is string => typeof x === "string")
        : [],
  );
  if (out.size === 0) return undefined;
  if (s.nullable === true) out.add("null");
  // integer ⊂ number: treat a number field as accepting integers.
  if (out.has("number")) out.add("integer");
  return out;
}

const props = (s: Schema): Record<string, unknown> => (isObj(s.properties) ? s.properties : {});
const required = (s: Schema): Set<string> =>
  new Set(
    Array.isArray(s.required) ? s.required.filter((x): x is string => typeof x === "string") : [],
  );
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

export interface DiffContext {
  readonly oldResolve: Resolver;
  readonly newResolve: Resolver;
}

/** Compares two schemas; `seen` stops recursion through cyclic `$ref`s. */
export function diffSchema(
  oldSchema: unknown,
  newSchema: unknown,
  direction: Direction,
  at: string,
  ctx: DiffContext,
  seen = new Set<string>(),
): Breaking[] {
  const key = `${JSON.stringify(isObj(oldSchema) ? oldSchema.$ref : "")}|${JSON.stringify(isObj(newSchema) ? newSchema.$ref : "")}|${direction}`;
  if (isObj(oldSchema) && typeof oldSchema.$ref === "string") {
    if (seen.has(key)) return [];
    seen.add(key);
  }
  const o = deref(oldSchema, ctx.oldResolve);
  const n = deref(newSchema, ctx.newResolve);
  if (o === undefined || n === undefined) return [];
  const out: Breaking[] = [];
  const add = (where: string, message: string): void => {
    out.push({ at: where, message });
  };

  const ot = types(o);
  const nt = types(n);
  if (ot && nt) {
    if (direction === "input") {
      const lost = [...ot].filter((t) => !nt.has(t) && !(t === "integer" && nt.has("number")));
      if (lost.length > 0) add(at, `no longer accepts type ${lost.join(", ")}`);
    } else {
      const gained = [...nt].filter((t) => !ot.has(t) && !(t === "integer" && ot.has("number")));
      if (gained.length > 0) add(at, `may now be of type ${gained.join(", ")}`);
    }
  }
  if (typeof o.format === "string" && typeof n.format === "string" && o.format !== n.format) {
    add(at, `format changed from ${o.format} to ${n.format}`);
  }

  if (Array.isArray(o.enum) && Array.isArray(n.enum)) {
    const has = (list: unknown[], v: unknown) =>
      list.some((x) => JSON.stringify(x) === JSON.stringify(v));
    if (direction === "input") {
      const removed = o.enum.filter((v) => !has(n.enum as unknown[], v));
      if (removed.length > 0)
        add(at, `no longer accepts ${removed.map((v) => JSON.stringify(v)).join(", ")}`);
    } else {
      const added = n.enum.filter((v) => !has(o.enum as unknown[], v));
      if (added.length > 0)
        add(at, `may now return ${added.map((v) => JSON.stringify(v)).join(", ")}`);
    }
  } else if (direction === "input" && !Array.isArray(o.enum) && Array.isArray(n.enum)) {
    add(at, "now restricted to an enum");
  }

  if (direction === "input") {
    const tighter: [string, "min" | "max"][] = [
      ["minimum", "min"],
      ["exclusiveMinimum", "min"],
      ["minLength", "min"],
      ["minItems", "min"],
      ["minProperties", "min"],
      ["maximum", "max"],
      ["exclusiveMaximum", "max"],
      ["maxLength", "max"],
      ["maxItems", "max"],
      ["maxProperties", "max"],
    ];
    for (const [k, kind] of tighter) {
      const ov = num(o[k]);
      const nv = num(n[k]);
      if (nv === undefined) continue;
      if (ov === undefined || (kind === "min" ? nv > ov : nv < ov))
        add(at, `${k} tightened to ${nv}`);
    }
    if (typeof n.pattern === "string" && n.pattern !== o.pattern)
      add(at, `pattern changed to ${n.pattern}`);
    if (n.additionalProperties === false && o.additionalProperties !== false)
      add(at, "no longer accepts additional properties");
  }

  // Object properties.
  const op = props(o);
  const np = props(n);
  const oreq = required(o);
  const nreq = required(n);
  if (direction === "input") {
    for (const name of nreq) if (!oreq.has(name)) add(`${at}/${name}`, "is now required");
    if (n.additionalProperties === false) {
      for (const name of Object.keys(op))
        if (!(name in np)) add(`${at}/${name}`, "was removed and is no longer accepted");
    }
  } else {
    for (const name of Object.keys(op)) {
      if (!(name in np)) add(`${at}/${name}`, "was removed");
      else if (oreq.has(name) && !nreq.has(name))
        add(`${at}/${name}`, "is no longer guaranteed (was required)");
    }
  }
  for (const name of Object.keys(op)) {
    if (name in np)
      out.push(...diffSchema(op[name], np[name], direction, `${at}/${name}`, ctx, seen));
  }

  // Arrays and composition.
  if (o.items !== undefined && n.items !== undefined) {
    out.push(...diffSchema(o.items, n.items, direction, `${at}/items`, ctx, seen));
  }
  if (isObj(o.additionalProperties) && isObj(n.additionalProperties)) {
    out.push(
      ...diffSchema(
        o.additionalProperties,
        n.additionalProperties,
        direction,
        `${at}/additionalProperties`,
        ctx,
        seen,
      ),
    );
  }
  return out;
}

/** Resolves local refs (`#/a/b`) against a document. */
export function localResolver(doc: unknown): Resolver {
  return (ref) => {
    if (!ref.startsWith("#/")) return undefined;
    let node: unknown = doc;
    for (const raw of ref.slice(2).split("/")) {
      const part = raw.replace(/~1/g, "/").replace(/~0/g, "~");
      if (!isObj(node)) return undefined;
      node = node[part];
    }
    return node;
  };
}
