import { ExitCode } from "./cli/exit-codes.ts";

/** Base class for every error the CLI expects and reports without a stack trace. */
export class FactoryError extends Error {
  readonly exitCode: ExitCode;
  /** Extra lines shown under the message, e.g. per-field validation issues. */
  readonly details: readonly string[];

  constructor(message: string, exitCode: ExitCode, details: readonly string[] = []) {
    super(message);
    this.name = new.target.name;
    this.exitCode = exitCode;
    this.details = details;
  }
}

export class UsageError extends FactoryError {
  constructor(message: string, details: readonly string[] = []) {
    super(message, ExitCode.Usage, details);
  }
}

export class ConfigError extends FactoryError {
  constructor(message: string, details: readonly string[] = []) {
    super(message, ExitCode.ConfigInvalid, details);
  }
}

export class PreconditionError extends FactoryError {
  constructor(message: string, details: readonly string[] = []) {
    super(message, ExitCode.Precondition, details);
  }
}

/** A child process failed in a way the caller did not tolerate. */
export class ExecError extends FactoryError {
  readonly result: { readonly code: number | null; readonly stderr: string };

  constructor(message: string, result: { code: number | null; stderr: string }) {
    super(message, ExitCode.Failure, result.stderr.trim() ? [result.stderr.trim()] : []);
    this.result = result;
  }
}
