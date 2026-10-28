import { resolve } from "node:path";
import { findWorkspaceRoot } from "../../config/load.ts";
import type { Command, CommandOption, CompletionValue } from "../command.ts";
import { completionCommands } from "./registry.ts";
import { type ValueContext, valueCandidates } from "./values.ts";

export interface Candidate {
  readonly value: string;
  readonly description?: string;
}

export interface CompletionResult {
  readonly candidates?: readonly Candidate[];
  /** Let the shell complete a path instead of using candidates. */
  readonly fallback?: "files" | "dirs";
}

interface GlobalFlag {
  readonly value: string;
  readonly description: string;
  readonly complete?: CompletionValue;
}

const GLOBAL_FLAGS: readonly GlobalFlag[] = [
  { value: "-C", description: "Run as if started in <dir>", complete: "dir" },
  { value: "-h", description: "Show help" },
  { value: "--help", description: "Show help (also after a command)" },
  { value: "-V", description: "Print the factory version" },
  { value: "--version", description: "Print the factory version" },
];

interface Walk {
  readonly positionals: string[];
  readonly used: Set<string>;
  /** A value-taking option immediately before the current word. */
  readonly pending?: string;
}

/** Walks completed tokens, separating positionals from flags and their values. */
function walk(command: Command, tokens: readonly string[]): Walk {
  const positionals: string[] = [];
  const used = new Set<string>();
  let pending: string | undefined;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] ?? "";
    if (pending !== undefined) {
      pending = undefined;
      continue;
    }
    if (token === "--") {
      positionals.push(...tokens.slice(i + 1));
      break;
    }
    if (token.startsWith("--")) {
      const [name = "", inline] = token.slice(2).split("=", 2);
      const option = command.options?.[name];
      if (option !== undefined) {
        used.add(name);
        if (option.type !== "boolean" && inline === undefined) pending = name;
      }
      continue;
    }
    if (token.startsWith("-") && token.length > 1) continue;
    positionals.push(token);
  }
  return { positionals, used, ...(pending === undefined ? {} : { pending }) };
}

const byPrefix = (values: readonly Candidate[], prefix: string): Candidate[] =>
  values.filter((candidate) => candidate.value.startsWith(prefix));

const expandList = (choices: readonly string[], prefix: string): Candidate[] => {
  const comma = prefix.lastIndexOf(",");
  const head = comma >= 0 ? prefix.slice(0, comma + 1) : "";
  const tail = comma >= 0 ? prefix.slice(comma + 1) : prefix;
  const selected = head
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
  return choices
    .filter((choice) => choice.startsWith(tail) && !selected.includes(choice))
    .map((choice) => ({ value: `${head}${choice}` }));
};

const rootCandidates = (current: string): CompletionResult => {
  const flags: Candidate[] = GLOBAL_FLAGS.map((flag) => ({
    value: flag.value,
    description: flag.description,
  }));
  if (current.startsWith("-")) return { candidates: byPrefix(flags, current) };
  const commands: Candidate[] = completionCommands()
    .filter((command) => command.hidden !== true)
    .map((command) => ({ value: command.name, description: command.summary }));
  return { candidates: byPrefix([...commands, ...flags], current) };
};

const flagCandidates = (command: Command, current: string, used: Set<string>): Candidate[] => {
  const candidates: Candidate[] = [];
  for (const [name, option] of Object.entries(command.options ?? {})) {
    if (used.has(name) && (option.type === "boolean" || option.multiple !== true)) continue;
    candidates.push({
      value: `--${name}`,
      ...(option.description === undefined ? {} : { description: option.description }),
    });
  }
  if (!used.has("help"))
    candidates.push({ value: "--help", description: "Show help for this command" });
  return byPrefix(candidates, current);
};

