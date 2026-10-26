import { existsSync } from "node:fs";
import { join } from "node:path";
import { gitOk } from "../exec.ts";
import { branchAiRepo } from "../git/branching.ts";
import { CHANGE_ID, changeBranch, currentBranch, refExists, revParse } from "../git/repo.ts";
import { graphStatus, updateGraph } from "../graph/graph.ts";
import { checkDesign, newChange } from "../openspec/cli.ts";
import { decisionValues } from "../runtime/handoff.ts";
import { readActive } from "../state/active.ts";
import { loadRun, newRun, saveRun } from "../state/run.ts";
import { recordUsage } from "../usage/usage.ts";
import { ChangeAborted, type Pipeline } from "./context.ts";
import { designPrompt, designRepairPrompt, explorePrompt, intakePrompt } from "./prompts.ts";

/** Directory holding the change's AI-repo checkout: a draft worktree or the workspace root. */
export function specDir(p: Pipeline, draft: string | undefined): string {
  return draft === undefined ? p.root : join(p.root, draft);
}

function slug(text: string): string {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5);
  return words.join("-") || "change";
}

function uniqueId(p: Pipeline, wanted: string): string {
  const taken = (id: string): boolean =>
    loadRun(p.root, id) !== undefined ||
    existsSync(join(p.root, "openspec", "changes", id)) ||
    existsSync(join(p.root, ".factory", "drafts", id));
  let id = wanted;
  for (let n = 2; taken(id); n++) id = `${wanted}-${n}`;
  return id;
}

/**
 * §7 step 1: the AI repo branches before design. If another change occupies the checkout
 * (active, or awaiting approval on its branch), the new change is drafted in its own AI-repo
 * worktree under `.factory/drafts/<id>`, from the commit the occupying change started from.
 */
async function branchForDesign(p: Pipeline, id: string): Promise<{ base: string; draft?: string }> {
  const current = await currentBranch(p.root);
  const occupiedBy =
    readActive(p.root)?.changeId ??
    (current?.startsWith("change/") ? current.slice("change/".length) : undefined);
  if (occupiedBy === undefined) {
    const branched = await branchAiRepo(p.root, id);
    return { base: branched.base };
  }
  // The occupying change may have an uncommitted spec in the main checkout; a worktree does not care.
  const base = loadRun(p.root, occupiedBy)?.branches["."]?.base ?? (await revParse(p.root, "HEAD"));
  const draft = `.factory/drafts/${id}`;
  if (!existsSync(join(p.root, draft))) {
    const args = (await refExists(p.root, `refs/heads/${changeBranch(id)}`))
      ? ["worktree", "add", "-q", join(p.root, draft), changeBranch(id)]
      : ["worktree", "add", "-q", "-b", changeBranch(id), join(p.root, draft), base];
    await gitOk(args, { cwd: p.root });
  }
  return { base, draft };
}

/** §7 step 0: intake by the orchestrator, then the AI-repo branch. Returns the change id. */
export async function intake(p: Pipeline, request: string): Promise<string> {
  p.out("▶ intake");
  const repos = p.codeRepos();
  const result = await p.call({
    changeId: "intake",
    agent: "orchestrator",
    role: "orchestrator",
    modelRole: "orchestrator",
    context: { directory: p.root, workspace: p.root },
    title: "intake",
    step: "intake",
    prompt: intakePrompt(request, repos),
  });
  const values = result.handoff ? decisionValues(result.handoff) : new Map<string, string>();
  const proposed = values.get("change-id") ?? "";
  const id = uniqueId(p, CHANGE_ID.test(proposed) ? proposed : slug(request));
  const likely = (values.get("repos") ?? "")
    .split(/[,\s]+/)
    .filter((r) => repos.some((x) => x.name === r));

  const run = newRun(id, request, "design");
  run.summary = values.get("summary") ?? request;
  run.likelyRepos = likely;
  if (result.handoff) run.handoffs.intake = result.handoff;
  saveRun(p.root, run);
  await recordUsage(p.root, id, {
    at: new Date().toISOString(),
    sessionId: result.sessionId,
    agent: "orchestrator",
    model: result.model,
    step: "intake",
    kind: "step",
    usage: result.usage,
  });

  const draft = await ensureDesignBranch(p, id);
  p.out(`  change ${id}${draft ? ` (drafted in ${draft}; another change is active)` : ""}`);
  return id;
}

