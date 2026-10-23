import { spawn } from "node:child_process";
import { ExecError } from "./errors.ts";

/**
 * The single place where the factory starts child processes. Node APIs only, so the
 * bundled CLI also runs under `npx`.
 */

/** Quiet, non-interactive env for every OpenSpec call (docs/research/tooling.md §2). */
export const OPENSPEC_ENV: Readonly<Record<string, string>> = {
  OPENSPEC_TELEMETRY: "0",
  DO_NOT_TRACK: "1",
  OPENSPEC_NO_UPDATE_CHECK: "1",
  OPENSPEC_NO_COMPLETIONS: "1",
  OPEN_SPEC_INTERACTIVE: "0",
  NO_COLOR: "1",
};

/** Graphify must never refresh files in $HOME or call an LLM (tooling.md §3, gap G9). */
export const GRAPHIFY_ENV: Readonly<Record<string, string>> = {
  GRAPHIFY_NO_AUTO_REFRESH: "1",
  GRAPHIFY_BACKEND: "none",
};

/** Git must never prompt, and output must not be localised. */
export const GIT_ENV: Readonly<Record<string, string>> = {
  GIT_TERMINAL_PROMPT: "0",
  LC_ALL: "C",
};

export interface ExecOptions {
  readonly cwd: string;
  /** Merged over `process.env`. */
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly input?: string;
}

export interface ExecResult {
  readonly command: readonly string[];
  /** `null` when the process was killed by a signal (including the timeout). */
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly durationMs: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;

/** Runs a command without a shell. Never throws for a non-zero exit; check `code`. */
export function exec(command: readonly string[], options: ExecOptions): Promise<ExecResult> {
  const [file, ...args] = command;
  if (file === undefined) {
    return Promise.reject(new Error("exec: empty command"));
  }
  const started = performance.now();
  return new Promise((resolve) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    const finish = (code: number | null, extraErr = ""): void => {
      clearTimeout(timer);
      resolve({
        command,
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8") + extraErr,
        timedOut,
        durationMs: Math.round(performance.now() - started),
      });
    };
    // A missing binary surfaces as an 'error' event (ENOENT) instead of an exit code.
    child.on("error", (err) => finish(127, err.message));
    child.on("close", (code) => finish(code));
    child.stdin.end(options.input ?? "");
  });
}

/** Like `exec`, but throws `ExecError` unless the command exits 0. Returns trimmed stdout. */
export async function execOk(command: readonly string[], options: ExecOptions): Promise<string> {
  const result = await exec(command, options);
  if (result.code !== 0) {
    const reason = result.timedOut ? "timed out" : `exited with ${result.code}`;
    throw new ExecError(`\`${command.join(" ")}\` ${reason}`, result);
  }
  return result.stdout.trim();
}

/** Runs git with a non-interactive env. */
export function git(args: readonly string[], options: ExecOptions): Promise<ExecResult> {
  return exec(["git", ...args], { ...options, env: { ...GIT_ENV, ...options.env } });
}

export function gitOk(args: readonly string[], options: ExecOptions): Promise<string> {
  return execOk(["git", ...args], { ...options, env: { ...GIT_ENV, ...options.env } });
}
