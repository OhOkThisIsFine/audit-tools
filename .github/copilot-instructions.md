> **Start with [`CLAUDE.md`](../CLAUDE.md).** Project goals, the concepts that tie the auditor and remediator together, conventions, and a standing-decisions log live there — check the decision log before asking the user which approach to take.

<!-- audit-code:begin -->
## /audit-code
When the user enters `/audit-code`, treat it as this repository's autonomous audit workflow.
If your host does not automatically register the installed slash command file, load and follow [the repo-local audit directive](../.audit-code/install/audit-code.import.md).
Normal usage should stay conversation-first and avoid manual `--root`, provider flags, or model-selection arguments.
<!-- audit-code:end -->

<!-- remediate-code:begin -->
## /remediate-code
When the user enters `/remediate-code`, treat it as this repository's autonomous remediation workflow.
If your host does not automatically register the installed slash command file, load and follow [the repo-local remediate directive](../.remediate-code/install/remediate-code.import.md).
Normal usage should stay conversation-first and avoid manual `--root`, provider flags, or model-selection arguments.
<!-- remediate-code:end -->
