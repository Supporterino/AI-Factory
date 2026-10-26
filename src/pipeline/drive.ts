import { PreconditionError, TransientError } from "../errors.ts";
import { checkDesign } from "../openspec/cli.ts";
import { claimActive, dequeue, readActive, releaseActive } from "../state/active.ts";
import type { Phase } from "../state/run.ts";
import { verifyApproval } from "./approve.ts";
import { ChangeAborted, type Pipeline } from "./context.ts";
import { contractPhase } from "./contracts.ts";
import { design, specDir } from "./design.ts";
import { close, fullSuite, review, writePauseReport } from "./finish.ts";
import { activate, ensureContextPacks, implement } from "./implement.ts";

/**
 * The pipeline state machine (§7). Every phase is idempotent and its result is persisted, so
 * `resume` can re-enter at the recorded phase after a pause, an abort or a crash.
 *
 *   intake → design → awaiting-approval ⇒ (approve) → queued → implementing ⇄ reviewing
 *          → contracts → full-suite (⇄ implementing for fix tasks) → closing → done
 */

export interface DriveOutcome {
  readonly id: string;
  readonly phase: Phase;
  readonly detail?: string;
}

async function ensureDriver(p: Pipeline, id: string): Promise<void> {
  const claim = await claimActive(p.root, id);
  if (claim.status === "busy")
    throw new PreconditionError(`${claim.holder.changeId} is the active change; ${id} must wait`);
  if (claim.status === "running")
    throw new PreconditionError(`${id} is already being driven by pid ${claim.holder.pid}`);
}

async function setPhase(p: Pipeline, id: string, phase: Phase, reason?: string): Promise<void> {
  await p.update(id, (d) => {
    if (d.abortRequested) return; // `abort` won: the change stays aborted
    d.phase = phase;
    if (reason === undefined) delete d.pausedReason;
    else d.pausedReason = reason;
  });
}

/** Stops an aborted change: it stays aborted and frees the workspace for the next one. */
async function stopAborted(p: Pipeline, id: string): Promise<DriveOutcome> {
  await p.update(id, (d) => {
    d.phase = "aborted";
  });
  if (readActive(p.root)?.changeId === id) await releaseActive(p.root, id);
  return { id, phase: "aborted", detail: "aborted; branches and worktrees are kept" };
}

/** Drives one change as far as it can go; continues with the next queued change on close. */
export async function drive(p: Pipeline, firstId: string): Promise<DriveOutcome> {
  let id = firstId;
  // `resume` of an aborted change is the decision to continue it.
  if (p.run(id).phase === "aborted") {
    await p.update(id, (d) => {
      d.abortRequested = false;
    });
  }
  for (;;) {
    if (p.deps.signal.aborted) return { id, phase: p.run(id).phase, detail: "interrupted" };
    if (p.abortRequested(id)) return stopAborted(p, id);
    try {
      const next = await step(p, id);
      if (next.kind === "stop") return next.outcome;
      id = next.id;
    } catch (err) {
      if (err instanceof ChangeAborted) return stopAborted(p, err.changeId);
      if (err instanceof TransientError) {
        // Outside the scheduler (design, review, contracts): pause, nothing is spent.
        const reason = `the agent runtime failed (${err.message}); fix it and resume`;
        await setPhase(p, id, "paused", reason);
        return { id, phase: "paused", detail: reason };
      }
      throw err;
    }
  }
}

type Step = { kind: "continue"; id: string } | { kind: "stop"; outcome: DriveOutcome };
const go = (id: string): Step => ({ kind: "continue", id });
const stop = (outcome: DriveOutcome): Step => ({ kind: "stop", outcome });

/** Phases that act on the approved spec: each entry re-checks the approval (audit P9). */
const APPROVED_PHASES: ReadonlySet<Phase> = new Set([
  "implementing",
  "reviewing",
  "contracts",
  "full-suite",
  "closing",
]);

/** One phase transition of the state machine. */
async function step(p: Pipeline, id: string): Promise<Step> {
  const run = p.run(id);
  if (APPROVED_PHASES.has(run.phase)) await verifyApproval(p, id, p.root);
  switch (run.phase) {
    case "intake":
    case "design": {
      const result = await design(p, id);
      if (!result.ok) return stop({ id, phase: "paused", detail: result.issues.join("\n") });
      return go(id);
    }
    case "awaiting-approval":
      return stop({
        id,
        phase: run.phase,
        detail: `review openspec/changes/${id}/ and run \`ai-factory approve ${id}\``,
      });
    case "aborted":
      // `resume` after `abort`: implementation continues from where it stopped.
      await setPhase(p, id, run.tasks.length > 0 ? "queued" : "design");
      return go(id);
    case "paused": {
      if (run.tasks.length === 0) {
        // Paused in design: a hand-fixed spec goes to approval, otherwise the architect repairs it.
        const { issues } = await checkDesign(
          p.root,
          specDir(p, run.draft),
          id,
          p.codeRepos().map((r) => r.name),
        );
        await setPhase(p, id, issues.length === 0 ? "awaiting-approval" : "design");
      } else {
        await setPhase(p, id, "implementing");
      }
      return go(id);
    }
    case "queued": {
      const activation = await activate(p, id);
      if (activation.status === "queued")
        return stop({ id, phase: "queued", detail: "waits for the active change to close" });
      if (activation.status === "running")
        return stop({ id, phase: "queued", detail: `already driven by pid ${activation.pid}` });
      return go(id);
    }
    case "implementing": {
      await ensureDriver(p, id);
      await ensureContextPacks(p, id);
      const summary = await implement(p, id);
      if (summary.status === "aborted" || p.deps.signal.aborted) {
        if (p.abortRequested(id)) return stop(await stopAborted(p, id));
        return stop({ id, phase: p.run(id).phase, detail: "interrupted" });
      }
      if (summary.status === "paused") {
        const report = writePauseReport(p, id, summary);
        return stop({ id, phase: "paused", detail: `report: ${report}` });
      }
      await setPhase(p, id, "reviewing");
      return go(id);
    }
    case "reviewing": {
      const { added, incomplete } = await review(p, id);
      if (incomplete.length > 0) {
        const reason = `${incomplete.join("; ")}; resume to review again`;
        await setPhase(p, id, "paused", reason);
        return stop({ id, phase: "paused", detail: reason });
      }
      await setPhase(p, id, added > 0 ? "implementing" : "contracts");
      return go(id);
    }
    case "contracts": {
      const result = await contractPhase(p, id);
      if (!result.ok) {
        await setPhase(
          p,
          id,
          "paused",
          result.reason ?? "the contract gate still fails after a fix round",
        );
        return stop({ id, phase: "paused", detail: result.issues.join("\n") });
      }
      await setPhase(p, id, result.added > 0 ? "implementing" : "full-suite");
      return go(id);
    }
    case "full-suite": {
      const failing = await fullSuite(p, id);
      if (failing.length > 0) {
        const reason = `full suite still failing in ${failing.join(", ")} after fix rounds`;
        await setPhase(p, id, "paused", reason);
        return stop({ id, phase: "paused", detail: reason });
      }
      const pending = p.run(id).tasks.some((t) => t.status === "pending");
      await setPhase(p, id, pending ? "implementing" : "closing");
      return go(id);
    }
    case "closing": {
      await close(p, id);
      const next = await dequeue(p.root);
      if (next === undefined) return stop({ id, phase: "done" });
      p.out(`▶ starting queued change ${next}`);
      return go(next);
    }
    case "done":
      return stop({ id, phase: "done" });
  }
}
