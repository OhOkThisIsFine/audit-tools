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
