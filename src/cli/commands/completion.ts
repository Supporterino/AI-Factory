import { basename } from "node:path";
import { UsageError } from "../../errors.ts";
import { type Command, type CommandOptions, parseCommandArgs } from "../command.ts";
import { completeWords } from "../completion/engine.ts";
import {
  completionScript,
  installCompletion,
  isShell,
  SHELLS,
  type Shell,
} from "../completion/scripts.ts";
import { ExitCode } from "../exit-codes.ts";

const OPTIONS = {
  install: { type: "boolean", default: false, description: "Add the script to your shell rc" },
  rc: { type: "string", complete: "file", description: "With --install: the rc file to edit" },
} satisfies CommandOptions;

const HELP = `Usage: ai-factory completion [<bash|zsh|fish>] [--install] [--rc <file>]

Prints a shell completion script. It completes command names, every optional flag and the
values they take: change ids, task ids, repos, agents, models, shells, files and bench
levels/cases.

  <shell>       bash, zsh or fish
  --install     Add a marked, idempotent block to the shell rc file instead of printing
  --rc <file>   With --install: edit this file instead of ~/.bashrc, ~/.zshrc or
                ~/.config/fish/config.fish

Without a shell, --install detects it from $SHELL. Reload the shell afterwards:

  ai-factory completion zsh --install
  ai-factory completion bash            # print and source it yourself`;

function shellFrom(value: string | undefined, fallback: boolean): Shell {
  if (value !== undefined) {
    if (!isShell(value))
      throw new UsageError(`completion: unknown shell "${value}" (expected ${SHELLS.join(", ")})`);
    return value;
  }
  if (!fallback) throw new UsageError(`completion: expected a shell (${SHELLS.join(", ")})`);
  const detected = basename(process.env.SHELL ?? "");
  if (!isShell(detected))
    throw new UsageError(
      `completion: cannot detect a supported shell from $SHELL; pass ${SHELLS.join(", ")}`,
    );
  return detected;
}

export const completionCommand: Command = {
  name: "completion",
  summary: "Print or install shell completion for bash, zsh and fish",
  help: HELP,
  options: OPTIONS,
  positionals: [{ name: "shell", optional: true, complete: "shell" }],
  async run(args, io) {
    const { values, positionals } = parseCommandArgs("completion", args, OPTIONS, true);
    if (positionals.length > 1) throw new UsageError("completion: expected at most one <shell>");
    if (values.rc !== undefined && !values.install)
      throw new UsageError("completion: --rc requires --install");
    const shell = shellFrom(positionals[0], values.install);
    if (!values.install) {
      io.out(completionScript(shell));
      return ExitCode.Ok;
    }
    const result = installCompletion(shell, io.cwd, values.rc);
    io.out(
      result.changed
        ? `installed ai-factory completion in ${result.path}`
        : `ai-factory completion is already installed in ${result.path}`,
    );
    return ExitCode.Ok;
  },
};

/** The hidden endpoint the generated scripts call. Never writes and never throws. */
export const completeCommand: Command = {
  name: "__complete",
  summary: "Internal shell completion endpoint",
  help: "Usage: ai-factory __complete <shell> <words...>",
  hidden: true,
  options: {},
  async run(args, io) {
    const words = args.slice(1);
    try {
      const result = await completeWords(words, io.cwd);
      if (result.fallback !== undefined) {
        io.out(`:${result.fallback}`);
        return ExitCode.Ok;
      }
      for (const candidate of result.candidates ?? [])
        io.out(
          candidate.description === undefined
            ? candidate.value
            : `${candidate.value}\t${candidate.description}`,
        );
    } catch {
      // Completion must never make the shell noisy or fail.
    }
    return ExitCode.Ok;
  },
};
