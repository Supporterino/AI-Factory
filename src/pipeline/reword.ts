import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  type Approval,
  type ApprovalHistoryEntry,
  readApproval,
  specHash,
  writeApproval,
} from "../approval/approval.ts";
import { PreconditionError } from "../errors.ts";
import { git, gitOk } from "../exec.ts";
import { commitPaths } from "../git/commit.ts";
import { changeBranch, currentBranch } from "../git/repo.ts";
import type { Finding } from "../handoff/schema.ts";
import { appendLog } from "../logs/log.ts";
import { checkDesign } from "../openspec/cli.ts";
import { auditChanges, type SessionContext } from "../policy/scope.ts";
import { claimActive } from "../state/active.ts";
import { loadRun, now, type RunState } from "../state/run.ts";
import { type ParsedTask, parseTasks } from "../tasks/parse.ts";
import { capText } from "../util/cap.ts";
import type { AgentResult, Pipeline } from "./context.ts";
import { specDir } from "./design.ts";
import { rewordPrompt } from "./prompts.ts";

/**
 * `reword` and `reapprove`: the only ways past an approval hash after implementation started.
 * Both commit the change folder on `change/<id>` and re-stamp `.factory/approvals/<id>.json`
 * without reloading the run's tasks (which `approve` would do). `reword` runs the architect
 * over review findings; `reapprove` accepts a hand edit.
 */

const CHANGE_PHASES: ReadonlySet<string> = new Set([
  "queued",
  "implementing",
  "reviewing",
  "contracts",
  "full-suite",
  "closing",
  "paused",
  "aborted",
]);

const MAX_HISTORY = 20;

export interface RewordOptions {
  /** Findings to apply; defaults to the run's recorded `specFindings`. */
  readonly findings?: readonly Finding[];
  /** Free-form instruction for the architect (with or without findings). */
  readonly request?: string;
  /** Run the architect, show the result, then restore the spec and keep the findings. */
  readonly dryRun?: boolean;
}

export interface RewordResult {
  readonly changed: boolean;
  readonly approval: Approval;
  readonly specCommit: string;
  /** Findings still unresolved (empty after a successful reword). */
  readonly findings: readonly Finding[];
}

export interface ReapproveResult {
  readonly changed: boolean;
  readonly approval: Approval;
  readonly specCommit: string;
}

const specPath = (id: string): string => `openspec/changes/${id}`;

/** Stable identity for a finding across a `structuredClone` of the run state. */
const findingKey = (f: Finding): string =>
  JSON.stringify([f.severity, f.file ?? "", f.line ?? 0, f.what, f.problem, f.fix, f.impact]);

/** Phase, lock, approval and branch checks shared by both commands. */
async function assertRewordable(p: Pipeline, id: string): Promise<{ run: RunState; dir: string }> {
  const run = loadRun(p.root, id);
  if (run === undefined) {
    throw new PreconditionError(`${id} has no run state`, [
      `run \`ai-factory run "..."\` or \`ai-factory adopt ${id}\` first`,
    ]);
  }
  if (run.phase === "done")
    throw new PreconditionError(`${id} is closed; its spec has been archived`);
  if (!CHANGE_PHASES.has(run.phase)) {
    throw new PreconditionError(`${id} is not approved yet (phase ${run.phase})`, [
      `run \`ai-factory approve ${id}\` first`,
    ]);
  }
  if (readApproval(p.root, id) === undefined) {
    throw new PreconditionError(`${id} is not approved`, [
      `run \`ai-factory approve ${id}\` first`,
    ]);
  }
  // Claim the workspace for the duration of the command: a live driver means a resume is
  // running, and another change would put the AI repo on the wrong branch.
  const claim = await claimActive(p.root, id);
  if (claim.status === "busy") {
    throw new PreconditionError(
      `${claim.holder.changeId} is the active change; finish or abort it before rewording ${id}`,
    );
  }
  if (claim.status === "running") {
    throw new PreconditionError(`${id} is being driven by pid ${claim.holder.pid}; stop it first`, [
      "wait for it to pause, or run `ai-factory abort <id>`",
    ]);
  }
  const dir = specDir(p, run.draft);
  if (!existsSync(join(dir, "openspec", "changes", id))) {
    throw new PreconditionError(`${id}'s spec folder is gone`, [
      "the change was archived or removed; there is nothing left to reword",
    ]);
  }
  const branch = await currentBranch(dir);
  if (branch !== changeBranch(id)) {
    throw new PreconditionError(
      `the spec of ${id} must be on ${changeBranch(id)}, but ${dir} is on ${branch ?? "a detached HEAD"}`,
      [`switch ${dir} to ${changeBranch(id)} before retrying`],
    );
  }
  return { run, dir };
}

