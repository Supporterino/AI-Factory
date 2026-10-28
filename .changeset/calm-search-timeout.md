---
"@supporterino/ai-factory": patch
---

Fix the factory-side issues found in the Clarion run:

- add a `websearch` config (default `{ "provider": "random" }`) and render it into opencode, so a headless run no longer waits a minute on the interactive web search provider prompt and then reports `Web search cancelled`
- let implementers edit the repository's test files even when a task's `touches` omits them, and tell the architect to include test files in `touches`
- add `runtime.turnTimeoutMinutes` (default 60, up from 30) and pass it to the opencode runtime
- allow read-only Homebrew queries such as `brew --prefix` and recursive searches over OS-managed trees (`/Applications`, `/System`, `/Library`, `/usr`, `/opt`)
