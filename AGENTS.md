> **Start with [`CLAUDE.md`](CLAUDE.md).** Project goals, the concepts that tie the auditor and remediator together, conventions, and a standing-decisions log live there — check the decision log before asking the user which approach to take.

<!-- remediate-code:begin -->

## /remediate-code

When the user enters `/remediate-code`, treat it as this repository's
autonomous remediation workflow.
If your host does not automatically register the installed slash command file,
load and follow the global `~/.claude/commands/remediate-code.md`.
Normal usage should stay conversation-first: do not ask the user for provider,
model, input path, or batching flags during normal operation.

When developing inside the `audit-tools` repository itself, prefer
`node remediate-code.mjs` over the globally installed binary.

<!-- remediate-code:end -->

<!-- audit-code:begin -->
## /audit-code
When the user enters `/audit-code`, treat it as this repository's autonomous audit workflow.
If your host does not automatically register the installed slash command file, load and follow [the repo-local audit directive](.audit-code/install/audit-code.import.md).
Normal usage should stay conversation-first and avoid manual `--root`, provider flags, or model-selection arguments.
<!-- audit-code:end -->
