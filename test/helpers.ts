import { runCli } from "../src/cli/main.ts";
import { git } from "../src/exec.ts";
import type { AgentRuntime } from "../src/runtime/types.ts";

export interface Run {
  code: number;
  out: string;
  err: string;
}

/** Runs the CLI in-process with captured output. */
export async function cli(cwd: string, ...argv: string[]): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, { cwd, out: (t) => out.push(t), err: (t) => err.push(t) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

export async function gitOut(cwd: string, ...args: string[]): Promise<string> {
  return (await git(args, { cwd })).stdout.trim();
}

/** Runs the CLI with a scripted agent runtime. */
export async function cliWith(runtime: AgentRuntime, cwd: string, ...argv: string[]): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, {
    cwd,
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    runtime: () => runtime,
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

/** Runs the CLI with a scripted agent runtime and an injected `ask`. */
export async function cliWithAsk(
  runtime: AgentRuntime,
  cwd: string,
  ask: (question: string, initial?: string) => Promise<string | undefined>,
  ...argv: string[]
): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, {
    cwd,
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    runtime: () => runtime,
    ask,
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}
