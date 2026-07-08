# Examples

This directory holds:

- example repo/unit manifests
- example file disposition
- example audit state snapshot
- example risk register
- example critical flows + flow coverage
- example coverage matrices
- example audit tasks + requeue tasks (plain + flow-scoped)
- example audit results
- example external analyzer results
- example runtime validation tasks/report/update
- example audit plan metrics

Review packets are never persisted — they're partitioned JIT at dispatch (see `CLAUDE.md`) — so there
is no example for them.

`session-config/` holds example `session-config.json` files for several providers (`claude-code`,
`opencode`, `worker-command`, `subprocess-template`, `vscode-task`, plus `auto` and per-model
variants). The remaining backends — `codex`, `openai-compatible`, `antigravity` — are configured the
same way (a `<provider>` block under the provider key; see the config shapes in
`src/shared/types/sessionConfig.ts` and the provider notes in the repo `CLAUDE.md`); example files for
them are not yet bundled here.
