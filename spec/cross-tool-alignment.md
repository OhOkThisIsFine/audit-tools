# Cross-tool alignment — the shared boundary contract

The contract shared by `audit-code` and `remediate-code` — implemented once in
`audit-tools/shared`, stated once here. The companion workflow designs
([`audit-workflow-design.md`](audit-workflow-design.md),
[`remediation-workflow-design.md`](remediation-workflow-design.md)) point here
rather than restating it.

- **Shared host-handoff guarantees.** Both tools emit complete provider-neutral
  work, bind prompts and result paths before execution, validate returned
  records as untrusted input, and make accepted replay idempotent. Their domain
  payloads differ; containment, binding, and content-addressed evidence rules
  stay aligned.
- **`free_form_intent` interpretation parity.** Interpret-don't-thread is the
  rule in both tools — interpret intent to shape weighting, priority, and scope
  signals; never thread it verbatim into worker prompts. The interpretation
  logic (intent → priority/lens weighting) is a shared concern.
- **Prompt-caching principle.** Shared context first, agent-specific payload
  last — applies identically to auditor workers, design-review agents, the
  synthesis narrative, and remediation seam-negotiation agents.
- **Token estimation** uses the shared byte-based `estimateTokensFromBytes`.
- **Audit findings as remediation seed (Path A).** Remediation's contract
  pipeline consumes `audit-findings.json` to seed goal normalization. The
  findings contract must stay rich enough for that — stable IDs, affected
  files with line evidence, lens/severity, theme links — through any
  audit-side refactor.
- **Pinned shared seam contracts.** Session intent, affinity/coherence
  artifacts, provider-agnostic execution records, and the `free_form_intent`
  interpreter are pinned/versioned seam contracts, validated through real
  consumers.
