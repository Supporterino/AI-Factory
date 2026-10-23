import type { Breaking } from "./schema-diff.ts";

/**
 * A small protobuf (proto2/proto3) model for breaking-change checks: messages with numbered
 * fields (including oneofs, maps and nested messages), enums and services. Mirrors the
 * wire+JSON rules of `buf breaking` that matter most: removed or renumbered fields and enum
 * values that are not reserved, changed field types or labels, removed messages, services
 * and RPCs, and changed RPC signatures.
 */

interface Field {
  readonly name: string;
  readonly type: string;
  readonly label: string;
}

interface Message {
  readonly fields: Map<number, Field>;
  readonly reservedNumbers: Set<number>;
  readonly reservedNames: Set<string>;
}

interface Enum {
  readonly values: Map<number, string>;
  readonly reserved: Set<number>;
}

interface Rpc {
  readonly request: string;
  readonly response: string;
}

export interface ProtoModel {
  readonly messages: Map<string, Message>;
  readonly enums: Map<string, Enum>;
  readonly services: Map<string, Map<string, Rpc>>;
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

function tokens(text: string): string[] {
  return (
    stripComments(text).match(/"(?:[^"\\]|\\.)*"|[A-Za-z_][\w.]*|\d+|[{}()[\]<>;=,]|\S/g) ?? []
  );
}

function reservedRanges(
  toks: string[],
  start: number,
): { numbers: number[]; names: string[]; end: number } {
  const numbers: number[] = [];
  const names: string[] = [];
  let i = start;
  while (i < toks.length && toks[i] !== ";") {
    const t = toks[i] ?? "";
    if (/^\d+$/.test(t)) {
      const from = Number(t);
      if (toks[i + 1] === "to") {
        const toTok = toks[i + 2] ?? "";
        const to = toTok === "max" ? from + 1000 : Number(toTok);
        for (let n = from; n <= Math.min(to, from + 100_000); n++) numbers.push(n);
        i += 3;
        continue;
      }
      numbers.push(from);
    } else if (t.startsWith('"')) names.push(t.slice(1, -1));
    i++;
  }
  return { numbers, names, end: i };
}

export function parseProto(
  text: string,
  model: ProtoModel = { messages: new Map(), enums: new Map(), services: new Map() },
): ProtoModel {
  const toks = tokens(text);
  let pkg = "";
  const scope: { kind: "message" | "enum" | "service" | "oneof" | "other"; name: string }[] = [];
  const qualified = (name: string): string =>
    [pkg, ...scope.filter((s) => s.kind === "message").map((s) => s.name), name]
      .filter(Boolean)
      .join(".");
  const currentMessage = (): Message | undefined => {
    const names = scope.filter((s) => s.kind === "message").map((s) => s.name);
    return names.length === 0
      ? undefined
      : model.messages.get([pkg, ...names].filter(Boolean).join("."));
  };

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i] ?? "";
    const top = scope.at(-1);
    if (t === "package") {
      pkg = toks[i + 1] ?? "";
      i += 2;
    } else if (t === "message" && toks[i + 2] === "{") {
      const name = toks[i + 1] ?? "";
      model.messages.set(qualified(name), {
        fields: new Map(),
        reservedNumbers: new Set(),
        reservedNames: new Set(),
      });
      scope.push({ kind: "message", name });
      i += 2;
    } else if (t === "enum" && toks[i + 2] === "{") {
      const name = toks[i + 1] ?? "";
      model.enums.set(qualified(name), { values: new Map(), reserved: new Set() });
      scope.push({ kind: "enum", name: qualified(name) });
      i += 2;
    } else if (t === "service" && toks[i + 2] === "{") {
      const name = [pkg, toks[i + 1]].filter(Boolean).join(".");
      model.services.set(name, new Map());
      scope.push({ kind: "service", name });
      i += 2;
    } else if (t === "oneof" && toks[i + 2] === "{") {
      scope.push({ kind: "oneof", name: toks[i + 1] ?? "" });
      i += 2;
    } else if (t === "{") {
      scope.push({ kind: "other", name: "" });
    } else if (t === "}") {
      scope.pop();
    } else if (t === "reserved") {
      const r = reservedRanges(toks, i + 1);
      if (top?.kind === "enum") {
        for (const n of r.numbers) model.enums.get(top.name)?.reserved.add(n);
      } else {
        const msg = currentMessage();
        for (const n of r.numbers) msg?.reservedNumbers.add(n);
        for (const n of r.names) msg?.reservedNames.add(n);
      }
      i = r.end;
    } else if (
      top?.kind === "enum" &&
      /^[A-Za-z_]\w*$/.test(t) &&
      toks[i + 1] === "=" &&
      t !== "option"
    ) {
      const value = Number(toks[i + 2]);
      if (Number.isFinite(value)) model.enums.get(top.name)?.values.set(value, t);
      i += 2;
    } else if (top?.kind === "service" && t === "rpc") {
      // rpc Name ( [stream] Req ) returns ( [stream] Res )
      const name = toks[i + 1] ?? "";
      let j = i + 3;
      let req = "";
      if (toks[j] === "stream") {
        req = "stream ";
        j++;
      }
      req += toks[j] ?? "";
      j = toks.indexOf("returns", j) + 2;
      let res = "";
      if (toks[j] === "stream") {
        res = "stream ";
        j++;
      }
      res += toks[j] ?? "";
      model.services.get(top.name)?.set(name, { request: req, response: res });
      i = j;
    } else if (
      (top?.kind === "message" || top?.kind === "oneof") &&
      !["option", "extensions", "extend"].includes(t)
    ) {
      // [label] type name = number ;   |   map < k , v > name = number ;
      let j = i;
      let label = top.kind === "oneof" ? "oneof" : "singular";
      if (["optional", "repeated", "required"].includes(t)) {
        label = t;
        j++;
      }
      let type = toks[j] ?? "";
      if (type === "map" && toks[j + 1] === "<") {
        type = `map<${toks[j + 2]},${toks[j + 4]}>`;
        j += 5;
      }
      const name = toks[j + 1] ?? "";
      if (toks[j + 2] === "=" && /^\d+$/.test(toks[j + 3] ?? "")) {
        currentMessage()?.fields.set(Number(toks[j + 3]), { name, type, label });
        while (j < toks.length && toks[j] !== ";") j++;
        i = j;
      }
    }
  }
  return model;
}

