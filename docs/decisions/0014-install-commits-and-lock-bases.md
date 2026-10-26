# ADR-0014: Install commits and merge bases in the lock

**Context.** `update` needs the old rendered template as the base of a 3-way merge (§10). Storing every rendered file inside the lock would bloat it. `init` and `detect --apply` change committed files in the AI repo.

**Decision.**
- **Merge bases.** Each lock entry stores the `sha256` of the rendered content and the **git blob id** of it, written with `git hash-object -w`. The installing commit makes the blob reachable, so `git cat-file -p <blob>` returns the merge base on every clone.
- **What gets committed.**
  - `init` ends with one local commit, `chore(factory): init vX.Y.Z`.
  - `detect --apply` ends with `chore(factory): apply detected changes (vX.Y.Z)`.
  - Both commit only the install paths (`AGENTS.md`, `.gitignore`, `.graphifyignore`, `.opencode/`, OpenSpec's init files, the config and the lock) and leave other staged work alone.
  - They refuse when those paths already have uncommitted changes. `--no-commit` opts out.
  - The commit uses `--no-verify`: it is machine-generated, and user pre-commit hooks (formatters) would otherwise rewrite managed files and break their hashes.
- **Block-managed files.** `AGENTS.md` and `.gitignore` are managed only between `ai-factory:start/end` markers. The lock hashes the block, and the rest of the file belongs to the user.
- **Conflicts are checked before anything is written.** A file the factory never rendered is a conflict (`--force` overwrites). OpenSpec's generated opencode commands and skills are rendered in a scratch directory and managed like the factory's own files (lock template `openspec-tools`). `openspec init` never runs in the workspace (audit P19). An edited copy from an older install, which has no lock entry, counts as the user's edit.
- **No local state in the lock.** It holds pinned tool ranges, not the versions installed on one machine. Hook state is checked by `doctor`, not recorded.
- **Graph.** `init` checks the Graphify version only. Building the graph joins `init` in slice 9.
