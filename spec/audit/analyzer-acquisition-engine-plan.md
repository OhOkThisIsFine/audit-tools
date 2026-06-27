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

- **A — array artifact model. ✅ DONE (commit f5097e72).** `external_analyzer_results: ExternalAnalyzerResults[]`;
  every consumer iterates; `upsertExternalToolResults` merges producers by tool id. Behaviour-preserving.
- **B — binary runner + acquisition seam. ✅ DONE (commit c2a467a2).** `binary` EcosystemRunner +
  `binaryAcquisition.ts` `resolveBinary`: PATH → cache → pinned GitHub-release download, checksums.txt SHA256-verify
  BEFORE extract (system `tar`), cache, chmod. Injectable fetcher; `resolveBinaryCandidates` async pre-pass records a
  status for every binary that didn't resolve. `binary-acquisition.test.mjs`.
- **C — candidate registry + gitleaks. ✅ DONE (commit 7c393409).** `EXTERNAL_ANALYZER_CANDIDATES`: gitleaks
  (binary, default-on, pinned 8.21.2, `gitleaks dir … --report-format json`, raw Secret/Match dropped) + semgrep
  (pipx) + eslint (npx) consent-gated. secret-scan removed from `OWNED_TOOL_IDS` (only git-history owned). Engine
  reportFile() seam (read a file instead of stdout). `analyzer-candidates.test.mjs`.

- **D — production wiring. ⏳ REMAINING.** New marker artifact `external_analyzer_acquisition.json` +
  `runExternalAnalyzerAcquisitionExecutor(bundle, root, opts)` (async): `resolveBinaryCandidates` →
  `runAcquisitionEngine` → upsert results into `external_analyzer_results`; write marker. New obligation
  `external_analyzers_current` in `state.ts`/`nextStep.ts`, placed AFTER `file_disposition`, BEFORE
  `structure_artifacts` (graph/risk/planning consume the results). Dependency-map: marker deps
  `{repo_manifest, file_disposition}`. **Hermeticity gate (decided):** the executor is a NO-OP that writes an empty
  marker UNLESS acquisition is explicitly enabled via an advance option (`externalAcquisition: {enabled, fetch,
  consentToken}`) — the real CLI entrypoint sets `enabled:true` + a global-`fetch` adapter; unit/integration tests
  leave it off, so no subprocess/network runs in the suite (only the enabled CLI path probes/downloads/executes
  gitleaks). This keeps the 2400-test suite hermetic and protects the trap-prone staleness chain.
- **E — surface + close. ⏳ REMAINING.** Confirm gitleaks findings reach `audit-findings.json` via `mergeFindings`
  external evidence (security lens) on an enabled run. Docs (HANDOFF/backlog), memory
  (`deterministic-analyzers-own-vs-acquire`, `live-status`), delete this plan doc, ship.

## Invariants to preserve

- Degrade-to-empty + report-skipped-never-silently (one `ExternalAnalyzerToolStatus` per candidate).
- No network in tests — fetcher injected.
- Pinned version + checksum verify before executing a downloaded binary (supply-chain safety).
- OS/platform-agnostic: os/arch mapping + cache path through the existing path/exec abstractions.
- Single spawn-admission chokepoint (`admitSpawn`) + run-safety gate unchanged.
