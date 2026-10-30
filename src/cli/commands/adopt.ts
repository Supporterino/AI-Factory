import { findWorkspaceRoot, loadConfig } from "../../config/load.ts";
import type { FactoryConfig } from "../../config/schema.ts";
import { PreconditionError, UsageError } from "../../errors.ts";
import { CHANGE_ID, currentBranch } from "../../git/repo.ts";
import {
  hasRun,
  type PendingChange,
  pendingChanges,
  readPendingChange,
} from "../../openspec/changes.ts";
import { checkDesign } from "../../openspec/cli.ts";
import type { Pipeline } from "../../pipeline/context.ts";
import { design } from "../../pipeline/design.ts";
import { readActive } from "../../state/active.ts";
import { loadRun, newRun, now, type Phase, saveRun } from "../../state/run.ts";
import { requireInstalled } from "../../update/update.ts";
import { type Command, type CommandOptions, type Io, parseCommandArgs } from "../command.ts";
import { ExitCode } from "../exit-codes.ts";
import { PROGRESS_OPTIONS, verbosityOf, withPipeline } from "./pipeline-commands.ts";

const HELP = `Usage: ai-factory adopt [<change-id>... | --all] [--dry-run] [--json] [--normalize] [--preserve-progress]

Takes over OpenSpec changes that already exist in openspec/changes/ when the factory is
adopted. Adoption registers the change in .factory/runs/ and validates it, but writes no
git state and makes no model calls unless --normalize is used. Approval then creates the
change branch lazily, like any other change.

Without ids or --all it lists the pending changes. A change whose tasks are all checked is
left alone: archive it with \`openspec archive <id>\`. A partially implemented change needs
--preserve-progress; the work must already be committed on the base branch.

  --all                  Adopt every pending change that has no run state yet
  --dry-run              Show what would be adopted; write no run state
  --json                 Print the result as JSON (progress goes to stderr with --normalize)
  --normalize            If the change does not validate, let the architect add the
                         factory's per-task metadata (repo, deps, touches) and fill gaps.
                         Requires a clean AI repo, committed change files, the base
                         branch and no active change; uses tokens.
  --preserve-progress    Adopt a partially implemented change and treat its checked tasks
                         as already merged instead of restarting them
  --verbose              With --normalize: print one line per agent tool call and gate
  --quiet                With --normalize: only phase banners, failures and the summary`;

const OPTIONS = {
  all: { type: "boolean", default: false, description: "Adopt every pending change" },
  "dry-run": {
    type: "boolean",
    default: false,
    description: "Show what would be adopted; write nothing",
  },
  json: { type: "boolean", default: false, description: "Print the result as JSON" },
  normalize: {
    type: "boolean",
    default: false,
    description: "Let the architect repair the change's task metadata",
  },
  "preserve-progress": {
    type: "boolean",
    default: false,
    description: "Trust already checked tasks and keep them merged",
  },
  ...PROGRESS_OPTIONS,
} satisfies CommandOptions;

type Action = "adopted" | "updated" | "skipped" | "refused";

interface Outcome {
  readonly id: string;
  readonly action: Action;
  readonly phase?: Phase;
  readonly issues?: string[];
  readonly reason?: string;
  readonly normalized?: boolean;
}

interface Setup {
  readonly root: string;
  readonly config: FactoryConfig;
}

async function setup(io: Io): Promise<Setup> {
  const root = await findWorkspaceRoot(io.cwd);
  if (root === undefined) throw new PreconditionError("not inside a git repository");
  requireInstalled(root);
  return { root, config: loadConfig(root).config };
}

function selected(root: string, ids: readonly string[], all: boolean): PendingChange[] | undefined {
  if (ids.length > 0) {
    return ids.map((id) => {
      const change = readPendingChange(root, id);
      if (change === undefined)
        throw new PreconditionError(`no pending OpenSpec change ${id}`, [
          `expected openspec/changes/${id}/`,
          "run `ai-factory adopt` to list the pending changes",
        ]);
      return change;
    });
  }
  return all ? pendingChanges(root) : undefined;
}

function listPending(root: string, io: Io, json: boolean): ExitCode {
  const changes = pendingChanges(root);
  if (json) {
    io.out(
      JSON.stringify(
        {
          root,
          pending: changes.map((change) => ({
            id: change.id,
            done: change.done,
            total: change.total,
            adopted: hasRun(root, change.id),
          })),
        },
        null,
        2,
      ),
    );
    return ExitCode.Ok;
  }
  if (changes.length === 0) {
    io.out("no pending OpenSpec changes");
    return ExitCode.Ok;
  }
  io.out("pending OpenSpec changes:");
  for (const change of changes) {
    const tasks = change.total === 0 ? "no tasks yet" : `${change.done}/${change.total} tasks`;
    const state = hasRun(root, change.id)
      ? "adopted"
      : change.total > 0 && change.done === change.total
        ? `complete (archive with \`openspec archive ${change.id}\`)`
        : "not adopted";
    io.out(`  ${change.id} — ${tasks}; ${state}`);
  }
  io.out("run `ai-factory adopt --all` or `ai-factory adopt <id>` to take them over");
  return ExitCode.Ok;
}

