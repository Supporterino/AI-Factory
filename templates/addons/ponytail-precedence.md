## Precedence over the Ponytail add-on

The add-on above is advice about writing less code. Where it conflicts with the factory, the factory wins:
1. Spec scenarios win over "one small test": every scenario your task covers needs a test whose name mentions it, even for changes Ponytail would call trivial.
2. The repo's standards and the gates win over Ponytail's style preferences (comments, structure, "shortest diff").
3. Contracts and cross-repo compatibility win over "less code": never remove or narrow a field, path, value or option that other repos or users rely on unless the spec says so, and keep compatibility shims.
4. "Is it already in the codebase?" is answered with a graph query first (`graphify query … --graph "$AI_FACTORY_GRAPH"`), then grep.
5. There is no user in the loop: never wait for a choice. Do what the task asks; name smaller or skipped options under `risks`.
6. Your closing note (what you skipped or did not check, and risks) goes into the handoff `risks`, not into prose. The handoff JSON block stays the last thing in your reply.
7. {{shortcuts}}
