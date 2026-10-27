---
"@supporterino/ai-factory": patch
---

Support opencode 2.2.0. The supported range is now `>=2.1.2 <2.3.0`; 2.2.0 is tested alongside 2.1.2, and `update` refreshes the lock's tested pin.

opencode 2.2.0 now exposes MCP/plugin tools directly when `execute` is denied (which every factory agent does). Each tool's own permission still applies, so `mcp.roles` works as documented, but a global `allow` for an MCP action can expose a tool the role did not list.
