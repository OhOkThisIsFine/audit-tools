# External analyzer adapters

Adapters normalize output from acquired external tools into the shared `ExternalAnalyzerResults` /
`ExternalAnalyzerGraphEdge` contracts, through the common normalization seam in
`src/shared/analyzers/normalizeExternal.ts`.

Implemented:

- `semgrep.ts` — SAST results (plus dataflow-trace graph edges)
- `astGrep.ts` — ast-grep structural matches (graph edges)
- `codeql.ts` — CodeQL SARIF dataflow queries (graph edges)
- `eslint.ts` — JS/TS lint diagnostics
- `npmAudit.ts` — npm dependency vulnerabilities
- `coverageSummary.ts` — test coverage summaries

The generic normalize seam plus the clippy/rubocop parse adapters live in `src/shared/analyzers/`
with the acquisition substrate — both orchestrator draws consume them there.

Secret scanning is ACQUIRED, not owned — it's the default-run `gitleaksCandidate` member of the
F5 analyzer-acquisition-engine's curated candidate registry (`src/shared/analyzers/candidates.ts`),
normalized through the acquisition engine's own seam rather than this directory's per-tool adapters.
Git-history mining (F6) is the one deterministically-*owned* analyzer signal (own-vs-acquire — see
the **Own-vs-acquire analyzer engine** decision in [`CLAUDE.md`](../../../CLAUDE.md), implemented by
[`candidates.ts`](../../shared/analyzers/candidates.ts) and
[`acquisitionEngine.ts`](../../shared/analyzers/acquisitionEngine.ts)) — by design it has no file here.

Adapter rule:

- parse tool-native output
- normalize into repository schemas
- avoid embedding tool-specific assumptions into downstream prompts when possible
