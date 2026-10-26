# ADR-0020: Contract gate and contract review

**Context.** §7 step 9 asks for a deterministic compatibility gate per touched contract, plus one cross-repo LLM review. The kinds are OpenAPI, proto, JSON Schema and Helm `values.schema.json`.

**Decision.**
- **Built-in diffs, no extra toolchain.** All diffs are pure TypeScript (`src/contracts/`), so the gate runs anywhere the CLI runs. It compares the provider's contract at the change base with `change/<id>`.
- **OpenAPI 3.**
  - A diff is breaking for:
    - removed operations (path parameters are normalised, so a renamed `{id}` is not a change);
    - new or newly required parameters, and a newly required request body;
    - removed media types and removed `2xx`/`default` responses.
  - Schemas are compared by direction. Request schemas must not narrow (types, enums, required properties, tighter limits, closed objects). Response schemas must not widen or drop guarantees (removed or no-longer-required properties, new types or enum values).
  - Swagger 2 is skipped with a note.
- **JSON Schema and Helm values** use the "input" direction. For Helm, the chart's `values.yaml` and `ci/*-values.yaml` are also validated against the new schema with ajv (draft 2020-12, or draft-07 when declared).
- **Proto.** A small parser covers messages (nested, oneof, map), enums, services and `reserved`. These break:
  - removed fields or enum values that were not reserved;
  - changed field type, label or name (the JSON form changes);
  - removed messages, services or RPCs, and changed RPC signatures.
- **Consumer validation.**
  - For OpenAPI, consumer sources that still mention a path the new contract dropped are reported.
  - An optional per-consumer `validate` command (`{contract}` = path of the new contract) runs in the consumer's checkout under the check-only guard.
- **Policy.** A breaking change fails the gate unless the contract sets `allowBreaking: true`. Consumer issues always fail.
  - A failing gate gets one round of `contract-<provider>-<round>-<n>` fix tasks (provider side, the gate output as the context pack).
  - If the gate still fails, the change pauses, because the break may be intended (set `allowBreaking`).
- **Contract review.** Once the gate passes, one `contract-reviewer` session (read-only, workspace root) gets the gate results and `git -C <repo> diff <base>..change/<id>` commands. It runs once per change. `must`/`should` findings become `contract-review-<n>` fix tasks in the repo the finding's path points to.
- **Config.** `contracts[].allowBreaking` and `contracts[].validate` are optional, additive fields, so they needed no schema version of their own (the config is at `schemaVersion` 2 for another reason, ADR-0022).
