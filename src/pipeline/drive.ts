import { PreconditionError } from "../errors.ts";
import { checkDesign } from "../openspec/cli.ts";
import { claimActive, dequeue } from "../state/active.ts";
import type { Phase } from "../state/run.ts";
import type { Pipeline } from "./context.ts";
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
    d.phase = phase;
    if (reason === undefined) delete d.pausedReason;
    else d.pausedReason = reason;
  });
}

/** Drives one change as far as it can go; continues with the next queued change on close. */
export async function drive(p: Pipeline, firstId: string): Promise<DriveOutcome> {
  let id = firstId;
  for (;;) {
    if (p.deps.signal.aborted) return { id, phase: p.run(id).phase, detail: "interrupted" };
    const run = p.run(id);
    switch (run.phase) {
      case "intake":
      case "design": {
        const result = await design(p, id);
        if (!result.ok) return { id, phase: "paused", detail: result.issues.join("\n") };
        continue;
      }
      case "awaiting-approval":
        return {
          id,
          phase: run.phase,
          detail: `review openspec/changes/${id}/ and run \`ai-factory approve ${id}\``,
        };
      case "aborted":
        // `resume` after `abort`: implementation continues from where it stopped.
        await setPhase(p, id, run.tasks.length > 0 ? "queued" : "design");
        continue;
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
        continue;
      }
      case "queued": {
        const activation = await activate(p, id);
        if (activation.status === "queued")
          return { id, phase: "queued", detail: "waits for the active change to close" };
        if (activation.status === "running")
          return { id, phase: "queued", detail: `already driven by pid ${activation.pid}` };
        continue;
      }
      case "implementing": {
        await ensureDriver(p, id);
        await ensureContextPacks(p, id);
        const summary = await implement(p, id);
        if (summary.status === "aborted" || p.deps.signal.aborted) {
          return { id, phase: p.run(id).phase, detail: "aborted; branches and worktrees are kept" };
        }
        if (summary.status === "paused") {
          const report = writePauseReport(p, id, summary);
          return { id, phase: "paused", detail: `report: ${report}` };
        }
        await setPhase(p, id, "reviewing");
        continue;
      }
      case "reviewing": {
        const added = await review(p, id);
        await setPhase(p, id, added > 0 ? "implementing" : "contracts");
        continue;
      }
      case "contracts": {
        const result = await contractPhase(p, id);
        if (!result.ok) {
          await setPhase(p, id, "paused", `contract check failed: ${result.issues.join("; ")}`);
          return { id, phase: "paused", detail: result.issues.join("\n") };
        }
        await setPhase(p, id, "full-suite");
        continue;
      }
      case "full-suite": {
        const failing = await fullSuite(p, id);
        if (failing.length > 0) {
          const reason = `full suite still failing in ${failing.join(", ")} after fix rounds`;
          await setPhase(p, id, "paused", reason);
          return { id, phase: "paused", detail: reason };
        }
        const pending = p.run(id).tasks.some((t) => t.status === "pending");
        await setPhase(p, id, pending ? "implementing" : "closing");
        continue;
      }
      case "closing": {
        await close(p, id);
        const next = await dequeue(p.root);
        if (next === undefined) return { id, phase: "done" };
        p.out(`▶ starting queued change ${next}`);
        id = next;
        continue;
      }
      case "done":
        return { id, phase: "done" };
    }
  }
}
