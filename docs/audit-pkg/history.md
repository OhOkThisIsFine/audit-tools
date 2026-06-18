# History

This page keeps short archival context that used to live in several
phase-specific documents. It is not the current roadmap or release gate.

## Field-trial lessons

Earlier real-repository runs surfaced issues around:

- completion detection
- worker launch failures
- result ingestion validation
- command hangs without progress
- requeue task explosion
- evidence schema ambiguity
- noisy runtime placeholders
- weak root-cause clustering
- missing work-block presentation
- unenforceable reviewed ranges

Most of those findings have dedicated regression coverage now. The durable
lesson is that failure states should be explicit, schema validation should be
field-level, and packetization should optimize for coherent review context
rather than raw worker-count reduction alone.

## Remediation baseline

The old remediation baseline recorded fixes across:

- CI and release smoke coverage
- extractor path handling
- schema-contract validation
- orchestration state handling
- provider and supervisor behavior
- CLI and IO robustness
- reporting and synthesis behavior
- generated install payload parity

Current readiness is tracked in `docs/product.md`, `docs/operator-guide.md`,
`docs/contracts.md`, `docs/release.md`, and `docs/development.md`.

## Monorepo migration & drift reconciliation (2026-05 → 2026-06)

The auditor and remediator began as standalone repos (`auditor-lambda`,
`remediator-lambda`) and were merged into this npm-workspaces monorepo on a
shared `@audit-tools/shared` foundation. `providers/` and `quota/` had been
copy-pasted into both tools and forked in place; the ten resulting drift bugs
were all fixed by centralizing the forked logic into `shared` (one source of
truth). Durable decisions from that work:

- **Access scoping is JSON, not MCP.** `AccessDeclaration` rides on the step
  contract, so it works with any host; the MCP servers stay compatibility
  adapters over the same contract.
- **`--dangerously-skip-permissions` defaults ON for the remediator, OFF for the
  auditor.** The remediator applies changes unattended and cannot pause; the
  auditor is read-only. The asymmetry is intentional and the flag is overrideable.
- **The remediator's machine input is `audit-findings.json`, not the Markdown
  report.** `audit-report.md` is human-facing; a Markdown file handed to the
  remediator flows through the free-form LLM extractor, not a deterministic parse.
- **Prompts use one strict path** — no "or / unless / if-available" fallbacks.

Large files were then broken up as behaviour-preserving pure moves (`cli.ts` from
4072 lines to a thin dispatcher plus `src/cli/*` handlers; `graph.ts`,
`reviewPackets.ts`, `internalExecutors.ts`, and the generated language table all
split out). The sprint-by-sprint handoff docs that tracked this work were removed
once shipped; this section is their durable residue.