/**
 * The AI-repo branch the spec is written on (§7 step 1). Idempotent: a run whose branching
 * failed after intake (a dirty checkout) branches on resume instead of designing on main.
 */
async function ensureDesignBranch(p: Pipeline, id: string): Promise<string | undefined> {
  const run = p.run(id);
  if (run.branches["."] !== undefined) return run.draft;
  const { base, draft } = await branchForDesign(p, id);
  await p.update(id, (d) => {
    d.branches["."] = { branch: changeBranch(id), base };
    if (draft !== undefined) d.draft = draft;
  });
  return draft;
}

/** §7 step 2: explorers in parallel, then the architect, then validation with repair rounds. */
export async function design(p: Pipeline, id: string): Promise<{ ok: boolean; issues: string[] }> {
  await ensureDesignBranch(p, id);
  const run = p.run(id);
  const dir = specDir(p, run.draft);
  const repos = p
    .codeRepos()
    .filter((r) => run.likelyRepos.length === 0 || run.likelyRepos.includes(r.name));

  if (graphStatus(p.root).state !== "ok") {
    p.out("▶ graph: building the workspace graph");
    const built = await updateGraph(p.root, { full: true, changeId: id });
    if (!built.ok) p.out(`  ! graph build failed (agents fall back to grep): ${built.error ?? ""}`);
  }
  p.out(`▶ explore: ${repos.map((r) => r.name).join(", ")}`);
  const explorations: Record<string, string> = {};
  // Explorers are context, not a gate: one that fails is noted, the others still count (P20).
  const settled = await Promise.allSettled(
    repos.map((repo) =>
      p.agents.run(async () => {
        const res = await p.call({
          changeId: id,
          agent: "explorer",
          role: "explorer",
          modelRole: "explorer",
          context: { directory: p.repoDir(repo), workspace: dir, repo: repo.name },
          title: `explore ${repo.name}`,
          step: `explore:${repo.name}`,
          prompt: explorePrompt(repo, run.summary),
        });
        explorations[repo.name] =
          res.handoff?.decisions.slice(0, 40).join("\n") ??
          `(explorer failed: ${res.problem ?? "no handoff"})`;
      }),
    ),
  );
  const failures = settled.flatMap((s) => (s.status === "rejected" ? [s.reason as unknown] : []));
  const aborted = failures.find((e) => e instanceof ChangeAborted);
  if (aborted !== undefined) throw aborted;
  // Every explorer down means the runtime is: the architect would fail the same way.
  if (failures.length === repos.length && failures[0] !== undefined) throw failures[0];
  settled.forEach((s, i) => {
    const name = repos[i]?.name;
    if (s.status === "rejected" && name !== undefined)
      explorations[name] =
        `(explorer failed: ${s.reason instanceof Error ? s.reason.message : String(s.reason)})`;
  });

  p.out(`▶ design: openspec/changes/${id}`);
  await newChange(p.root, dir, id);
  const names = p.codeRepos().map((r) => r.name);
  const result = await p.call({
    changeId: id,
    agent: "architect",
    role: "architect",
    modelRole: "architect",
    context: { directory: dir, workspace: dir },
    title: `design ${id}`,
    step: "design",
    prompt: designPrompt({
      id,
      summary: run.summary,
      request: run.request,
      explorations,
      repos: p.codeRepos(),
      contracts: p.config.contracts,
    }),
    retry: async (_handoff, attempt) => {
      if (attempt > p.config.gates.maxRetries) return undefined;
      const { issues } = await checkDesign(p.root, dir, id, names, p.config.contracts);
      return issues.length === 0 ? undefined : designRepairPrompt(issues);
    },
  });

  const { issues } = await checkDesign(p.root, dir, id, names, p.config.contracts);
  await p.update(id, (d) => {
    if (result.handoff) d.handoffs.design = result.handoff;
    if (issues.length === 0) {
      d.phase = "awaiting-approval";
      delete d.pausedReason;
    } else {
      d.phase = "paused";
      d.pausedReason = `the spec does not validate (${issues.length} issue${issues.length === 1 ? "" : "s"}); fix it and run approve, or resume`;
    }
  });
  return { ok: issues.length === 0, issues };
}
