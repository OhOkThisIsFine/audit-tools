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

`session-config/` holds one example `session-config.json` per supported provider (`claude-code`,
`opencode`, `local-subprocess`, `subprocess-template`, `vscode-task`, plus `auto` and per-model
variants).
