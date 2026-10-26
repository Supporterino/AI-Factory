import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ContractResult,
  checkContract,
  summarize,
  touchedContracts,
} from "../contracts/gate.ts";
import type { Finding } from "../handoff/schema.ts";
import { appendLog } from "../logs/log.ts";
import { type RunState, recordTask, TaskState } from "../state/run.ts";
import type { Pipeline } from "./context.ts";
import { packPath } from "./implement.ts";
import { contractReviewPrompt, findingPack, findingTaskTitle } from "./prompts.ts";

/** Contract fix rounds before the change pauses (a breaking change may be intended). */
const MAX_CONTRACT_ROUNDS = 1;

export interface ContractOutcome {
  readonly ok: boolean;
  /** Why the change pauses when not ok (defaults to the contract gate still failing). */
  readonly reason?: string;
  /** Fix tasks added (the pipeline goes back to implementation). */
  readonly added: number;
  readonly issues: string[];
}

function addFixTask(
  p: Pipeline,
  draft: RunState,
  id: string,
  task: { id: string; title: string; repo: string; pack: string },
): void {
  if (draft.tasks.some((t) => t.id === task.id)) return;
  const state = TaskState.parse({
    id: task.id,
    title: task.title,
    repo: task.repo,
    deps: [],
    touches: ["**"],
    kind: "contract-fix",
    status: "pending",
  });
  recordTask(state, "added", "contract-fix");
  draft.tasks.push(state);
  mkdirSync(join(p.root, ".factory", "context", id), { recursive: true });
  writeFileSync(packPath(p.root, id, task.id), task.pack);
}

/**
 * §7 step 9: the deterministic contract gate for every touched contract, then one
 * cross-repo contract-reviewer pass. Gate failures get one round of fix tasks (provider
 * side) before the change pauses; must/should review findings become fix tasks too.
 */
export async function contractPhase(p: Pipeline, id: string): Promise<ContractOutcome> {
  const run = p.run(id);
  const touched = new Set(run.tasks.map((t) => t.repo));
  const contracts = touchedContracts(p.config, touched);
  if (contracts.length === 0) {
    p.out("▶ contracts: none touched");
    return { ok: true, added: 0, issues: [] };
  }

  p.out(`▶ contract gate: ${contracts.length} contract${contracts.length === 1 ? "" : "s"}`);
  const bases = Object.fromEntries(Object.entries(run.branches).map(([repo, b]) => [repo, b.base]));
  const results: ContractResult[] = [];
  for (const contract of contracts) {
    results.push(
      await checkContract(
        {
          root: p.root,
          config: p.config,
          id,
          bases,
          gateOutputMaxLines: p.config.tokens.gateOutputMaxLines,
        },
        contract,
      ),
    );
  }
  for (const r of results) p.out(summarize(r).replace(/^/gm, "  "));
  appendLog(p.root, id, {
    kind: "contract-gate",
    results: results.map((r) => ({
      key: r.key,
      passed: r.passed,
      breaking: r.breaking,
      consumerIssues: r.consumerIssues,
    })),
  });
  await p.update(id, (d) => {
    for (const r of results) d.contractResults[r.key] = { passed: r.passed, summary: summarize(r) };
  });

  const failing = results.filter((r) => !r.passed);
  if (failing.length > 0) {
    const issues = failing.map((r) => summarize(r));
    if (run.contractRounds >= MAX_CONTRACT_ROUNDS) {
      return {
        ok: false,
        added: 0,
        issues: [...issues, "set `allowBreaking` on the contract if the break is intended"],
      };
    }
    await p.update(id, (d) => {
      d.contractRounds += 1;
      failing.forEach((r, i) => {
        addFixTask(p, d, id, {
          id: `contract-${r.contract.provider}-${d.contractRounds}-${i + 1}`,
          title: `Restore compatibility of ${r.contract.kind} contract ${r.contract.path}`,
          repo: r.contract.provider,
          pack: `The contract gate failed for ${r.key}. Keep the change's behaviour but make it compatible for existing consumers (e.g. keep old fields or paths, add new ones alongside), unless the spec says otherwise.\n\n${summarize(r)}\n`,
        });
      });
    });
    return { ok: true, added: failing.length, issues };
  }

  if (run.contractReviewed) return { ok: true, added: 0, issues: [] };
  p.out("▶ contract review");
  const repos = [...new Set(contracts.flatMap((c) => [c.provider, ...c.consumers]))].filter(
    (r) => touched.has(r) || contracts.some((c) => c.provider === r),
  );
  const diffs = repos.map((name) => {
    const repo = p.repo(name);
    const base = run.branches[name]?.base;
    return base
      ? `git -C ${repo.path} diff ${base.slice(0, 12)}..change/${id}`
      : `git -C ${repo.path} log -1`;
  });
  const res = await p.call({
    changeId: id,
    agent: "contract-reviewer",
    role: "contract-reviewer",
    modelRole: "contractReviewer",
    context: { directory: p.root, workspace: p.root },
    title: `${id} contract review`,
    step: "contract-review",
    prompt: contractReviewPrompt({
      contracts: results.map((r) => ({ key: r.key, summary: summarize(r) })),
      diffs,
    }),
  });
  // A contract review without a result is no review: pause, review again on resume (audit P13).
  if (res.handoff === undefined) {
    const reason = `the contract review produced no result (${res.problem ?? res.outcome})`;
    return { ok: false, added: 0, issues: [reason], reason };
  }
  const findings: Finding[] = (res.handoff.findings ?? []).filter((f) => f.severity !== "nice");
  let added = 0;
  await p.update(id, (d) => {
    d.contractReviewed = true;
    if (res.handoff) d.handoffs["contract-review"] = res.handoff;
    findings.forEach((f, i) => {
      const repo =
        p.codeRepos().find((r) => r.path !== "." && f.file?.startsWith(`${r.path}/`)) ??
        p.repo(contracts[0]?.provider ?? "");
      const relFile = f.file && repo.path !== "." ? f.file.slice(repo.path.length + 1) : f.file;
      addFixTask(p, d, id, {
        id: `contract-review-${i + 1}`,
        title: findingTaskTitle({ ...f, ...(relFile ? { file: relFile } : {}) }),
        repo: repo.name,
        pack: findingPack({ ...f, ...(relFile ? { file: relFile } : {}) }),
      });
      added++;
    });
  });
  return { ok: true, added, issues: [] };
}
