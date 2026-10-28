import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { findWorkspaceRoot, loadConfig } from "../../config/load.ts";
import { PreconditionError, UsageError } from "../../errors.ts";
import { CHANGE_ID } from "../../git/repo.ts";
import { LOCK_FILE } from "../../lock/lock.ts";
import { pruneLogs } from "../../logs/log.ts";
import { approve } from "../../pipeline/approve.ts";
import { Pipeline } from "../../pipeline/context.ts";
import { design, intake } from "../../pipeline/design.ts";
import type { DriveOutcome } from "../../pipeline/drive.ts";
import { drive } from "../../pipeline/drive.ts";
import type { Verbosity } from "../../pipeline/progress.ts";
import { refineRequest } from "../../pipeline/refine.ts";
import { OpencodeRuntime } from "../../runtime/opencode.ts";
import { readActive, releaseDriver } from "../../state/active.ts";
import { readOrCorrupt } from "../../state/files.ts";
import { loadRun } from "../../state/run.ts";
import { type Command, type CommandOptions, type Io, parseCommandArgs } from "../command.ts";
import { ExitCode } from "../exit-codes.ts";

async function setup(
  io: Io,
): Promise<{ root: string; config: ReturnType<typeof loadConfig>["config"] }> {
  const root = await findWorkspaceRoot(io.cwd);
  if (root === undefined) throw new PreconditionError("not inside a git repository");
  if (!existsSync(join(root, LOCK_FILE)))
    throw new PreconditionError("ai-factory is not installed here", ["run `ai-factory init`"]);
  const { config } = loadConfig(root);
  pruneLogs(root, config.logs.retentionDays);
  return { root, config };
}

/**
 * Runs pipeline work with a runtime and a signal wired to SIGINT/SIGTERM: an interrupt stops
 * dispatch, interrupts agents and leaves a resumable state. The runtime is always closed and
 * the active-change driver released (the change itself stays active).
 */
