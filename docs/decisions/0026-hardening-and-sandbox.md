# ADR-0026: Enforcement hardening and the OS sandbox

**Context.** The 2026-10-26 audit (docs/audit/2026-10-26.md) found 10 ways around the safety rules:
- arbitrary programs run through git's env, config and options;
- shell keywords and `cd` the parser did not follow;
- `xargs` and interpreter evasions;
- `git fetch` refspecs that delete branches;
- symlinks and in-place editors writing outside the worktree, and macOS case variants of protected paths;
- gates running agent code with the user's credentials;
- the server password visible to agent shells;
- agent commits hiding files from the audit.

Every one of them passed through the shell parser, because a parser can only judge what a command says, not what the programs it starts do.

**Decision.**
- **Parser fixes:**
  - `if`/`while`/`until`/`function`/`coproc` heads are parsed. `cd`/`pushd`/`env -C` are tracked, and subshells keep the parent's directory.
  - `xargs` either appends its literal input or may feed unknown input only to read-only commands.
  - `bash -c --`, `-s`, `<` input and `exec -a` are parsed.
  - Interpreters fed through stdin, here-docs or `<` files are scanned.
  - Program-running awk/sed features, schedulers and runners are blocked.
- **git:**
  - No `GIT_*`, pager, editor, loader, `HOME`, `PATH` or `BASH_ENV` assignments.
  - `-c` takes presentation keys only.
  - No `--upload-pack`/`--receive-pack`/`--exec`, `grep -O`, `difftool` or `archive --remote`.
  - `fetch` names a remote, with no refspecs or force options.
  - All config write forms are blocked.
  - `git commit` is blocked: the factory commits.
- **Paths:**
  - Writes, `rm` and the plugin's edit/read tools are judged on real paths (symlinks resolved, dangling ones followed).
  - `ln` is checked at both ends.
  - More writers are covered: `perl`/`ruby -i`, `curl -o`, `wget -O`, `tar -C`/`-f`, `unzip -d`, `zip`, `-t DIR`, `sort -o`, `git rm`/`mv`, `--output`.
  - The workspace is never writable through a temp-dir allowance.
  - Protected and secret paths match case-insensitively.
- **Agent commits.** The CLI records `HEAD` before each session. If `HEAD` moved, the CLI soft-resets back to it and logs it, so the audit sees every change. The audit uses the real approval check.
- **Session context.** The plugin pins each session's context at first read and refuses everything if the file changes mid-session.
- **Every shell spawn is guarded.** opencode 2.1.2 calls the plugin's `shell` hook `create.before` with `{command, cwd, shell, env}` before spawning any shell (found in the binary, verified end to end). The plugin:
  - only lets commands its `execute.before` guard approved spawn, which refuses opencode's REST `/api/shell`;
  - deletes the server password, model keys and forge tokens (`AI_FACTORY_SCRUB`) from the shell's environment;
  - wraps the command in the sandbox.

  The factory's server also refuses agents that are not factory agents.
- **OS sandbox (macOS `sandbox-exec`, `security.sandbox: "auto"`).** A Seatbelt profile per shell and per gate. Everything is allowed except:
  - writes into the workspace outside the session's own directories (the worktree, or the architect's change and context folders);
  - inside those, writes to factory files and `.git`, with git's index and objects (and, for gates, `.factory/cache`) writable again;
  - writes to shell rc files, git, ssh and opencode configuration, LaunchAgents and PATH bin directories;
  - reads of credential files (`~/.ssh`, `~/.aws`, `~/.kube`, `~/.config/gh`, `~/.netrc`, `~/.npmrc`, `~/.git-credentials`, keychain files, …);
  - executing `git-credential-*` helpers;
  - outbound TCP to port 22.

  HTTPS, temp dirs and tool caches stay usable. Probes showed that blocking the Keychain service breaks Node's TLS, so the credential-helper rule is used instead.
- **Gates and installs.**
  - Both run with the user's environment minus credentials, plus the push block.
  - Gates also run sandboxed. Installs are not sandboxed, so registry credentials keep working.
  - A task that changes a script or target its gates run (named in `gates.scripts`, in package.json, a Makefile, justfile or Taskfile) fails its attempt until it reverts the change.

**Consequences.**
- **Verified:**
  - The probes are tests (`test/hardening.test.ts`); 4 of them were already blocked and stay pinned.
  - The sandbox profile is tested on macOS (`test/sandbox.test.ts`).
  - A real-opencode run confirmed the hook: scrubbed password, `.factory` writes refused.
  - Both E2E transcripts were re-recorded with sandboxed shells and gates. Go `-race` tests, caches and git in worktrees work.
- **Not covered:**
  - **No sandbox outside macOS.** Linux (bwrap or landlock) is future work, and `doctor` warns there.
  - **Planted tools.** A tool planted in a gitignored bin dir can fake a gate result, though it can't push or reach state.
  - **Reachable writes.** Writes elsewhere under `$HOME` and in temp directories are allowed.
  - **Tokens in remote URLs.** A remote URL with an embedded token still allows a push if every other layer fails.
  - **Case-sensitive permissions.** opencode's permission rules match case-sensitively.
  - **Agents can't add global tools or commit.** Tasks that need to change gate definitions must be done by a person.
- **New config key.** `security.sandbox` (`"auto"` | `"off"`). It was added with a default, so no migration was needed.
