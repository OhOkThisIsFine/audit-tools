# Mechanical analyzer layer — activation, consent surfacing, re-verify loop

Design of record for the four-item program that turns the external-analyzer layer from
built-but-dormant into a first-class evidence source, and closes the detect → fix → verify loop.
Planned 2026-08-06 from an owner discussion; items are unimplemented until this doc's program is
worked. Remove or condense this doc once the program ships (durable outcomes then live in the code,
contract tests, and project memory).

## Why

The acquisition machinery (candidate registry, `admitSpawn` chokepoint, results artifact, staleness
cascade, per-task packet lead injection) is fully built — and mostly idle. Only gitleaks carries
`defaultRun: true`; every other registered analyzer (jscpd, osv-scanner, semgrep, eslint, knip,
clippy, rubocop, hadolint, actionlint, type-coverage) requires a per-run consent token that the
tool **never offers to the operator**. Applicable-but-unconsented candidates are silently skipped —
a silent-fail-closed defect by the project's own standard (a choice that exists but is never
surfaced is host-discretion, not tool guarantee).

Owner-set admission lens: **overhead + safety, not lack-of-evidence**. Fast + safe + may-produce-
leads → default set. Repo-code-execution or network-egress risk → consent-gated, but *offered*.

## Decided against (do not re-propose without new evidence)

- **ast-grep**: rule engine with no shipped ruleset — zero leads unless we own a rule catalog,
  which is the banned hand-maintained table. Semgrep (registered, someone-else-maintained registry
  rules) occupies the niche. Revisit only with a concrete rule semgrep cannot express.
- **PMD CPD**: JVM acquisition overhead; duplicate of jscpd's signal, would need its own lead-dedup.
- **Tree-sitter universal-CST normalization layer**: the engine is language-agnostic and wasm
  grammars are acquired data, but the per-grammar node-type→category normalization mappings are
  hand-maintained per-language tables that drift with grammar versions. Its unique slice (Type-3
  structural clones) sits between jscpd (Type-1/2) and the LLM lens (Type-3/4 semantic). If dogfood
  evidence ever shows that slice mattering, prefer acquiring a maintained multilingual clone
  detector before building this.
- **MinHash/shingle near-dup for docs/config**: no consumer; jscpd covers code-shaped duplication.
- **osv-scanner as default**: owner call — dependency-identity egress to OSV.dev stays an explicit
  per-run decision. (Offline-DB mode was considered and not taken.)

## Item A — default set derived from recorded safety criteria

Safety facts become per-candidate DATA; `defaultRun` eligibility derives from them mechanically.

- `AnalyzerSafetyProfile` on the candidate contract (`src/audit/extractors/analyzers/`
  `acquisitionEngine.ts`, beside `ExternalAnalyzerCandidate`):
  `{ config_execution: "none" | "inert-data" | "executable", network_egress: boolean,
  version_pinning: "pinned" | "toolchain-resolved" | "unpinned" }`.
<!-- doc-citation-exempt: planned test file — created when item A is implemented -->
- Contract-test rule (new `tests/audit/candidates-safety.test.ts`): `defaultRun: true` requires
  `config_execution !== "executable" && !network_egress && version_pinning === "pinned"`; every
  candidate carries a profile; no version-less npx/pipx spec.
- Expected promotions: hadolint, actionlint, type-coverage; jscpd **conditional** on verifying its
  config loading cannot execute repo code (cosmiconfig-style `.jscpd.js` search would disqualify —
  mitigate by forcing an explicit inert config in `buildArgv` if precedence allows, else stay
  gated). Stay gated: eslint (executable config), knip (`.ts`/`.js` config), rubocop
  (`require:` in `.rubocop.yml`), clippy (build scripts), semgrep, osv-scanner (egress).
- Pin semgrep (`spec: "semgrep==<version>"`) regardless — `runSafetyGate` only checks non-empty
  spec, so `"semgrep"` passes today while pinning nothing. clippy/rubocop are inherently
  `toolchain-resolved` (cargo/bundle) — recorded as such, part of why they stay gated.
- Carry `RunTrackedResult.duration_ms` into `ExternalAnalyzerToolStatus` so per-analyzer overhead
  is measured, not argued (pipeline-profiling posture).

## Item B — surface the consent offer

The silent skip becomes an operator question; the **decision** persists, the **token** stays
per-run.

- New obligation `external_analyzers_consent_current` in the PRIORITY array
  (`src/audit/orchestrator/nextStep.ts`) immediately before `external_analyzers_current`.
  Executor: `detect()` over consent-gated candidates; applicable + no recorded decision → one
  batched operator-interactive step (drain halts; remediate `clarification_request` precedent).
  Nothing undecided → satisfied silently.
