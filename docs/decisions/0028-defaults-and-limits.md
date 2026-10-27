# ADR-0028: Default models, time limits and the opencode config

**Context.** The 2026-10-26 audit (C) found values that shape every run but were never recorded as decisions: the default model per role, the hard-coded timeouts, the rate-limit parameters, and why `.opencode/opencode.jsonc` holds so little.

**Decision.**
- **Default models** (`init` writes them; you review them in `factory.config.jsonc`):

  | Role                              | Default                       | Why                                                                     |
  | --------------------------------- | ----------------------------- | ----------------------------------------------------------------------- |
  | architect, reviewer               | `anthropic/claude-opus-5-5`   | Spec quality and review depth decide the cost of everything after them. |
  | orchestrator, implementer, tester | `anthropic/claude-sonnet-5-5` | Many sessions; scoped work with gates as the check.                     |
  | explorer                          | `anthropic/claude-haiku-5-5`  | Read-only mapping, fanned out per repo.                                 |

  The bench (`ai-factory bench ponytail`) is how a team checks these on its own code; nothing is tuned from synthetic runs alone.
- **Time limits:**

  | Limit                                          | Value                                       | Where                               |
  | ---------------------------------------------- | ------------------------------------------- | ----------------------------------- |
  | Agent turn                                     | 30 min                                      | `OpencodeRuntime` (`turnTimeoutMs`) |
  | One gate command                               | 15 min                                      | `runGates`                          |
  | One dependency install                         | 15 min                                      | `installDeps`                       |
  | Graph build or update                          | 20 min; the graph lock waits up to 25 min   | `updateGraph`                       |
  | Base-branch fetch before branching a submodule | 60 s, best effort                           | `resolveBranchRef`                  |
  | Any other child process                        | 2 min                                       | `exec`                              |
  | Run-state lock                                 | waits 10 s, breaks a dead or 60 s old owner | `withFileLock`                      |

  A timed-out gate fails its attempt (it spends budget like a failure); a timed-out turn is a failed session. Infrastructure failures never spend budget (ADR-0017). The turn limit is not capped by the HTTP client: the runtime polls opencode's `/wait` in 60 s slices (a slice expiring just polls again), so Node's 300 s `fetch` headers timeout cannot end a healthy turn.
- **Rate limits.** A 429/overload error makes every session of that provider wait: 2 s, doubling to at most 120 s, up to 8 waits per prompt (about 6 minutes in all). After that the prompt fails as an infrastructure failure: no budget is spent, and three in a row pause the change (audit P16). Waits end early when the change is interrupted.
- **`.opencode/opencode.jsonc`** holds only `$schema` and `update: "disable"`. Agents, models and permissions live in `.opencode/agents/*.md` (one file per role, with its own permission rules, ADR-0011); the model is also passed on every session (ADR-0001), so nothing in the config could change what a factory session uses. Provider credentials stay in the user's environment or `opencode auth`, never in the workspace.

**Consequences.** Changing a default is a code change with a CHANGELOG entry, not a silent config drift. The limits are deliberately generous; a slow repo's gates show up as timeouts in the change report rather than hanging a run.
