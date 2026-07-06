# External analyzer adapters

Adapters normalize output from acquired external tools into the shared `ExternalAnalyzerResults` /
`ExternalAnalyzerGraphEdge` contracts, through the common normalization seam in `normalizeExternal.ts`.

Implemented:

- `semgrep.ts` — SAST results (plus dataflow-trace graph edges)
- `astGrep.ts` — ast-grep structural matches (graph edges)
- `codeql.ts` — CodeQL SARIF dataflow queries (graph edges)
- `eslint.ts` — JS/TS lint diagnostics
- `clippy.ts` — Rust (`cargo clippy`) diagnostics
- `rubocop.ts` — Ruby (rubocop) diagnostics
- `npmAudit.ts` — npm dependency vulnerabilities
- `coverageSummary.ts` — test coverage summaries

Secret scanning is a deterministically-owned extractor, not an acquired-tool adapter (own-vs-acquire —
see `docs/backlog-remediation-design.md` F5↔F6) — by design it has no file here.

Adapter rule:

- parse tool-native output
- normalize into repository schemas
- avoid embedding tool-specific assumptions into downstream prompts when possible
