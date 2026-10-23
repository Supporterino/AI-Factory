import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv, type AnySchema } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { parse as parseYaml } from "yaml";
import type { ContractConfig, FactoryConfig, RepoConfig } from "../config/schema.ts";
import { listFiles } from "../detect/walk.ts";
import { exec, git } from "../exec.ts";
import { compactOutput } from "../gates/compact.ts";
import { changedSince, restore, snapshot } from "../gates/guard.ts";
import { diffOpenApi, isOpenApi3, referencedRemovedPaths } from "./openapi.ts";
import { diffProto, parseProtoFiles } from "./proto.ts";
import { type Breaking, diffSchema, localResolver } from "./schema-diff.ts";

/**
 * The deterministic contract gate (§7 step 9): a breaking-change diff of every touched
 * contract between the change's base and `change/<id>`, plus consumer validation against
 * the new contract. Breaking changes fail unless the entry sets `allowBreaking`.
 */

export interface ContractResult {
  readonly key: string;
  readonly contract: ContractConfig;
  readonly breaking: readonly Breaking[];
  readonly consumerIssues: readonly string[];
  readonly notes: readonly string[];
  readonly passed: boolean;
}

export interface ContractGateInput {
  readonly root: string;
  readonly config: FactoryConfig;
  /** Change id: `change/<id>` is the head ref where a repo was branched. */
  readonly id: string;
  /** Base commit per repo (where its change branch started). */
  readonly bases: Readonly<Record<string, string>>;
  readonly gateOutputMaxLines: number;
}

export const contractKey = (c: ContractConfig): string => `${c.kind}:${c.provider}:${c.path}`;

const addFormats = addFormatsModule as unknown as (ajv: Ajv | Ajv2020) => void;

function compile(schema: unknown): { validate?: (data: unknown) => string[]; error?: string } {
  const draft07 =
    typeof (schema as { $schema?: unknown }).$schema === "string" &&
    /draft-0[4-7]/.test((schema as { $schema: string }).$schema);
  const ajv = draft07
    ? new Ajv({ strict: false, allErrors: true })
    : new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  try {
    const fn = ajv.compile(schema as AnySchema);
    return {
      validate: (data) =>
        fn(data)
          ? []
          : (fn.errors ?? []).map((e) => `${e.instancePath || "(root)"} ${e.message ?? "invalid"}`),
    };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

function parseDoc(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return parseYaml(text, { logLevel: "silent" });
  } catch {
    return undefined;
  }
}

/** Contents of `path` at `ref` in `dir`, or undefined when it does not exist there. */
async function readAt(dir: string, ref: string, path: string): Promise<string | undefined> {
  const res = await git(["show", `${ref}:${path}`], { cwd: dir });
  return res.code === 0 ? res.stdout : undefined;
}

async function filesAt(dir: string, ref: string, path: string, ext: string): Promise<string[]> {
  const res = await git(["ls-tree", "-r", "--name-only", ref, "--", path], { cwd: dir });
  if (res.code !== 0) return [];
  const out: string[] = [];
  for (const f of res.stdout.split("\n").filter((x) => x.endsWith(ext))) {
    const text = await readAt(dir, ref, f);
    if (text !== undefined) out.push(text);
  }
  return out;
}

async function headRef(dir: string, id: string): Promise<string> {
  const branch = `refs/heads/change/${id}`;
  return (await git(["rev-parse", "--verify", "--quiet", branch], { cwd: dir })).code === 0
    ? branch
    : "HEAD";
}

const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs|go|py|rs|java|kt|swift|rb|php|cs|vue|svelte|json|ya?ml)$/;

/** Text of a consumer's source files (bounded), for path-reference checks. */
function consumerSources(dir: string): string[] {
  return listFiles(dir, { maxDepth: 8, maxFiles: 5000 })
    .filter((f) => SOURCE.test(f.path) && f.size <= 256 * 1024)
    .map((f) => {
      try {
        return readFileSync(join(dir, f.path), "utf8");
      } catch {
        return "";
      }
    });
}

async function runValidate(
  command: string,
  dir: string,
  contractAbs: string,
  maxLines: number,
): Promise<string | undefined> {
  const before = await snapshot(dir);
  const res = await exec(
    ["sh", "-c", command.replaceAll("{contract}", `'${contractAbs.replaceAll("'", "'\\''")}'`)],
    {
      cwd: dir,
      env: { CI: "1", NO_COLOR: "1" },
      timeoutMs: 10 * 60_000,
    },
  );
  const modified = await changedSince(before);
  if (modified.length > 0) {
    await restore(before, modified);
    return `\`${command}\` is not check-only (modified ${modified.join(", ")}; restored)`;
  }
  if (res.code === 0) return undefined;
  return `\`${command}\` failed:\n${compactOutput(`${res.stdout}\n${res.stderr}`, maxLines)}`;
}

