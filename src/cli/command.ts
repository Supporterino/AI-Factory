import { type ParseArgsConfig, parseArgs } from "node:util";
import { UsageError } from "../errors.ts";
import type { ExitCode } from "./exit-codes.ts";

/** Where a command writes and where it runs. Injected so tests can capture output. */
export interface Io {
  readonly cwd: string;
  out(text: string): void;
  err(text: string): void;
}

export interface Command {
  readonly name: string;
  readonly summary: string;
  /** Full help text shown by `ai-factory <name> --help`. */
  readonly help: string;
  run(args: readonly string[], io: Io): Promise<ExitCode>;
}

type Options = NonNullable<ParseArgsConfig["options"]>;

/** `node:util` parseArgs in strict mode, with its errors turned into usage errors. */
export function parseCommandArgs<const O extends Options>(
  command: string,
  args: readonly string[],
  options: O,
  allowPositionals = false,
) {
  try {
    return parseArgs({ args: [...args], options, strict: true, allowPositionals });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new UsageError(`${command}: ${message}`, [`see \`ai-factory ${command} --help\``]);
  }
}
