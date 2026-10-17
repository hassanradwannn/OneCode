# Skills in existing chats

ChatGPT and Gemini use the same live discovery contract: read `/skills/.catalog.json`
through OneCode Core, select a relevant returned path, then read and follow its `SKILL.md`.
Ordinary OneCode follow-up turns carry this guidance when Read files is enabled, so newly
installed skills can be discovered without a slash command, connector mention or new chat.
The catalog is read on demand; a prompt does not embed an unselected catalog or skill bodies.

Explicit selections and automatic routing retain their existing frozen revisions and project
scope. Catalog settings, disabled skills and file permissions remain authoritative. A skill
does not add tools or grant permissions. Provider-native chats outside OneCode's delivery path
receive the Core instructions but not the per-turn reminder. Model adherence still depends on
the provider; discovery is verified by a successful tool result, not a prose claim.

Validation covers both providers' opening and existing-chat prompt paths, later installation
and removal in a live catalog, scoped simultaneous chats, disabled catalogs, revoked bindings,
explicit selections and existing automatic skill routing. These changes are source-only until
a new application build is packaged and installed.
