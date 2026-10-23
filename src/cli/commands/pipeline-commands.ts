import { existsSync } from "node:fs";
import { join } from "node:path";
import { findWorkspaceRoot, loadConfig } from "../../config/load.ts";
import { PreconditionError, UsageError } from "../../errors.ts";
import { CHANGE_ID } from "../../git/repo.ts";
import { LOCK_FILE } from "../../lock/lock.ts";
import { pruneLogs } from "../../logs/log.ts";
import { approve } from "../../pipeline/approve.ts";
import { Pipeline } from "../../pipeline/context.ts";
import { design, intake } from "../../pipeline/design.ts";
import { type DriveOutcome, drive } from "../../pipeline/drive.ts";
import { OpencodeRuntime } from "../../runtime/opencode.ts";
import { readActive, releaseDriver } from "../../state/active.ts";
import { loadRun } from "../../state/run.ts";
import { type Command, type Io, parseCommandArgs } from "../command.ts";
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
async function withPipeline<T>(
  io: Io,
  changeId: string,
  work: (p: Pipeline) => Promise<T>,
): Promise<T> {
  const { root, config } = await setup(io);
  const factory =
    io.runtime ?? ((r, c, id) => new OpencodeRuntime({ root: r, config: c, changeId: id }));
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
  });
  try {
    return await work(p);
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await runtime.close();
    const active = readActive(root);
    if (active?.pid === process.pid) await releaseDriver(root, active.changeId);
  }
}

function report(io: Io, outcome: DriveOutcome): ExitCode {
  io.out(`${outcome.id}: ${outcome.phase}${outcome.detail ? ` — ${outcome.detail}` : ""}`);
  return outcome.phase === "paused" || outcome.phase === "aborted" ? ExitCode.Paused : ExitCode.Ok;
}

function changeIdArg(command: string, positionals: readonly string[]): string {
  const id = positionals[0];
  if (id === undefined || positionals.length > 1)
    throw new UsageError(`${command}: expected exactly one <change-id>`);
  if (!CHANGE_ID.test(id)) throw new UsageError(`${command}: invalid change id "${id}"`);
  return id;
}

export const runCommand: Command = {
  name: "run",
  summary: "Start a change from a request and run it up to spec approval",
  help: `Usage: ai-factory run "<request>"

Intake (change id and summary), a change branch in the AI repo, explorers per likely repo,
then the architect writes the OpenSpec change. Stops at spec approval: review
openspec/changes/<id>/ and run \`ai-factory approve <id>\`. If another change is active, the
new one is drafted in .factory/drafts/<id> and queued after approval.`,
  async run(args, io) {
    const { positionals } = parseCommandArgs("run", args, {}, true);
    const request = positionals.join(" ").trim();
    if (request === "")
      throw new UsageError('run: expected a request, e.g. ai-factory run "add a health endpoint"');
    return withPipeline(io, "intake", async (p) => {
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

export const approveCommand: Command = {
  name: "approve",
  summary: "Approve a change's spec and continue the pipeline",
  help: `Usage: ai-factory approve <change-id> [--no-continue]

Validates the change, commits the spec on its AI-repo branch (\`docs(spec): <id>\`) and
records the approval (approver = git user.email, spec commit, content hash; task checkboxes
are excluded from the hash). Then continues automatically: implementation starts, or the
change is queued while another one is active. --no-continue only records the approval.`,
  async run(args, io) {
    const { values, positionals } = parseCommandArgs(
      "approve",
      args,
      { "no-continue": { type: "boolean", default: false } },
      true,
    );
    const id = changeIdArg("approve", positionals);
    return withPipeline(io, id, async (p) => {
      await approve(p, id);
      if (values["no-continue"]) return ExitCode.Ok;
      return report(io, await drive(p, id));
    });
  },
};

export const resumeCommand: Command = {
  name: "resume",
  summary: "Continue a paused, aborted, interrupted or queued change",
  help: `Usage: ai-factory resume <change-id>

Continues the change from its last consistent state: interrupted tasks restart in their
kept worktrees, finished ones stay; a queued change starts when the workspace is free.`,
  async run(args, io) {
    const { positionals } = parseCommandArgs("resume", args, {}, true);
    const id = changeIdArg("resume", positionals);
    return withPipeline(io, id, async (p) => {
      const run = loadRun(p.root, id);
      if (run === undefined) throw new PreconditionError(`no change ${id}`);
      if (run.phase === "done") {
        io.out(`${id} is already done`);
        return ExitCode.Ok;
      }
      return report(io, await drive(p, id));
    });
  },
};