async function check(root: string, config: FactoryConfig, id: string): Promise<string[]> {
  const result = await checkDesign(
    root,
    root,
    id,
    config.repos.filter((repo) => repo.role === "code").map((repo) => repo.name),
    config.contracts,
  );
  return result.issues;
}

/** Registers one newly discovered change (or reopens an adopted one for normalization). */
async function adoptOne(
  p: Pipeline | undefined,
  root: string,
  config: FactoryConfig,
  change: PendingChange,
  values: { normalize: boolean; preserveProgress: boolean; dryRun: boolean },
): Promise<Outcome> {
  const existing = loadRun(root, change.id);
  if (existing !== undefined) {
    if (existing.origin !== "openspec")
      return {
        id: change.id,
        action: "skipped",
        phase: existing.phase,
        reason: "already managed by the factory",
      };
    const reopen =
      values.normalize &&
      existing.tasks.length === 0 &&
      (existing.phase === "awaiting-approval" ||
        existing.phase === "paused" ||
        existing.phase === "design");
    if (!reopen)
      return {
        id: change.id,
        action: "skipped",
        phase: existing.phase,
        reason: `already adopted (${existing.phase})`,
      };
    const issues = await check(root, config, change.id);
    if (issues.length === 0)
      return {
        id: change.id,
        action: "skipped",
        phase: existing.phase,
        reason: "already adopted and valid",
      };
    if (values.dryRun)
      return {
        id: change.id,
        action: "updated",
        phase: "design",
        issues,
        normalized: false,
        reason: "would normalize with the architect",
      };
    if (p === undefined)
      throw new PreconditionError(`cannot normalize ${change.id} without a runtime`);
    await savePhase(root, change.id, "design");
    const result = await design(p, change.id);
    const run = loadRun(root, change.id);
    return {
      id: change.id,
      action: "updated",
      ...(run === undefined ? {} : { phase: run.phase }),
      issues: result.issues,
      normalized: true,
    };
  }

  if (change.schema !== undefined && change.schema !== "spec-driven")
    return {
      id: change.id,
      action: "refused",
      reason: `uses custom OpenSpec schema "${change.schema}"; the factory supports spec-driven only`,
    };
  if (change.total > 0 && change.done === change.total)
    return {
      id: change.id,
      action: "skipped",
      reason: `all ${change.total} tasks are checked; archive it with \`openspec archive ${change.id}\``,
    };
  if (change.done > 0 && !values.preserveProgress)
    return {
      id: change.id,
      action: "refused",
      reason: `${change.done} of ${change.total} tasks are checked; commit the work and rerun with --preserve-progress`,
    };

  if (values.dryRun) {
    const issues = await check(root, config, change.id);
    return {
      id: change.id,
      action: "adopted",
      phase: issues.length === 0 ? "awaiting-approval" : "paused",
      issues,
      normalized: false,
    };
  }

  const run = newRun(change.id, change.request, "awaiting-approval");
  run.origin = "openspec";
  run.adoptedAt = now();
  run.preserveProgress = values.preserveProgress;
  run.summary = change.summary;
  run.likelyRepos = change.repos;
  const issues = await check(root, config, change.id);
  if (values.normalize && issues.length > 0) {
    run.phase = "design";
    saveRun(root, run);
    if (p === undefined)
      throw new PreconditionError(`cannot normalize ${change.id} without a runtime`);
    const result = await design(p, change.id);
    const after = loadRun(root, change.id);
    return {
      id: change.id,
      action: "adopted",
      ...(after === undefined ? {} : { phase: after.phase }),
      issues: result.issues,
      normalized: true,
    };
  }
  if (issues.length > 0) {
    run.phase = "paused";
    run.pausedReason = `${issues.length} issue${issues.length === 1 ? "" : "s"}: ${issues.join("; ")}`;
  }
  saveRun(root, run);
  return {
    id: change.id,
    action: "adopted",
    phase: run.phase,
    issues,
    normalized: false,
  };
}

async function savePhase(root: string, id: string, phase: Phase): Promise<void> {
  const run = loadRun(root, id);
  if (run === undefined) throw new PreconditionError(`no run state for ${id}`);
  saveRun(root, { ...run, phase });
}