- Offer is tool-rendered (never host improvisation): per candidate — what it detects, its safety
  profile (why it isn't default), exact accept mechanism.
- Session config gains `analyzer_consent: Record<candidateId, "granted" | "declined">`. Decisions
  persist; tokens never do (consistent with the standing forward constraint on token redaction).
  Declined persists; re-offer only when a new candidate id has no recorded decision.
- `admitSpawn` admission becomes: default set ∨ recorded `granted` ∨ per-run token. This
  **deliberately revises the CE-005 analyzer contract** pinned by
  `tests/audit/analyzer-acquisition-engine.test.ts` ("permanent pre-installed non-default tool
  still needs the token") — the old rule guarded a consent that was never offered. Test revised in
  the SAME commit (atomic-replace). Open sub-question, flag at implementation: whether a per-run
  token overrides a recorded `declined` (default: yes — fresher, explicit signal).

## Item C — mechanical re-verify loop (remediation close)

Findings born from analyzer leads are closed by the same analyzer re-run — verification by tool,
not host claim. The one place mechanical output is authoritative rather than a lead: "the lead no
longer fires" is a fact.

1. **Engine relocation (one core, two draws):** acquisition substrate (`admitSpawn`,
   `runSafetyGate`, runner probe/spawn plumbing, candidate + safety-profile contracts) moves to
   `src/shared/analyzers/`; `src/audit/extractors/analyzers/` keeps the concrete candidate registry
   and audit-side orchestration (read draw); remediate imports the shared substrate (verify draw).
   No remediate→audit import. One atomic move commit.
2. **Provenance join:** `AnalyzerLeadProvenance` `{analyzer_id, rule, path, snippet_hash}` —
   content-anchored (hash of the normalized flagged snippet), never line numbers (edits shift
   lines). Attached at normalization (`src/audit/adapters/normalizeExternal.ts`), carried task
   signal → `AuditResult` → finding → `extracted-plan.json` item via the existing id-join
   architecture. Optional everywhere.
3. **Close integration:** new closing action `verify_analyzer_leads`
   (`src/remediate/state/closingActions.ts` + handler in `src/remediate/phases/close.ts`): group
   provenance-carrying resolved items by analyzer; re-run same pinned spec through the shared
   engine (admission still via `admitSpawn`; an audit-time grant covers the verify draw), scoped to
   lead file set ∪ files touched by the fix. **Instance-level semantics:** pass = that provenance
   identity no longer appears; a clone pair is fixed when that pair is gone — residual findings
   elsewhere in the file do not fail it.
4. **Outcome routing:** per-item `verified_mechanically` / `lead_persists` in the outcomes
   contract; a persisting lead does not hard-block close — it routes the item to triage as
   objective evidence.
5. Value scales with A+B (few default analyzers → few provenance-carrying findings) — sequenced
   last partly for that reason. Run `/design-check` before implementing (shared-contract +
   loop-core-adjacent; re-checks the CE-005 revision and the relocation against retired decisions).

## Item D — Lizard candidate

Multi-language complexity leads (NLOC / CCN / param count). Fills the gap that in-tree complexity
metrics (`computeComplexityMetric`) are JS/TS-only — non-JS/TS repos currently get zero complexity
evidence.

- `runner: "pipx"` (semgrep precedent), pinned `lizard==<version>`, parse CSV/XML →
  `ExternalAnalyzerResultItem` (`category: "maintainability"`, rules `lizard-ccn` /
  `lizard-length` / `lizard-params`, severity by threshold bands — leads only).
- **Precedence policy:** runs only over languages the in-tree metric does NOT cover — `detect()`
  fires when non-JS/TS supported sources exist; `buildArgv` restricts via Lizard `-l` filters. One
  signal source per file class; no double-reporting, no new dedup machinery.
- Profile: `config_execution: "none"`, no egress, pinned → default-eligible under the item-A rule;
  ship `defaultRun: true`.

## Sequencing & verification

**A → B → D → C**, green at every commit. New contract tests red-green validated where they pin
behavior changes (CE-005 revision; close-verify). End-to-end smoke: mixed-language fixture repo
through `audit-code next-step` — consent offer surfaces gated candidates once; default analyzers
(gitleaks + promotions + lizard) run tokenless with `duration_ms` recorded; analyzer signals appear
in a dispatch packet. Then a seeded remediation carrying jscpd provenance through close →
`verify_analyzer_leads` passes/fails correctly.
