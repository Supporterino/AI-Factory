# ADR-0025: Standards are grounded in primary sources

**Context.** The first language standards were written from general knowledge, cited nothing, and mixed idioms with factory constraints. For example, "Rust unit tests in `tests.rs`" only exists because the tester may edit test files and nothing else; the Book's idiom is an inline `mod tests`.

**Decision.**
- **Sources.** Each `templates/standards/<id>.md` is written from the language's primary docs: the official guides, the project's own style and review guides, and the docs of the test tools in use. Blogs don't count. The sources go in a `<!-- Sources: [key] Title — URL -->` block under the title.
- **Citations.** Every section after `## Summary` starts with a `<!-- [key] section names -->` comment. Rules that come from the factory (worktree discipline, the tester's file scope, gates, scenario-named tests, untrusted-input rules a source does not state) end with `<!-- factory -->`.
- **Tested.** `test/render.test.ts` checks that sources are listed, that every section cites listed keys, and that no comment reaches a prompt.
- **Prompts.** `renderStandard(profile, { comments: false })` strips the comments for agent prompts and `AGENTS.md`. The rendered `.opencode/standards/*.md` files keep them for people.
- **How they were written.** One research pass per language read the sources and drafted the standard; the result was reviewed against the factory's gates and edit scopes.

**Consequences.**
- **Size.** Standards grew to about 110–135 lines each (about 2–2.4k tokens). A stacked Tauri + React implementer carries about 8.7k tokens of standards, in the cached part of its system prompt.
- **Corrections.** Grounding fixed real errors:
  - Tauri app commands need no capability unless they are listed in `AppManifest::commands`.
  - Tauri state uses `std::sync::Mutex` by default and is not wrapped in `Arc`.
  - Go never discards errors with `_`.
- **Maintenance.** A rule without a source must be marked as a factory rule or removed. Adding a language means citing its sources (README, "Adding a language profile").
