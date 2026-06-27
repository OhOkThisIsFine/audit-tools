# Analyzer acquisition engine — wiring plan (gitleaks + default set)

> Working plan for the lap that pulls the from-scratch secret detector (reverted in `a10b79cd`)
> and instead makes the EXISTING acquisition engine (`src/audit/extractors/analyzers/acquisitionEngine.ts`,
> built+tested but **zero production callers** — the same built-but-unwired trap git-history had) actually
> run mature ecosystem-native tools, with **gitleaks** as the first secret scanner. Delete this doc when shipped.

## Decisions (Ethan, 2026-06-27)

- **Scope:** gitleaks **+ the value-curated default set** (gitleaks + semgrep + eslint) wired end-to-end.
- **Artifact model:** `external_analyzer_results` becomes **`ExternalAnalyzerResults[]`** (array — honest per-tool
  provenance/status), replacing the single object. Ripples through ~10 consumers (graph ownership/edges, risk,
  planning, structure, synthesis, taskBuilder, syntaxResolution, ingestion, packetPrompt, import command).
- **gitleaks acquisition:** probe `gitleaks version` on PATH → if present, run it; **if absent, DOWNLOAD the
  pinned release binary for this OS/arch, verify SHA256, cache, then run** (do NOT skip). Default-run (no consent
  prompt) — high-value, low-overhead. Acquisition fetcher is INJECTABLE so tests never hit the network.
- **Own-vs-acquire reversal:** secret-scan is no longer OWNED — drop `secret-scan`/`secrets`/`secret-scanner`
  from `OWNED_TOOL_IDS`; only `git-history*` stays owned.

## Slices (each green: `npm run build && npm run check` + touched tests)

- **A — array artifact model.** `external_analyzer_results: ExternalAnalyzerResults[]`. Every consumer iterates;
  no behaviour change (single-element array preserves today's output). Pure refactor + test updates.
- **B — binary runner + acquisition seam.** New `binary` `EcosystemRunner`; `runnerProbeArgv`/`runnerPrefix`
  extended. Acquisition seam `acquireBinary(tool, version, os/arch, { fetch })`: PATH-probe → pinned GitHub-release
  download → SHA256 verify → cache under tool-cache dir → return resolved path. Injectable `fetch`/runner; pinned
  version + checksum table (pinning a TOOL version is required for reproducibility — NOT the model-hardcode ban).
  Unit tests with a fake fetcher (present-on-PATH, absent→download, checksum-mismatch→degrade).
- **C — candidate registry + adapters.** `EXTERNAL_ANALYZER_CANDIDATES` (gitleaks binary default-on; semgrep pipx;
  eslint npx). `gitleaks` parse adapter (`gitleaks detect --report-format json` → generic items → security
  findings). Verify semgrep/eslint adapters already exist (they do). Remove secret-scan from `OWNED_TOOL_IDS`.
- **D — production wiring.** New executor `runExternalAnalyzerAcquisitionExecutor` + obligation
  `external_analyzers_current`, placed in the nextStep chain BEFORE `structure_artifacts` (graph/risk/planning
  consume it). Writes `external_analyzer_results.json` (array). Dependency-map + staleness registration. Consent
  token sourced from session config (`analyzers.<id>` settings); default set runs without it.
- **E — surface + close.** Confirm gitleaks findings reach `audit-findings.json` via `mergeFindings`/`externalSummary`
  (security lens). Docs (HANDOFF/backlog), memory (`deterministic-analyzers-own-vs-acquire`, `live-status`), ship.

## Invariants to preserve

- Degrade-to-empty + report-skipped-never-silently (one `ExternalAnalyzerToolStatus` per candidate).
- No network in tests — fetcher injected.
- Pinned version + checksum verify before executing a downloaded binary (supply-chain safety).
- OS/platform-agnostic: os/arch mapping + cache path through the existing path/exec abstractions.
- Single spawn-admission chokepoint (`admitSpawn`) + run-safety gate unchanged.
