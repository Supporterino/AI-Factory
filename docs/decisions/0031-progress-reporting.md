# ADR-0031: Progress output while the pipeline runs

**Context.** Implementation is the longest phase, and it used to be almost silent: `approve`
printed a banner and then only `✓ <task> merged` lines. Agent sessions, gate runs and
dependency installs could take many minutes each, so a healthy run looked like a hang, and a
failing run only explained itself in the pause report. The runtime already consumed
opencode's SSE stream (`GET /api/event`) for permission handling and discarded everything
else, although opencode 2.1.2/2.2.0 emit tool, step and usage events.

**Decision.**
- **Lifecycle lines.** Every agent call prints a start line (task title, agent, model,
  attempt) and an end line (outcome, duration, tokens). The scheduler emits task events
  (started, retry, failed, merging, merged, conflict, requeued, transient, interrupted,
  waiting) to the same renderer; the runner adds gate and dependency-install lines.
- **Heartbeat.** While sessions, gates or installs are running, one line every 30 s lists
  what is active, for how long, the last tool call and the session's step tokens. This
  covers long agent turns and long test gates without streaming everything.
- **Detail levels.** `--verbose` adds one line per tool call, gate start and finished gate;
  `--quiet` keeps banners, merges, failures and the summary. The default is `normal`.
  Failed tool calls are shown in normal mode too. The flags are per command, not config
  (ADR-0028: defaults are code).
- **Event mapping.** `SessionSpec.onActivity` is an optional display callback. The runtime
  maps `session.tool.input.started/called/success/failed`, `session.step.started/ended` and
  `session.retry.scheduled` defensively: optional fields, unknown types ignored, exceptions
  swallowed, and only events of sessions this CLI created. Activity is never persisted (the
  plugin's redacted tool log remains the record).
- **Tool details.** Only a command or path is shown (first matching field), capped at 100
  characters and passed through the existing redaction. File contents (`content`,
  `oldString`, `newString`, patches) are never printed, and assistant text is not streamed.
- **Plain output.** Lines are appended, never rewritten with cursor movement, so redirecting
  the CLI to a log keeps every line. There is no color and no TTY-only behavior.
- **Watching from another terminal.** `ai-factory status --watch [--interval <s>]` reprints
  the existing status view; it clears the screen on a TTY and separates frames with a
  `---` header when piped.

**Consequences.**
- Output volume stays bounded: one line per session, per retry, per merge and per slow or
  failing gate, plus one heartbeat line per 30 s. `--verbose` is the opt-in firehose.
- Progress cannot change scheduling: scheduler callbacks are wrapped in try/catch, the
  runtime swallows callback errors, and no code path reads progress state.
- The event names and payloads are opencode internals. They are read as optional fields, so
  an older or newer server degrades to fewer lines rather than failing a session; the
  heartbeat still reports elapsed time.
- Tests drive the same code with a scripted runtime (`ScriptStep.activity`) and an SSE stub,
  so progress rendering, the scheduler events and the event mapping are covered without a
  real model.
- E2E transcripts in `docs/e2e/` gain lines and are regenerated with the existing script.