const optionValue = (
  option: CommandOption,
  prefix: string,
  context: ValueContext,
): CompletionResult => {
  if (option.choices !== undefined) return { candidates: expandList(option.choices, prefix) };
  if (option.complete === undefined) return { candidates: [] };
  if (option.complete === "file") return { fallback: "files" };
  if (option.complete === "dir") return { fallback: "dirs" };
  return {
    candidates: byPrefix(
      valueCandidates(option.complete, context).map((value) => ({ value })),
      prefix,
    ),
  };
};

const positionalValue = (
  command: Command,
  context: ValueContext,
  index: number,
  prefix: string,
): CompletionResult | undefined => {
  const spec = command.positionals?.[index];
  if (spec?.complete === "file") return { fallback: "files" };
  if (spec?.complete === "dir") return { fallback: "dirs" };
  if (spec?.complete === undefined) return undefined;
  return {
    candidates: byPrefix(
      valueCandidates(spec.complete, context).map((value) => ({ value })),
      prefix,
    ),
  };
};

async function commandCandidates(
  command: Command,
  after: readonly string[],
  current: string,
  cwd: string,
): Promise<CompletionResult> {
  let args = after;
  let subcommand: string | undefined;
  if (
    command.subcommands !== undefined &&
    args[0] !== undefined &&
    command.subcommands.includes(args[0])
  ) {
    subcommand = args[0];
    args = args.slice(1);
  }
  const state = walk(command, args);
  const rootCache = (): Promise<string | undefined> =>
    findWorkspaceRoot(cwd).catch(() => undefined);
  const context = async (): Promise<ValueContext> => {
    const root = await rootCache();
    return {
      ...(root === undefined ? {} : { root }),
      positionals: state.positionals,
    };
  };

  // The word after a value-taking option is always that option's value, even when it
  // begins with a dash.
  if (state.pending !== undefined) {
    const option = command.options?.[state.pending];
    if (option !== undefined) return optionValue(option, current, await context());
  }

  if (current.startsWith("--") && current.includes("=")) {
    const equals = current.indexOf("=");
    const name = current.slice(2, equals);
    const prefix = current.slice(equals + 1);
    const option = command.options?.[name];
    if (option !== undefined) return optionValue(option, prefix, await context());
  }

  if (current.startsWith("--")) return { candidates: flagCandidates(command, current, state.used) };
  if (current.startsWith("-") && current.length > 1)
    return { candidates: byPrefix([{ value: "-h", description: "Show help" }], current) };

  if (
    command.subcommands !== undefined &&
    subcommand === undefined &&
    state.positionals.length === 0
  ) {
    return {
      candidates: byPrefix(
        command.subcommands.map((name) => ({ value: name })),
        current,
      ),
    };
  }
  return (
    positionalValue(command, await context(), state.positionals.length, current) ?? {
      candidates: [],
    }
  );
}

async function splitGlobals(
  words: readonly string[],
  cwd: string,
): Promise<{ rest: readonly string[]; cwd: string; dirPending: boolean }> {
  let i = 0;
  let dir = cwd;
  while (i < words.length) {
    const word = words[i];
    if (word === "-C") {
      if (i + 1 >= words.length) return { rest: [], cwd: dir, dirPending: true };
      dir = resolve(dir, words[i + 1] ?? "");
      i += 2;
      continue;
    }
    if (word === "-h" || word === "--help" || word === "-V" || word === "--version") {
      i += 1;
      continue;
    }
    break;
  }
  return { rest: words.slice(i), cwd: dir, dirPending: false };
}

/** Completes a command line; `words` excludes the program name and includes the current word. */
export async function completeWords(
  words: readonly string[],
  cwd: string,
): Promise<CompletionResult> {
  const current = words.at(-1) ?? "";
  const before = words.slice(0, -1);
  const globals = await splitGlobals(before, cwd);
  if (globals.dirPending) return { fallback: "dirs" };

  const name = globals.rest[0];
  if (name === undefined) return rootCandidates(current);
  const command = completionCommands().find((candidate) => candidate.name === name);
  if (command === undefined) {
    return name.startsWith("-") ? rootCandidates(current) : { candidates: [] };
  }
  return commandCandidates(command, globals.rest.slice(1), current, globals.cwd);
}