/** Reads the change's spec files the way `implement.specText` does, from any spec dir. */
function readSpec(dir: string, id: string): string {
  const base = join(dir, "openspec", "changes", id, "specs");
  if (!existsSync(base)) return "";
  const out: string[] = [];
  const walk = (d: string, rel: string): void => {
    for (const name of readdirSync(d).sort()) {
      const abs = join(d, name);
      if (statSync(abs).isDirectory()) walk(abs, `${rel}${name}/`);
      else if (name.endsWith(".md"))
        out.push(`### specs/${rel}${name}\n${readFileSync(abs, "utf8").trim()}`);
    }
  };
  walk(base, "");
  return out.join("\n\n");
}

/** Every file under the change folder, so a failed session can be rolled back byte-for-byte. */
function snapshotSpec(dir: string, id: string): Map<string, Buffer> {
  const base = join(dir, "openspec", "changes", id);
  const files = new Map<string, Buffer>();
  const walk = (d: string, rel: string): void => {
    if (!existsSync(d)) return;
    for (const name of readdirSync(d)) {
      const abs = join(d, name);
      const next = rel === "" ? name : `${rel}/${name}`;
      if (statSync(abs).isDirectory()) walk(abs, next);
      else files.set(next, readFileSync(abs));
    }
  };
  walk(base, "");
  return files;
}