function repoOf(config: FactoryConfig, name: string): RepoConfig {
  const repo = config.repos.find((r) => r.name === name);
  if (repo === undefined) throw new Error(`unknown repo ${name}`);
  return repo;
}

export async function checkContract(
  input: ContractGateInput,
  contract: ContractConfig,
): Promise<ContractResult> {
  const provider = repoOf(input.config, contract.provider);
  const providerDir = join(input.root, provider.path);
  const head = await headRef(providerDir, input.id);
  const base = input.bases[provider.name] ?? head;
  const breaking: Breaking[] = [];
  const consumerIssues: string[] = [];
  const notes: string[] = [];

  if (contract.kind === "proto") {
    const oldFiles = await filesAt(providerDir, base, contract.path, ".proto");
    const newFiles = await filesAt(providerDir, head, contract.path, ".proto");
    if (newFiles.length === 0)
      consumerIssues.push(`no .proto files under ${contract.path} on ${head}`);
    else breaking.push(...diffProto(parseProtoFiles(oldFiles), parseProtoFiles(newFiles)));
  } else {
    const oldDoc = parseDoc(await readAt(providerDir, base, contract.path));
    const newText = await readAt(providerDir, head, contract.path);
    const newDoc = parseDoc(newText);
    if (newText === undefined) consumerIssues.push(`${contract.path} does not exist on ${head}`);
    else if (newDoc === undefined) consumerIssues.push(`${contract.path} does not parse`);
    else if (contract.kind === "openapi") {
      if (!isOpenApi3(newDoc)) notes.push("not an OpenAPI 3 document; the diff was skipped");
      else if (oldDoc === undefined) notes.push("new contract; nothing to compare");
      else {
        breaking.push(...diffOpenApi(oldDoc, newDoc));
        for (const consumer of contract.consumers) {
          const dir = join(input.root, repoOf(input.config, consumer).path);
          for (const path of referencedRemovedPaths(oldDoc, newDoc, consumerSources(dir))) {
            consumerIssues.push(
              `${consumer} still references ${path}, which the new contract no longer has`,
            );
          }
        }
      }
    } else {
      // json-schema and helm-values: data written by consumers is validated against it.
      const compiled = compile(newDoc);
      if (compiled.error) consumerIssues.push(`the new schema does not compile: ${compiled.error}`);
      if (oldDoc !== undefined) {
        breaking.push(
          ...diffSchema(oldDoc, newDoc, "input", "", {
            oldResolve: localResolver(oldDoc),
            newResolve: localResolver(newDoc),
          }),
        );
      }
      if (contract.kind === "helm-values" && compiled.validate) {
        const chartDir = contract.path.includes("/")
          ? contract.path.slice(0, contract.path.lastIndexOf("/"))
          : ".";
        const files = await git(["ls-tree", "-r", "--name-only", head, "--", chartDir], {
          cwd: providerDir,
        });
        const valueFiles = files.stdout
          .split("\n")
          .filter((f) => f === `${chartDir}/values.yaml` || /\/ci\/[^/]+-values\.ya?ml$/.test(f));
        for (const file of valueFiles) {
          const data = parseDoc(await readAt(providerDir, head, file));
          for (const err of compiled.validate(data ?? {}))
            consumerIssues.push(`${provider.name}:${file} ${err}`);
        }
      }
    }
  }

  for (const [consumer, command] of Object.entries(contract.validate ?? {})) {
    const dir = join(input.root, repoOf(input.config, consumer).path);
    const issue = await runValidate(
      command,
      dir,
      join(providerDir, contract.path),
      input.gateOutputMaxLines,
    );
    if (issue) consumerIssues.push(`${consumer}: ${issue}`);
  }

  const blocking = contract.allowBreaking ? [] : breaking;
  if (contract.allowBreaking && breaking.length > 0)
    notes.push(`${breaking.length} breaking change(s) accepted (allowBreaking)`);
  return {
    key: contractKey(contract),
    contract,
    breaking,
    consumerIssues,
    notes,
    passed: blocking.length === 0 && consumerIssues.length === 0,
  };
}

export function summarize(result: ContractResult): string {
  return [
    `${result.passed ? "✓" : "✗"} ${result.key}`,
    ...result.breaking.map((b) => `  breaking: ${b.at}: ${b.message}`),
    ...result.consumerIssues.map((i) => `  consumer: ${i}`),
    ...result.notes.map((n) => `  note: ${n}`),
  ].join("\n");
}

/** Contracts a change touches: its provider or one of its consumers has tasks. */
export function touchedContracts(
  config: FactoryConfig,
  repos: ReadonlySet<string>,
): ContractConfig[] {
  return config.contracts.filter(
    (c) => repos.has(c.provider) || c.consumers.some((x) => repos.has(x)),
  );
}