function report(io: Io, values: { dryRun: boolean }, results: readonly Outcome[]): ExitCode {
  if (results.length === 0) {
    io.out("no pending OpenSpec changes to adopt");
    return ExitCode.Ok;
  }
  for (const result of results) {
    switch (result.action) {
      case "adopted":
        io.out(
          `${values.dryRun ? "would adopt" : "adopted"} ${result.id} — ${result.phase}${result.normalized ? " (normalized)" : ""}`,
        );
        break;
      case "updated":
        io.out(
          `${values.dryRun ? "would update" : "updated"} ${result.id} — ${result.phase}${result.normalized ? " (normalized)" : ""}`,
        );
        break;
      case "skipped":
        io.out(`skipped ${result.id}${result.reason ? ` — ${result.reason}` : ""}`);
        break;
      case "refused":
        io.out(`refused ${result.id}${result.reason ? ` — ${result.reason}` : ""}`);
        break;
    }
    for (const issue of result.issues ?? []) io.out(`  - ${issue}`);
  }
  const next = results.find((result) => result.phase === "awaiting-approval");
  if (next !== undefined && !values.dryRun)
    io.out(`next: review openspec/changes/${next.id}/ then run \`ai-factory approve ${next.id}\``);
  const paused = results.find((result) => result.phase === "paused");
  if (paused !== undefined && !values.dryRun)
    io.out(
      `next: fix openspec/changes/${paused.id}/, or \`ai-factory resume ${paused.id}\` to let the architect repair it`,
    );
  if (results.some((result) => result.action === "refused")) return ExitCode.Precondition;
  if (!values.dryRun && results.some((result) => result.phase === "paused")) return ExitCode.Paused;
  return ExitCode.Ok;
}

export const adoptCommand: Command = {
  name: "adopt",
  summary: "Take over OpenSpec changes that existed before the factory",
  help: HELP,
  options: OPTIONS,
  positionals: [{ name: "change-id", variadic: true, complete: "change" }],
  async run(args, io) {
    const { values, positionals } = parseCommandArgs("adopt", args, OPTIONS, true);
    if (values.all && positionals.length > 0)
      throw new UsageError("adopt: --all and change ids exclude each other");
    for (const id of positionals)
      if (!CHANGE_ID.test(id)) throw new UsageError(`adopt: invalid change id "${id}"`);

    const { root, config } = await setup(io);
    const changes = selected(root, positionals, values.all === true);
    if (changes === undefined) return listPending(root, io, values.json === true);

    const options = {
      normalize: values.normalize === true,
      preserveProgress: values["preserve-progress"] === true,
      dryRun: values["dry-run"] === true,
    };

    if (options.normalize) {
      // Normalization branches and edits the spec in place. Doing that on top of another
      // change's branch, or from a draft whose base predates the adopted spec, is ambiguous.
      const active = readActive(root);
      const branch = await currentBranch(root);
      if (active !== undefined || branch?.startsWith("change/"))
        throw new PreconditionError(
          "--normalize must start from the base branch with no active change",
          [
            "switch to your base branch (for example `git switch main`) and finish or abort the active change first",
            "deterministic `ai-factory adopt` works at any time",
          ],
        );
    }

    if (!options.normalize) {
      const results: Outcome[] = [];
      for (const change of changes)
        results.push(await adoptOne(undefined, root, config, change, options));
      if (values.json) {
        io.out(JSON.stringify({ root, dryRun: options.dryRun, results }, null, 2));
        return reportCode(results, options.dryRun);
      }
      return report(io, options, results);
    }

    const verbosity = verbosityOf(values);
    // With --json the human progress must not corrupt stdout: send it to stderr.
    const progressIo = values.json === true ? { ...io, out: (line: string) => io.err(line) } : io;
    const results: Outcome[] = [];
    const code = await withPipeline(progressIo, "adopt", { verbosity }, async (p) => {
      for (const change of changes) results.push(await adoptOne(p, root, config, change, options));
      return ExitCode.Ok;
    });
    if (values.json) {
      io.out(JSON.stringify({ root, dryRun: options.dryRun, results }, null, 2));
      return code === ExitCode.Ok ? reportCode(results, options.dryRun) : code;
    }
    return report(io, options, results);
  },
};

/** Exit code without printing (the JSON branch has already printed the result). */
function reportCode(results: readonly Outcome[], dryRun: boolean): ExitCode {
  if (results.some((result) => result.action === "refused")) return ExitCode.Precondition;
  if (!dryRun && results.some((result) => result.phase === "paused")) return ExitCode.Paused;
  return ExitCode.Ok;
}
