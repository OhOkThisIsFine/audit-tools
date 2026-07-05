# Examples

This directory holds:

- example manifests
- example findings
- example coverage matrices
- example audit tasks
- example audit results
- example external analyzer results
- example audit plan metrics

Review packets are never persisted — they're partitioned JIT at dispatch (see `CLAUDE.md`) — so there
is no example for them.

`session-config/` holds example `session-config.json` files for several providers (`claude-code`,
`opencode`, `local-subprocess`, `subprocess-template`, `vscode-task`, plus `auto` and per-model
variants). The remaining backends — `codex`, `openai-compatible`, `antigravity` — are configured the
same way (a `<provider>` block under the provider key; see the config shapes in
`src/shared/types/sessionConfig.ts` and the provider notes in the repo `CLAUDE.md`); example files for
them are not yet bundled here.
