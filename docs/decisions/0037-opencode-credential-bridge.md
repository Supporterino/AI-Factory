# ADR-0037: Stored opencode credentials for the private server

**Context.** The factory starts one private `opencode serve` per run with
`OPENCODE_DB=.factory/opencode/opencode.db` (ADR-0001), so the user's sessions are never
touched. opencode 2.x keeps the credentials written by `opencode auth login` in the
`credential` table of its SQLite database (2.2 imports the legacy `auth.json` once). Relocating
the database therefore hid those credentials from the factory: only provider environment
variables reached the server, and `doctor` reported configured models as unavailable even
though the user had authenticated.

**Decision.**
- At every server start, after the private server is ready, the runtime reads the user's
  stored credentials with `opencode auth export` using the user's environment (never the
  private `OPENCODE_DB`), and keeps only integrations named by `models` or an explicit
  `websearch.provider`. Ambient credentials (for example `GITLAB_TOKEN`) do not enable extra
  providers.
- The scoped credentials are reconciled into the private server through `/api/credential`
  (`GET`, `POST`, `DELETE`, `POST …/activate`). Presence is authoritative: credentials the
  user logged out of, or whose provider is no longer configured, are removed. Rotated API keys
  are replaced. OAuth and external credentials already in the private DB are kept, because
  the private server may hold a refreshed token; an expired copy is replaced only when the
  user's copy has a later expiry. The user's active account is preserved.
- The bridge is best effort. A failed export or an opencode version without the credential
  API is logged as an `auth` entry and the run continues on environment credentials. It never
  blocks a run.
- The private DB stays at `.factory/opencode/opencode.db` (gitignored). Because it now holds a
  copy of credentials, `.factory/opencode` is a secret path for the shell parser, glob/grep,
  the opencode permission rules and the macOS sandbox. `OPENCODE_DB` is scrubbed from agent
  shells and gates. No credential is written to tracked files.
- `doctor` performs the same export and imports the scoped credentials into its throwaway
  database before `opencode models`, so the model check matches what the runtime sees. It
  reports the number of stored credentials and their provider ids, never their values.

**Consequences.**
- `opencode auth login`, `auth switch` and `auth logout` reach the factory on the next run.
- The user keeps one credential store; the factory does not create a separate account.
- Credentials exist at rest in the private DB while it is used. Deleting
  `.factory/opencode/opencode.db` forces a fresh import (and discards the local session
  history). The file is protected like `.env` and is never committed.
- A project-specific provider configured only in `opencode.json` still works without stored
  credentials, as before; the bridge simply has nothing to import for it.
