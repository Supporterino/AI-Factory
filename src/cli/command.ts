import { type ParseArgsConfig, parseArgs } from "node:util";
import type { FactoryConfig } from "../config/schema.ts";
import { UsageError } from "../errors.ts";
import type { AgentRuntime } from "../runtime/types.ts";
import type { ExitCode } from "./exit-codes.ts";

export type RuntimeFactory = (
  root: string,
  config: FactoryConfig,
  changeId: string,
) => AgentRuntime;

/** Where a command writes and where it runs. Injected so tests can capture output. */
export interface Io {
  readonly cwd: string;
  out(text: string): void;
  err(text: string): void;
  /** stdout is a terminal: in-place screens and colors are safe. */
  readonly tty?: boolean;
  /** Stops a watch loop (tests pass a signal; the CLI relies on Ctrl-C terminating). */
  readonly signal?: AbortSignal;
  /** Agent runtime; defaults to a private opencode server. Tests inject a scripted one. */
  readonly runtime?: RuntimeFactory;
  /** Asks the user a yes/no question; undefined when nobody can answer (no TTY). */
  readonly confirm?: (question: string) => Promise<boolean>;
  /** Asks for free text; undefined when nobody can answer (no TTY). */
  readonly ask?: (question: string, initial?: string) => Promise<string | undefined>;
}

/** What a flag or positional value can be completed from. */
export type CompletionValue =
  | "change"
  | "ledger"
  | "task"
  | "repo"
  | "agent"
  | "model"
  | "shell"
  | "level"
  | "file"
  | "dir";

type ParseOption = NonNullable<ParseArgsConfig["options"]>[string];

/** A parse-args option plus the description and value completion used by `completion`. */
export interface CommandOption extends ParseOption {
  readonly description?: string;
  readonly complete?: CompletionValue;
  readonly choices?: readonly string[];
}

export type CommandOptions = Record<string, CommandOption>;

export interface CommandPositional {
  readonly name: string;
  readonly optional?: boolean;
  readonly variadic?: boolean;
  readonly complete?: CompletionValue;
}

export interface Command {
  readonly name: string;
  readonly summary: string;
  /** Full help text shown by `ai-factory <name> --help`. */
  readonly help: string;
  /** The same options passed to `parseCommandArgs`; completion reads them. */
  readonly options?: CommandOptions;
  readonly positionals?: readonly CommandPositional[];
  /** Names of subcommands accepted after the command word (e.g. `bench ponytail`). */
  readonly subcommands?: readonly string[];
  /** Hidden commands still run, but are not listed or completed. */
  readonly hidden?: boolean;
  run(args: readonly string[], io: Io): Promise<ExitCode>;
}

/** `node:util` parseArgs in strict mode, with its errors turned into usage errors. */
export function parseCommandArgs<const O extends CommandOptions>(
  command: string,
  args: readonly string[],
  options: O,
  allowPositionals = false,
) {
  try {
    // CommandOption extends the parse-args descriptor; parseArgs ignores the extra keys.
    return parseArgs({ args: [...args], options, strict: true, allowPositionals });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new UsageError(`${command}: ${message}`, [`see \`ai-factory ${command} --help\``]);
  }
}
