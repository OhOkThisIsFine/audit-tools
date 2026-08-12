# Mechanical analyzer layer — shipped program + standing refusals

The four-item program (A: safety-derived default set, B: consent surfacing, D: lizard candidate,
C: mechanical re-verify at remediation close) has durable outcomes that live in the code and its
contract tests; this doc keeps only what is not derivable from them: the decided-against list and
the two recorded design deviations. Which release carried which item is git's job, not this doc's.

Where the shipped mechanisms live:

- Safety profiles + admission (`admitSpawn`: default ∨ recorded `granted` ∨ per-run token) and the
  acquisition engine: `src/shared/analyzers/acquisitionEngine.ts` (relocated from the audit tree —
  one core, two draws). Candidate registry + parse adapters: `src/shared/analyzers/candidates.ts`.
- Consent surfacing: the `analyzer_consent` step kind (`src/audit/cli/steps.ts`), emitted while
  resolving the `external_analyzers_current` obligation; decisions persist under `analyzer_consent`
  in `.audit-tools/audit/analyzer-policy.json` (`src/shared/analyzerPolicy.ts`); tokens never persist.
- Lead provenance: `src/shared/analyzers/provenance.ts` — `{analyzer_id, rule?, path,
  snippet_hash}`, snippet-hash over the normalized flagged span (content identity, not layout);
  attached at `src/shared/analyzers/normalizeExternal.ts`, carried packet lead → finding
  (`analyzer_provenance`) → remediation via the finding id-join.
- Close-verify: `src/remediate/phases/closeVerifyAnalyzerLeads.ts`, a close-gate verify leg in
  `runClosePhase` — instance-level identity match over a same-pinned-spec re-run; per-item
  `mechanical_verification` (`verified_mechanically` / `lead_persists` / `skipped`) in the
  outcomes contract; a persisting lead re-blocks only its item and routes to triage.

## Recorded design deviations (from the original item-C text)

1. **The candidate registry moved to shared too** — the verify draw re-runs "the same pinned
   spec", which requires the candidate definitions (`spec`/`buildArgv`/`parse`); keeping them
   audit-side would force a banned remediate→audit import or a forked copy. Audit keeps
   orchestration and re-exports through `src/audit/extractors/analyzers/registry.ts`.
2. **`verify_analyzer_leads` is a close-gate verify leg, not a `CLOSING_ACTIONS` entry** — that
   enum is the operator's one-per-plan repo-landing choice; verification sits beside the
   combined-suite / deferred-verify / e2e legs (design-check catch, confirmed by the independent
   refutation lane).

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