export function parseProtoFiles(files: readonly string[]): ProtoModel {
  const model: ProtoModel = { messages: new Map(), enums: new Map(), services: new Map() };
  for (const text of files) parseProto(text, model);
  return model;
}

export function diffProto(oldModel: ProtoModel, newModel: ProtoModel): Breaking[] {
  const out: Breaking[] = [];
  for (const [name, o] of oldModel.messages) {
    const n = newModel.messages.get(name);
    if (n === undefined) {
      out.push({ at: `message ${name}`, message: "message was removed" });
      continue;
    }
    for (const [num, f] of o.fields) {
      const nf = n.fields.get(num);
      if (nf === undefined) {
        if (!n.reservedNumbers.has(num))
          out.push({
            at: `${name}.${f.name} = ${num}`,
            message: "field was removed without reserving its number",
          });
        continue;
      }
      if (nf.type !== f.type)
        out.push({
          at: `${name}.${f.name} = ${num}`,
          message: `type changed from ${f.type} to ${nf.type}`,
        });
      if (nf.label !== f.label && !(f.label === "singular" && nf.label === "optional")) {
        out.push({
          at: `${name}.${f.name} = ${num}`,
          message: `label changed from ${f.label} to ${nf.label}`,
        });
      }
      if (nf.name !== f.name)
        out.push({
          at: `${name} field ${num}`,
          message: `renamed from ${f.name} to ${nf.name} (breaks JSON)`,
        });
    }
  }
  for (const [name, o] of oldModel.enums) {
    const n = newModel.enums.get(name);
    if (n === undefined) {
      out.push({ at: `enum ${name}`, message: "enum was removed" });
      continue;
    }
    for (const [num, value] of o.values) {
      if (!n.values.has(num) && !n.reserved.has(num))
        out.push({
          at: `${name}.${value} = ${num}`,
          message: "enum value was removed without reserving its number",
        });
    }
  }
  for (const [name, rpcs] of oldModel.services) {
    const n = newModel.services.get(name);
    if (n === undefined) {
      out.push({ at: `service ${name}`, message: "service was removed" });
      continue;
    }
    for (const [rpc, sig] of rpcs) {
      const nsig = n.get(rpc);
      if (nsig === undefined) out.push({ at: `${name}/${rpc}`, message: "rpc was removed" });
      else if (nsig.request !== sig.request || nsig.response !== sig.response) {
        out.push({
          at: `${name}/${rpc}`,
          message: `signature changed from (${sig.request}) → (${sig.response}) to (${nsig.request}) → (${nsig.response})`,
        });
      }
    }
  }
  return out;
}
