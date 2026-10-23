# ADR-0021: Usage reporting

**Context.** §11 asks for token usage per agent, task, retry and change, reported in `status` and the final report and never enforced. opencode reports per-session `tokens{input,output,reasoning,cache{read,write}}` and `cost`, verified end to end.

**Decision.**
- **Source.** The runtime takes each turn's usage as the difference of the session's counters before and after the prompt. Rate-limit resumptions and the handoff repair add to the same turn. No provider metadata is parsed.
- **Ledger.** Every agent session appends one entry to `.factory/usage/<id>.json` under a lock: agent, model, step (task id or `intake`/`design`/`explore:<repo>`/`context-packs`/`review:<repo>`/`contract-review`), kind (`attempt` with its number, `conflict`, or `step`) and usage. The intake runs before the id exists and is recorded once the id is known.
- **Totals.** "Tokens" means everything the model processed: fresh input, cache reads, cache writes, output and reasoning. Cache reads are also shown on their own, because they are cheaper. Cost is opencode's figure and reads `cost n/a` when no price is configured.
- **Retry overhead** is attempts after the first plus conflict resolutions. Design repair rounds count towards `design`.
- **Wasted re-reads** are the plugin's `waste` log entries (repeated reads of an unchanged file in one session).
- **Where it shows.**
  - `status` prints the total, the split by agent, the retry overhead and the wasted re-reads, plus tokens per task.
  - `status --json` adds the full summary per change.
  - Both reports end with a `## Usage` section: totals, a by-agent table with shares and cost, the top five consumers, the retry overhead and the wasted re-reads.
- **Never blocking.** Nothing reads the ledger to make a decision. `tokens.mode` stays `"report"`.
