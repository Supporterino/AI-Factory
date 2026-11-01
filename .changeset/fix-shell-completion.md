---
"@supporterino/ai-factory": patch
---

Fix zsh and bash completion passing the whole command line as a single word, which broke flag and file completion after a command name. Pressing Tab on an empty word after a command now also offers its flags (but not after `--`).
