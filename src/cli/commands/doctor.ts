import { findWorkspaceRoot } from "../../config/load.ts";
import { type Check, type DoctorReport, runDoctor } from "../../doctor/doctor.ts";
import { PreconditionError } from "../../errors.ts";
import { git } from "../../exec.ts";
import { type Command, type CommandOptions, type Io, parseCommandArgs } from "../command.ts";
import { ExitCode } from "../exit-codes.ts";

const MARK: Record<Check["status"], string> = { ok: "✓", warn: "!", fail: "✗" };

function print(io: Io, report: DoctorReport): void {
  let section = "";
  for (const c of report.checks) {
    if (c.section !== section) {
      section = c.section;
      io.out(section);
    }
    io.out(`  ${MARK[c.status]} ${c.name}: ${c.detail}`);
    if (c.fix && c.status !== "ok") io.out(`      → ${c.fix}`);
  }
  if (report.gates.length > 0) {
    io.out("gate table (full mode; per task, scoped commands and affected tests are used)");
    const label = (g: (typeof report.gates)[number]): string => `${g.repo} ${g.name ?? g.type}`;
    const width = Math.max(...report.gates.map((g) => label(g).length));
    for (const g of report.gates) {
      const where = g.cwd === "." ? "" : ` [${g.cwd}]`;
      const what = g.command ? `${g.command}  (${g.source})` : (g.problem ?? "");
      io.out(`  ${label(g).padEnd(width)}${where}  ${what}`);
    }
  }
  const fails = report.checks.filter((c) => c.status === "fail").length;
  const warns = report.checks.filter((c) => c.status === "warn").length;
  io.out(fails + warns === 0 ? "all checks passed" : `${fails} problem(s), ${warns} warning(s)`);
}

const OPTIONS = {
  json: { type: "boolean", default: false, description: "Print the report as JSON" },
} satisfies CommandOptions;

export const doctorCommand: Command = {
  name: "doctor",
  summary: "Check tools, install, repos, hooks, gates, caches, models and the graph",
  options: OPTIONS,
  help: `Usage: ai-factory doctor [--json]

Read-only health check of the workspace:
- tool versions against the lock and against what this factory supports;
- the install: config, managed files, the Ponytail hash;
- submodules (offers \`git submodule update --init\` when some are missing), clean
  working trees and the pre-push hooks;
- the resolved gate command per repo and gate, and whether its toolchain is on PATH;
- dependency cache, worktree, log and backup sizes;
- that every configured model is available to opencode with the factory's curated env;
- graph freshness, and a stale active-change lock.

Exit code ${ExitCode.Precondition} when a check fails; warnings exit 0.`,
  async run(args, io) {
    const { values } = parseCommandArgs("doctor", args, OPTIONS);
    const root = await findWorkspaceRoot(io.cwd);
    if (root === undefined) throw new PreconditionError("not inside a git repository");
    let report = await runDoctor(root);

    if (!values.json && report.uninitialised.length > 0 && io.confirm) {
      const paths = report.uninitialised;
      if (
        await io.confirm(`Initialise ${paths.join(", ")} with \`git submodule update --init\`?`)
      ) {
        const res = await git(["submodule", "update", "--init", "--", ...paths], {
          cwd: root,
          timeoutMs: 600_000,
        });
        io.out(
          res.code === 0
            ? `initialised ${paths.join(", ")}`
            : `git submodule update failed: ${res.stderr.trim()}`,
        );
        report = await runDoctor(root);
      }
    }

    if (values.json) io.out(JSON.stringify(report, null, 2));
    else print(io, report);
    return report.checks.some((c) => c.status === "fail") ? ExitCode.Precondition : ExitCode.Ok;
  },
};
