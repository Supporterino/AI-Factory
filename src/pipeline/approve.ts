import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Approval, approvalFile, readApproval, specHash } from "../approval/approval.ts";
import { PreconditionError } from "../errors.ts";
import { git, gitOk } from "../exec.ts";
import { commitPaths } from "../git/commit.ts";
import { changeBranch, currentBranch } from "../git/repo.ts";
import { changePath, checkDesign } from "../openspec/cli.ts";
import { now, type RunState, recordTask, TaskState } from "../state/run.ts";
import { parseTasks } from "../tasks/parse.ts";
import { snapshotDefinitions } from "../update/snapshot.ts";
import type { Pipeline } from "./context.ts";
import { ensureDesignBranch, specDir } from "./design.ts";

/**
 * §7 step 3, the only human gate: commit the spec on the change's AI-repo branch, record the
 * approval (approver, spec commit, content hash with task checkboxes normalised) and load
 * the task DAG into the run state.
 */
export async function approve(p: Pipeline, id: string): Promise<Approval> {
  let run = p.run(id);
  assertApprovable(id, run);
  // An adopted change has no branch yet: create it (or its draft worktree) before validating
  // and committing the spec, so the normal branch check below applies to it too (ADR-0038).
  if (run.branches["."] === undefined) {
    await ensureDesignBranch(p, id);
    run = p.run(id);
  }
  const dir = specDir(p, run.draft);
  const check = await checkDesign(
    p.root,
    dir,
    id,
    p.codeRepos().map((r) => r.name),
    p.config.contracts,
  );
  if (check.issues.length > 0) throw new PreconditionError(`${id} does not validate`, check.issues);

  const approver = (await git(["config", "user.email"], { cwd: p.root })).stdout.trim();
  if (approver === "")
    throw new PreconditionError("git user.email is not set; it records who approved");

  // The spec is committed on the change's own branch, never on whatever is checked out.
  const branch = await currentBranch(dir);
  if (branch !== changeBranch(id)) {
    throw new PreconditionError(
      `the spec of ${id} must be committed on ${changeBranch(id)}, but ${dir} is on ${branch ?? "a detached HEAD"}`,
      [`run \`ai-factory resume ${id}\` to branch first`],
    );
  }
  const path = `openspec/changes/${id}`;
  const specCommit =
    (await commitPaths(dir, [path], `docs(spec): ${id}`, { "Change-Id": id })) ??
    (await gitOk(["log", "-1", "--format=%H", "--", path], { cwd: dir }));
  if (specCommit === "") throw new PreconditionError(`nothing committed for ${path}`);

  const approval: Approval = {
    changeId: id,
    approver,
    specCommit,
    hash: specHash(dir, id),
    approvedAt: now(),
  };
  const checked = run.preserveProgress ? checkedTaskIds(dir, id) : new Set<string>();
  await p.update(id, (d) => {
    // Checked again under the run lock: another approve or resume may have moved on (P14).
    assertApprovable(id, d);
    const file = approvalFile(p.root, id);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(approval, null, 2)}\n`);
    d.phase = "queued";
    delete d.pausedReason;
    d.tasks = check.tasks.map((t) => {
      const merged = checked.has(t.id);
      const task = TaskState.parse({
        ...t,
        deps: [...t.deps],
        touches: [...t.touches],
        status: merged ? "merged" : "pending",
      });
      recordTask(task, merged ? "adopted: already checked in OpenSpec" : "approved");
      return task;
    });
  });
  snapshotDefinitions(p.root, id, p.config, p.run(id).factoryVersion, true);
  p.out(
    `✓ approved ${id} by ${approver} (spec ${specCommit.slice(0, 12)}, ${check.tasks.length} tasks)`,
  );
  return approval;
}

const PAST_APPROVAL: ReadonlySet<string> = new Set([
  "implementing",
  "reviewing",
  "contracts",
  "full-suite",
  "closing",
  "done",
]);

function assertApprovable(id: string, run: RunState): void {
  const started = run.tasks.some((t) => t.status !== "pending");
  if (PAST_APPROVAL.has(run.phase) || started) {
    throw new PreconditionError(`${id} is past approval (phase ${run.phase})`);
  }
  if (!["awaiting-approval", "paused", "queued"].includes(run.phase)) {
    throw new PreconditionError(`${id} is not ready for approval (phase ${run.phase})`);
  }
}

/** Task ids already checked in an adopted change's `tasks.md`. */
function checkedTaskIds(dir: string, id: string): Set<string> {
  const file = join(changePath(dir, id), "tasks.md");
  if (!existsSync(file)) return new Set();
  return new Set(
    parseTasks(readFileSync(file, "utf8"))
      .tasks.filter((task) => task.done)
      .map((task) => task.id),
  );
}

/** The CLI-side approval check: hash still valid and the spec commit is on the change branch. */
export async function verifyApproval(p: Pipeline, id: string, dir: string): Promise<void> {
  // The approval file always lives in the workspace root; the spec may be in a draft dir.
  const approval = readApproval(p.root, id);
  if (approval === undefined)
    throw new PreconditionError(`${id} is not approved`, [`run \`ai-factory approve ${id}\``]);
  if (specHash(dir, id) !== approval.hash) {
    const started = p.run(id).tasks.some((t) => t.status !== "pending");
    throw new PreconditionError(
      `the spec of ${id} changed after approval`,
      started
        ? [
            "implementation has started, so it cannot be approved again; restore the approved spec:",
            `git checkout ${approval.specCommit.slice(0, 12)} -- openspec/changes/${id} && git commit -m "docs(spec): restore approved ${id}"`,
            `then \`ai-factory resume ${id}\` (or \`ai-factory abort ${id}\` and start a new change)`,
          ]
        : [`review the change and run \`ai-factory approve ${id}\` again`],
    );
  }
  const onBranch = await git(["merge-base", "--is-ancestor", approval.specCommit, "HEAD"], {
    cwd: dir,
  });
  if (onBranch.code !== 0) {
    throw new PreconditionError(
      `the approved spec commit ${approval.specCommit.slice(0, 12)} is not on change/${id}`,
    );
  }
}
