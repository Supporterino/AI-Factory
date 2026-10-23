import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { findWorkspaceRoot, loadConfig } from "../../config/load.ts";
import type { RepoConfig } from "../../config/schema.ts";
import { PreconditionError, UsageError } from "../../errors.ts";
import { git } from "../../exec.ts";
import type { GateReport, GateResult } from "../../gates/run.ts";
import { runGates } from "../../gates/run.ts";
import { CHANGE_ID, resolveBranchRef } from "../../git/repo.ts";
import { worktreePath } from "../../git/worktrees.ts";
import { Semaphore } from "../../util/semaphore.ts";
import { type Command, type Io, parseCommandArgs } from "../command.ts";
import { ExitCode } from "../exit-codes.ts";

const HELP = `Usage: ai-factory gate <change-id> [--task <id>] [--repo <name>] [--full] [--json]

Runs the quality gates (format, lint, types, tests) and prints the results.

  --task <id>   Gate one task's worktree (.factory/worktrees/<change>/<repo>/<task>):
                affected tests only, measured against change/<change-id>
  --repo <name> Limit to one repo
  --full        Whole-repo gates with the full test suite (default for repo checkouts
                is per-change affected gates)
  --json        Machine-readable output

Gates resolve as: gates.overrides → the repo's own script → profile defaults. Every
gate must be check-only; one that modifies files fails and its changes are undone.
Exit code ${ExitCode.GateFailed} when any gate fails, is missing, times out or is not check-only.`;

const MARK: Record<GateResult["status"], string> = {
  pass: "✓",
  fail: "✗",
  missing: "✗",
  "not-check-only": "✗",
  timeout: "✗",
  skipped: "–",
};

interface GateJob {
  readonly repo: RepoConfig;
  readonly worktree: string;
  readonly base: string;
  readonly mode: "task" | "full";
}

async function baseOf(dir: string, ref: string): Promise<string> {
  const res = await git(["merge-base", "HEAD", ref], { cwd: dir });
  if (res.code !== 0)
    throw new PreconditionError(`no common history between HEAD and ${ref} in ${dir}`);
  return res.stdout.trim();
}

function findTaskWorktree(
  root: string,
  id: string,
  task: string,
  repoName?: string,
): { repo: string; dir: string } {
  const changeDir = join(root, ".factory", "worktrees", id);
  const repos = repoName ? [repoName] : existsSync(changeDir) ? readdirSync(changeDir) : [];
  const hits = repos
    .map((r) => ({ repo: r, dir: worktreePath(root, id, r, task) }))
    .filter((h) => existsSync(h.dir));
  const hit = hits[0];
  if (hit === undefined || hits.length > 1) {
    throw new PreconditionError(
      hit === undefined
        ? `no worktree for task ${task} of ${id}`
        : `task ${task} exists in several repos; pass --repo`,
    );
  }
  return hit;
}

function printReport(io: Io, report: GateReport): void {
  io.out(
    `${report.passed ? "✓" : "✗"} ${report.repo} (${report.mode}, base ${report.base.slice(0, 12)})`,
  );
  for (const r of report.results) {
    const where = r.cwd === "." ? "" : ` [${r.cwd}]`;
    const what = r.command ? ` ${r.command}` : "";
    const time = r.durationMs > 0 ? ` ${(r.durationMs / 1000).toFixed(1)}s` : "";
    io.out(
      `  ${MARK[r.status]} ${r.type}${where}${what}${time}${r.status === "skipped" ? ` (${r.output})` : ""}`,
    );
    if (r.status !== "pass" && r.status !== "skipped" && r.output) {
      for (const line of r.output.split("\n")) io.out(`      ${line}`);
    }
  }
}

export const gateCommand: Command = {
  name: "gate",
  summary: "Run the quality gates for a change, a task or a repo",
  help: HELP,
  async run(args, io) {
    const { values, positionals } = parseCommandArgs(
      "gate",
      args,
      {
        task: { type: "string" },
        repo: { type: "string" },
        full: { type: "boolean", default: false },
        json: { type: "boolean", default: false },
      },
      true,
    );
    const id = positionals[0];
    if (id === undefined || positionals.length > 1)
      throw new UsageError("gate: expected exactly one <change-id>");
    if (!CHANGE_ID.test(id)) throw new UsageError(`gate: invalid change id "${id}"`);
    if (values.task !== undefined && values.full)
      throw new UsageError("gate: --task and --full exclude each other");

    const root = await findWorkspaceRoot(io.cwd);
    if (root === undefined) throw new PreconditionError("not inside a git repository");
    const { config } = loadConfig(root);
    const codeRepos = config.repos.filter((r) => r.role === "code");
    const pick = (name: string): RepoConfig => {
      const repo = codeRepos.find((r) => r.name === name);
      if (repo === undefined) throw new UsageError(`gate: unknown repo "${name}"`);
      return repo;
    };

    const jobs: GateJob[] = [];
    if (values.task !== undefined) {
      const { repo, dir } = findTaskWorktree(root, id, values.task, values.repo);
      jobs.push({
        repo: pick(repo),
        worktree: dir,
        mode: "task",
        base: await baseOf(dir, `change/${id}`),
      });
    } else {
      const repos = values.repo !== undefined ? [pick(values.repo)] : codeRepos;
      for (const repo of repos) {
        const dir = join(root, repo.path);
        const branch = (await git(["branch", "--show-current"], { cwd: dir })).stdout.trim();
        if (branch !== `change/${id}`) {
          if (values.repo !== undefined) {
            throw new PreconditionError(
              `${repo.name} is on "${branch || "detached HEAD"}", not change/${id}`,
            );
          }
          continue;
        }
        const ref = await resolveBranchRef(dir, repo.defaultBranch ?? "main");
        jobs.push({
          repo,
          worktree: dir,
          mode: values.full ? "full" : "task",
          base: await baseOf(dir, ref),
        });
      }
      if (jobs.length === 0) throw new PreconditionError(`no repo has change/${id} checked out`);
    }

    // Gates of different repos run concurrently, bounded by parallel.maxGateProcesses.
    const limit = new Semaphore(config.parallel.maxGateProcesses);
    const reports = await Promise.all(
      jobs.map((job) => limit.run(() => runGates({ root, config, ...job }))),
    );

    if (values.json) {
      io.out(
        JSON.stringify({ change: id, passed: reports.every((r) => r.passed), reports }, null, 2),
      );
    } else {
      for (const report of reports) printReport(io, report);
    }
    return reports.every((r) => r.passed) ? ExitCode.Ok : ExitCode.GateFailed;
  },
};
