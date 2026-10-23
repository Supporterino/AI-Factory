/**
 * Process exit codes of the `ai-factory` CLI. Documented in docs/cli.md; never reuse a number.
 */
export const ExitCode = {
  /** Command succeeded. */
  Ok: 0,
  /** Unexpected internal failure (a bug or an unhandled tool error). */
  Failure: 1,
  /** Invalid command line: unknown command, flag or missing argument. */
  Usage: 2,
  /** `factory.config.jsonc` is missing, unparsable or fails schema validation. */
  ConfigInvalid: 3,
  /** A precondition is not met (e.g. not initialised, dirty tree, missing tool). */
  Precondition: 4,
  /** `gate`: at least one gate failed, is missing, timed out or was not check-only. */
  GateFailed: 5,
  /** `run` / `approve` / `resume`: the change paused (failure report written) or was aborted. */
  Paused: 6,
  /** `detect --check`: detection differs from the config. */
  Drift: 10,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];
