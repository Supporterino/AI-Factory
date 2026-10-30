#!/usr/bin/env node
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { FactoryError } from "../errors.ts";
import { FACTORY_VERSION } from "../version.ts";
import type { Command, Io } from "./command.ts";
import { adoptCommand } from "./commands/adopt.ts";
import { artifactsCommand } from "./commands/artifacts.ts";
import { benchCommand } from "./commands/bench.ts";
import { completeCommand, completionCommand } from "./commands/completion.ts";
import { detectCommand } from "./commands/detect.ts";
import { doctorCommand } from "./commands/doctor.ts";
import { gateCommand } from "./commands/gate.ts";
import { graphCommand } from "./commands/graph.ts";
import { initCommand } from "./commands/init.ts";
import { landCommand } from "./commands/land.ts";
import { approveCommand, resumeCommand, runCommand } from "./commands/pipeline-commands.ts";
import { quickCommand } from "./commands/quick.ts";
import { refineCommand } from "./commands/refine.ts";
import { repointCommand } from "./commands/repoint.ts";
import { abortCommand, retryCommand, statusCommand } from "./commands/state-commands.ts";
import { rollbackCommand, updateCommand } from "./commands/update.ts";
import { usageCommand } from "./commands/usage.ts";
import { setCompletionCommands } from "./completion/registry.ts";
import { ExitCode } from "./exit-codes.ts";

export const COMMANDS: readonly Command[] = [
  initCommand,
  adoptCommand,
  updateCommand,
  rollbackCommand,
  doctorCommand,
  completionCommand,
  detectCommand,
  refineCommand,
  runCommand,
  quickCommand,
  approveCommand,
  resumeCommand,
  statusCommand,
  usageCommand,
  gateCommand,
  graphCommand,
  retryCommand,
  abortCommand,
  repointCommand,
  landCommand,
  artifactsCommand,
  benchCommand((argv, io) => runCli(argv, io)),
  completeCommand,
];

setCompletionCommands(COMMANDS);

function usage(): string {
  const visible = COMMANDS.filter((command) => command.hidden !== true);
  const width = Math.max(...visible.map((c) => c.name.length));
  return [
    "Usage: ai-factory [-C <dir>] <command> [options]",
    "",
    "Commands:",
    ...visible.map((c) => `  ${c.name.padEnd(width)}  ${c.summary}`),
    "",
    "Global options:",
    "  -C <dir>        Run as if started in <dir>",
    "  -h, --help      Show help (also after a command)",
    "  -V, --version   Print the factory version",
    "",
    "Exit codes: 0 ok, 1 failure, 2 usage, 3 config invalid, 4 precondition, 5 gate failed,",
    "6 paused, 10 drift.",
  ].join("\n");
}

function report(err: unknown, io: Io): ExitCode {
  if (err instanceof FactoryError) {
    io.err(`error: ${err.message}`);
    for (const line of err.details) io.err(`  ${line}`);
    return err.exitCode;
  }
  io.err(`internal error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  return ExitCode.Failure;
}

export async function askYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
  } finally {
    rl.close();
  }
}

export async function askText(question: string, initial?: string): Promise<string | undefined> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const suffix = initial === undefined || initial === "" ? "" : ` (${initial})`;
    const answer = (await rl.question(`${question}${suffix}: `)).trim();
    return answer === "" ? initial : answer;
  } finally {
    rl.close();
  }
}

/** Runs the CLI against injected I/O; returns the exit code. */
export async function runCli(argv: readonly string[], io: Io): Promise<ExitCode> {
  let cwd = io.cwd;
  let i = 0;
  for (; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-C") {
      const dir = argv[++i];
      if (dir === undefined) {
        io.err("error: -C needs a directory");
        return ExitCode.Usage;
      }
      cwd = resolve(cwd, dir);
    } else if (arg === "-V" || arg === "--version") {
      io.out(FACTORY_VERSION);
      return ExitCode.Ok;
    } else if (arg === "-h" || arg === "--help") {
      io.out(usage());
      return ExitCode.Ok;
    } else {
      break;
    }
  }

  const name = argv[i];
  if (name === undefined) {
    io.err(usage());
    return ExitCode.Usage;
  }
  const command = COMMANDS.find((c) => c.name === name);
  if (command === undefined) {
    io.err(`error: unknown command "${name}"\n\n${usage()}`);
    return ExitCode.Usage;
  }
  const rest = argv.slice(i + 1);
  // Hidden commands own their arguments: `__complete` must see a literal `--help` as a word.
  if (command.hidden !== true && (rest.includes("-h") || rest.includes("--help"))) {
    io.out(command.help);
    return ExitCode.Ok;
  }
  try {
    return await command.run(rest, { ...io, cwd });
  } catch (err) {
    return report(err, io);
  }
}