export async function withPipeline<T>(
  io: Io,
  changeId: string,
  options: { readonly verbosity?: Verbosity },
  work: (p: Pipeline) => Promise<T>,
): Promise<T> {
  const { root, config } = await setup(io);
  const factory =
    io.runtime ??
    ((r, c, id) =>
      new OpencodeRuntime({
        root: r,
        config: c,
        changeId: id,
        turnTimeoutMs: c.runtime.turnTimeoutMinutes * 60_000,
      }));
  const runtime = factory(root, config, changeId);
  const controller = new AbortController();
  const onSignal = (): void => {
    io.err("interrupt: stopping safely (state is kept; continue with `ai-factory resume`)");
    controller.abort();
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  const p = new Pipeline(root, config, {
    runtime,
    out: (l) => io.out(l),
    signal: controller.signal,
    ...(options.verbosity === undefined ? {} : { verbosity: options.verbosity }),
  });
  try {
    return await work(p);
  } finally {
    p.progress.stop();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await runtime.close();
    const active = readOrCorrupt(() => readActive(root)).value;
    if (active?.pid === process.pid) await releaseDriver(root, active.changeId);
  }
}

/** `--verbose` and `--quiet` are per command; the default is `normal`. */
export function verbosityOf(values: {
  readonly verbose?: boolean;
  readonly quiet?: boolean;
}): Verbosity {
  if (values.verbose === true && values.quiet === true)
    throw new UsageError("--verbose and --quiet exclude each other");
  if (values.quiet === true) return "quiet";
  if (values.verbose === true) return "verbose";
  return "normal";
}

/** The flags every pipeline command accepts. */
export const PROGRESS_OPTIONS = {
  verbose: {
    type: "boolean",
    default: false,
    description: "Print one line per agent tool call and per gate",
  },
  quiet: {
    type: "boolean",
    default: false,
    description: "Only print banners, merges, failures and the summary",
  },
} as const satisfies CommandOptions;

function report(io: Io, outcome: DriveOutcome): ExitCode {
  io.out(`${outcome.id}: ${outcome.phase}${outcome.detail ? ` — ${outcome.detail}` : ""}`);
  if (outcome.phase === "done")
    io.out(
      `next: \`ai-factory land ${outcome.id}\` merges the finished change into its base branches`,
    );
  return outcome.phase === "paused" || outcome.phase === "aborted" ? ExitCode.Paused : ExitCode.Ok;
}

function changeIdArg(command: string, positionals: readonly string[]): string {
  const id = positionals[0];
  if (id === undefined || positionals.length > 1)
    throw new UsageError(`${command}: expected exactly one <change-id>`);
  if (!CHANGE_ID.test(id)) throw new UsageError(`${command}: invalid change id "${id}"`);
  return id;
}

const RUN_OPTIONS = {
  request: {
    type: "string",
    complete: "file",
    description: "Read the request from a file",
  },
  interactive: {
    type: "boolean",
    default: false,
    description: "Ask refinement questions before intake",
  },
  ...PROGRESS_OPTIONS,
} satisfies CommandOptions;

export const runCommand: Command = {
  name: "run",
  summary: "Start a change from a request and run it up to spec approval",
  options: RUN_OPTIONS,
  positionals: [{ name: "request", variadic: true }],
  help: `Usage: ai-factory run "<request>" [--request <file>] [--interactive] [--verbose|--quiet]

Intake (change id and summary), a change branch in the AI repo, explorers per likely repo,
then the architect writes the OpenSpec change. Stops at spec approval: review
openspec/changes/<id>/ and run \`ai-factory approve <id>\`. If another change is active, the
new one is drafted in .factory/drafts/<id> and queued after approval.

  --request <file>  Read the request from a file (e.g. one written by \`ai-factory refine\`)
  --interactive     Ask scope/verification questions before intake
  --verbose         Also print one line per agent tool call and per gate
  --quiet           Only phase banners, merges, failures and the summary`,
  async run(args, io) {
    const { values, positionals } = parseCommandArgs("run", args, RUN_OPTIONS, true);
    let request = positionals.join(" ").trim();
    if (values.request !== undefined) {
      request = readFileSync(resolve(io.cwd, values.request), "utf8").trim();
    }
    if (request === "")
      throw new UsageError('run: expected a request, e.g. ai-factory run "add a health endpoint"');
    const verbosity = verbosityOf(values);
    return withPipeline(io, "intake", { verbosity }, async (p) => {
      if (values.interactive) {
        if (!p.config.workflow.refine) {
          throw new PreconditionError("workflow.refine is disabled");
        }
        const refined = await refineRequest(io, request);
        request = refined.text;
        io.out(`refined request: ${refined.path}`);
      }
      const id = await intake(p, request);
      const result = await design(p, id);
      if (!result.ok) {
        io.out(`${id}: the spec does not validate yet:`);
        for (const issue of result.issues) io.out(`  - ${issue}`);
        io.out(
          `fix openspec/changes/${id}/ and run \`ai-factory approve ${id}\`, or \`ai-factory resume ${id}\` to let the architect repair it`,
        );
        return ExitCode.Paused;
      }
      io.out(
        `${id}: awaiting approval — review openspec/changes/${id}/ then run \`ai-factory approve ${id}\``,
      );
      return ExitCode.Ok;
    });
  },
};

const APPROVE_OPTIONS = {
  "no-continue": {
    type: "boolean",
    default: false,
    description: "Record the approval without starting implementation",
  },
  ...PROGRESS_OPTIONS,
} satisfies CommandOptions;

export const approveCommand: Command = {
  name: "approve",
  summary: "Approve a change's spec and continue the pipeline",
  options: APPROVE_OPTIONS,
  positionals: [{ name: "change-id", complete: "change" }],
  help: `Usage: ai-factory approve <change-id> [--no-continue] [--verbose|--quiet]

Validates the change, commits the spec on its AI-repo branch (\`docs(spec): <id>\`) and
records the approval (approver = git user.email, spec commit, content hash; task checkboxes
are excluded from the hash). Then continues automatically: implementation starts, or the
change is queued while another one is active. --no-continue only records the approval.

  --verbose         Also print one line per agent tool call and per gate
  --quiet           Only phase banners, merges, failures and the summary`,
  async run(args, io) {
    const { values, positionals } = parseCommandArgs("approve", args, APPROVE_OPTIONS, true);
    const id = changeIdArg("approve", positionals);
    const verbosity = verbosityOf(values);
    return withPipeline(io, id, { verbosity }, async (p) => {
      await approve(p, id);
      if (values["no-continue"]) return ExitCode.Ok;
      return report(io, await drive(p, id));
    });
  },
};

export const resumeCommand: Command = {
  name: "resume",
  summary: "Continue a paused, aborted, interrupted or queued change",
  options: PROGRESS_OPTIONS,
  positionals: [{ name: "change-id", complete: "change" }],
  help: `Usage: ai-factory resume <change-id> [--verbose|--quiet]

Continues the change from its last consistent state: interrupted tasks restart in their
kept worktrees, finished ones stay; a queued change starts when the workspace is free.

  --verbose         Also print one line per agent tool call and per gate
  --quiet           Only phase banners, merges, failures and the summary`,
  async run(args, io) {
    const { positionals, values } = parseCommandArgs("resume", args, PROGRESS_OPTIONS, true);
    const id = changeIdArg("resume", positionals);
    const verbosity = verbosityOf(values);
    return withPipeline(io, id, { verbosity }, async (p) => {
      const run = loadRun(p.root, id);
      if (run === undefined) throw new PreconditionError(`no change ${id}`);
      if (run.phase === "done") {
        io.out(`${id} is already done`);
        io.out(`next: \`ai-factory land ${id}\` merges the finished change into its base branches`);
        return ExitCode.Ok;
      }
      return report(io, await drive(p, id));
    });
  },
};
