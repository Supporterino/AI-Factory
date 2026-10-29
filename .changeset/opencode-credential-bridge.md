---
"@supporterino/ai-factory": minor
---

Use the credentials stored by `opencode auth login` in the factory's private opencode server. At startup the runtime exports the user's stored credentials, keeps only the configured providers and imports them into the private database; rotated API keys, `auth logout` and `auth switch` propagate on the next run. `doctor` imports the same credentials into its model check and reports how many it found. The private `.factory/opencode` database is now treated as a secret file, and `OPENCODE_DB` is scrubbed from agent shells.