function restoreSpec(dir: string, id: string, snapshot: Map<string, Buffer>): void {
  const base = join(dir, "openspec", "changes", id);
  const current = new Set<string>();
  const walk = (d: string, rel: string): void => {
    if (!existsSync(d)) return;
    for (const name of readdirSync(d)) {
      const abs = join(d, name);
      const next = rel === "" ? name : `${rel}/${name}`;
      if (statSync(abs).isDirectory()) walk(abs, next);
      else current.add(next);
    }
  };
  walk(base, "");
  for (const rel of current) {
    if (!snapshot.has(rel)) rmSync(join(base, rel), { force: true });
  }
  for (const [rel, content] of snapshot) {
    const abs = join(base, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

/** Path → content hash of every file git reports as changed or untracked. */
async function fingerprint(dir: string): Promise<Map<string, string>> {
  const split = (text: string): string[] => text.split("\0").filter((x) => x !== "");
  const tracked = split(await gitOk(["diff", "--name-only", "-z", "HEAD", "--"], { cwd: dir }));
  const untracked = split(
    await gitOk(["ls-files", "--others", "--exclude-standard", "-z"], { cwd: dir }),
  );
  const out = new Map<string, string>();
  for (const rel of new Set([...tracked, ...untracked])) {
    const abs = join(dir, rel);
    out.set(
      rel,
      existsSync(abs) && statSync(abs).isFile()
        ? createHash("sha1").update(readFileSync(abs)).digest("hex")
        : "missing",
    );
  }
  return out;
}

function touchedSince(before: Map<string, string>, after: Map<string, string>): string[] {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].filter((path) => before.get(path) !== after.get(path));
}

async function revert(dir: string, path: string): Promise<void> {
  const inHead = (await git(["cat-file", "-e", `HEAD:${path}`], { cwd: dir })).code === 0;
  if (inHead) await gitOk(["checkout", "-q", "HEAD", "--", path], { cwd: dir });
  else {
    await git(["rm", "-q", "--cached", "--ignore-unmatch", "--", path], { cwd: dir });
    rmSync(join(dir, path), { force: true, recursive: true });
  }
}

/** Rolls a failed attempt back: the change folder from the snapshot, everything else to HEAD. */
async function rollback(
  dir: string,
  id: string,
  snapshot: Map<string, Buffer>,
  before: Map<string, string>,
): Promise<void> {
  restoreSpec(dir, id, snapshot);
  for (const path of touchedSince(before, await fingerprint(dir))) await revert(dir, path);
}

function dag(dir: string, id: string): ParsedTask[] {
  const file = join(dir, "openspec", "changes", id, "tasks.md");
  if (!existsSync(file)) return [];
  return parseTasks(readFileSync(file, "utf8")).tasks;
}

/** The task plan at an approved commit, when that file exists there. */
async function approvedDag(dir: string, id: string, commit: string): Promise<string | undefined> {
  const res = await git(["show", `${commit}:openspec/changes/${id}/tasks.md`], { cwd: dir });
  if (res.code !== 0) return undefined;
  return dagSignature(parseTasks(res.stdout).tasks);
}

/** What `reword` must not change: ids, repos, deps and touches (titles are wording). */
function dagSignature(tasks: readonly ParsedTask[]): string {
  return tasks
    .map((t) =>
      [t.id, t.repo ?? "", (t.deps ?? []).join(","), (t.touches ?? []).join(",")].join("\t"),
    )
    .join("\n");
}

async function diff(
  p: Pipeline,
  dir: string,
  id: string,
  range: string | undefined,
): Promise<void> {
  const args = ["diff", "--no-color", ...(range === undefined ? [] : [range]), "--", specPath(id)];
  const out = (await git(args, { cwd: dir })).stdout.trimEnd();
  if (out === "") return;
  p.out(capText(out, 400, `(diff truncated; run git ${args.join(" ")} in ${dir})`));
}

async function restamp(
  p: Pipeline,
  id: string,
  dir: string,
  specCommit: string,
  reason: string,
): Promise<Approval> {
  const prior = readApproval(p.root, id);
  if (prior === undefined) throw new PreconditionError(`${id} is not approved`);
  const entry: ApprovalHistoryEntry = {
    hash: prior.hash,
    specCommit: prior.specCommit,
    at: prior.approvedAt,
    reason,
  };
  const approval: Approval = {
    changeId: id,
    approver: prior.approver,
    specCommit,
    hash: specHash(dir, id),
    approvedAt: now(),
    history: [...(prior.history ?? []), entry].slice(-MAX_HISTORY),
  };
  writeApproval(p.root, approval);
  return approval;
}

/** Validates the change as `approve` would; throws when it no longer holds. */
async function validate(p: Pipeline, dir: string, id: string): Promise<void> {
  const check = await checkDesign(
    p.root,
    dir,
    id,
    p.codeRepos().map((r) => r.name),
    p.config.contracts,
  );
  if (check.issues.length > 0) throw new PreconditionError(`${id} does not validate`, check.issues);
}

/**
 * Accepts the spec as it is on disk: validates it, commits the change folder and re-stamps the
 * approval. The run's tasks are left untouched. `--dry-run` validates and shows the diff only.
 */
export async function reapprove(
  p: Pipeline,
  id: string,
  options: { readonly dryRun?: boolean } = {},
): Promise<ReapproveResult> {
  const { run, dir } = await assertRewordable(p, id);
  const prior = readApproval(p.root, id);
  if (prior === undefined) throw new PreconditionError(`${id} is not approved`);
  await validate(p, dir, id);
  const approved = await approvedDag(dir, id, prior.specCommit);
  if (approved !== undefined && approved !== dagSignature(dag(dir, id))) {
    throw new PreconditionError(`reapprove cannot change the task plan of ${id}`, [
      "the approved task ids, repos, deps and touches must stay the same; start a new change for a new plan",
    ]);
  }

  if (options.dryRun) {
    p.out(`▶ reapprove ${id} (dry run)`);
    await diff(p, dir, id, prior.specCommit);
    p.out(`${id}: nothing was committed or re-stamped`);
    return { changed: false, approval: prior, specCommit: prior.specCommit };
  }

  const commit = await commitPaths(dir, [specPath(id)], `docs(spec): reword ${id}`, {
    "Change-Id": id,
  });
  const specCommit =
    commit ?? (await gitOk(["log", "-1", "--format=%H", "--", specPath(id)], { cwd: dir })).trim();
  if (specCommit === "") throw new PreconditionError(`nothing committed for ${specPath(id)}`);
  const hash = specHash(dir, id);
  if (hash === prior.hash) {
    // The human explicitly accepts the spec as it is; any recorded findings are resolved.
    if (run.specFindings.length > 0) {
      await p.update(id, (d) => {
        d.specFindings = [];
      });
      p.out(
        `✓ ${id}: the spec is unchanged; cleared ${run.specFindings.length} spec finding${run.specFindings.length === 1 ? "" : "s"}`,
      );
      p.out(`next: \`ai-factory resume ${id}\``);
    } else {
      p.out(`✓ ${id}: the spec is unchanged; the approval is still valid`);
    }
    return { changed: false, approval: prior, specCommit: prior.specCommit };
  }
  const approval = await restamp(p, id, dir, specCommit, "manual re-approval");
  await p.update(id, (d) => {
    d.specFindings = [];
  });
  appendLog(p.root, id, {
    kind: "reapprove",
    approver: approval.approver,
    specCommit,
    hash: approval.hash,
    previous: prior.hash,
  });
  p.out(`▶ spec changes accepted:`);
  await diff(p, dir, id, `${prior.specCommit}..HEAD`);
  p.out(
    `✓ re-approved ${id} (spec ${specCommit.slice(0, 12)}, hash ${approval.hash.slice(0, 12)})`,
  );
  p.out(`next: \`ai-factory resume ${id}\``);
  return { changed: true, approval, specCommit };
}

/**
 * Lets the architect revise the change's wording from review findings (or a prompt). The task
 * DAG must not change, the result must validate, and the approval is re-stamped. On any
 * failure the spec is restored and the findings stay recorded.
 */
export async function reword(
  p: Pipeline,
  id: string,
  options: RewordOptions = {},
): Promise<RewordResult> {
  const { run, dir } = await assertRewordable(p, id);
  const prior = readApproval(p.root, id);
  if (prior === undefined) throw new PreconditionError(`${id} is not approved`);

  const findings = options.findings ?? run.specFindings;
  const request = options.request?.trim() ?? "";
  if (findings.length === 0 && request === "") {
    throw new PreconditionError(`${id} has no spec findings to reword`, [
      `pass an instruction: \`ai-factory reword ${id} --prompt "..."\``,
    ]);
  }
  const dirty = (await git(["status", "--porcelain", "--", specPath(id)], { cwd: dir })).stdout;
  if (dirty.trim() !== "") {
    throw new PreconditionError(`the spec of ${id} has uncommitted edits`, [
      `commit them, or run \`ai-factory reapprove ${id}\` to accept them`,
    ]);
  }

  const beforeDag = dagSignature(dag(dir, id));
  const snapshot = snapshotSpec(dir, id);
  const before = await fingerprint(dir);
  p.out(
    `▶ reword: ${findings.length} finding${findings.length === 1 ? "" : "s"}${request === "" ? "" : " + instruction"}`,
  );

  let res: AgentResult;
  try {
    res = await p.call({
      changeId: id,
      agent: "architect",
      role: "architect",
      modelRole: "architect",
      context: { directory: dir, workspace: dir },
      title: `${id} reword`,
      step: "reword",
      prompt: rewordPrompt({
        id,
        spec: readSpec(dir, id),
        findings,
        ...(request === "" ? {} : { request }),
      }),
    });
  } catch (err) {
    await rollback(dir, id, snapshot, before);
    throw err;
  }

  const problem =
    res.handoff === undefined
      ? (res.problem ?? res.outcome)
      : res.handoff.status === "blocked"
        ? [...res.handoff.openQuestions, ...res.handoff.risks].join("; ") ||
          "the architect is blocked"
        : undefined;
  if (problem !== undefined) {
    await rollback(dir, id, snapshot, before);
    throw new PreconditionError(`the architect could not reword ${id}: ${problem}`);
  }

  const violated = touchedSince(before, await fingerprint(dir));
  const context: SessionContext = {
    sessionId: "reword",
    changeId: id,
    role: "architect",
    directory: dir,
    workspace: dir,
  };
  const violations = auditChanges(context, violated, true);
  if (violations.length > 0) {
    await rollback(dir, id, snapshot, before);
    throw new PreconditionError(
      `the architect edited outside the change's spec`,
      violations.map((v) => `${v.path}: ${v.reason}`),
    );
  }

  if (dagSignature(dag(dir, id)) !== beforeDag) {
    await diff(p, dir, id, undefined);
    await rollback(dir, id, snapshot, before);
    throw new PreconditionError(`the reword changed the approved task DAG`, [
      "a reword may only change wording; a new task plan needs a new change",
    ]);
  }

  try {
    await validate(p, dir, id);
  } catch (err) {
    if (options.dryRun) await diff(p, dir, id, undefined);
    await rollback(dir, id, snapshot, before);
    throw err;
  }

  if (options.dryRun) {
    await diff(p, dir, id, undefined);
    await rollback(dir, id, snapshot, before);
    p.out(`✓ ${id}: dry run; the spec was restored and the findings are kept`);
    return { changed: false, approval: prior, specCommit: prior.specCommit, findings };
  }

  if (specHash(dir, id) === prior.hash) {
    await rollback(dir, id, snapshot, before);
    p.out(`✓ ${id}: the architect made no spec changes; the findings are kept`);
    return { changed: false, approval: prior, specCommit: prior.specCommit, findings };
  }

  const commit = await commitPaths(dir, [specPath(id)], `docs(spec): reword ${id}`, {
    "Change-Id": id,
  });
  if (commit === undefined) {
    await rollback(dir, id, snapshot, before);
    throw new PreconditionError(`the reword could not be committed; the spec was restored`);
  }
  const specCommit = commit;
  const approval = await restamp(p, id, dir, specCommit, "reword: review findings applied");
  const applied = new Set(findings.map(findingKey));
  let remaining: Finding[] = [];
  await p.update(id, (d) => {
    remaining = d.specFindings.filter((f) => !applied.has(findingKey(f)));
    d.specFindings = remaining;
  });
  appendLog(p.root, id, {
    kind: "reword",
    specCommit,
    hash: approval.hash,
    previous: prior.hash,
    findings: findings.length,
    remaining: remaining.length,
    files: violated.filter((path) => path.startsWith(`${specPath(id)}/`)),
  });
  p.out("▶ spec changes applied:");
  await diff(p, dir, id, `${prior.specCommit}..HEAD`);
  p.out(
    `✓ reworded ${id} (spec ${specCommit.slice(0, 12)}, hash ${approval.hash.slice(0, 12)}, ${findings.length} finding${findings.length === 1 ? "" : "s"})`,
  );
  if (remaining.length > 0)
    p.out(
      `${remaining.length} finding${remaining.length === 1 ? "" : "s"} remain; run \`ai-factory reword ${id}\` again`,
    );
  else p.out(`next: \`ai-factory resume ${id}\``);
  return { changed: true, approval, specCommit, findings: remaining };
}
