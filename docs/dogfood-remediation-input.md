# Remediation input — dogfood batch (verified-open enforce-in-tooling fixes)

> Source: `docs/backlog.md` (Known friction + contract-pipeline friction sections).
> Curated 2026-06-18 for a `remediate-code` dogfood run, then **narrowed after
> against-source verification**: 6 of the original 10 candidates (the old F1/F2/F3/F4/F9/F10)
> were already shipped and are excluded (the backlog entries were stale). The 4 below are
> verified still-open against current `src`. Each is a self-contained *enforce-in-tooling*
> fix (the property must be guaranteed by the tool, not host discretion — CLAUDE.md).
> Verify each claim against the cited source before changing it; ship each with a red→green test.

## F5 — `parseJsonLoose` can't recover a stray trailing brace; `response_format_json` is opt-in
**Verified open.** `src/shared/providers/openAiCompatibleProvider.ts`:
- `parseJsonLoose` (line ~353) recovers a JSON object via `trimmed.slice(first, last+1)` where
  `last = trimmed.lastIndexOf("}")` (line ~369). When a backend (live NVIDIA NIM `openai/gpt-oss-120b`)
  appends a stray trailing brace (`…}]}}`), `lastIndexOf("}")` grabs the stray brace → `JSON.parse` throws
  → the launch fails `accepted:false`.
- The request body only sets `response_format:{type:"json_object"}` when `this.config.response_format_json`
  is truthy (line ~144) — opt-in, so the default NIM path hits the trailing-brace bug.

**Fix (both halves):**
1. Make `parseJsonLoose` **balance-scan** for the first complete top-level `{…}` object (track brace depth,
   respecting string/escape state) instead of slicing to the last brace — so trailing garbage from ANY backend
   is tolerated. Add a unit test with a `…}]}}` trailing-garbage payload (red→green).
2. Default `response_format_json` **ON** for the `openai-compatible` provider (most OpenAI-compatible endpoints
   support `response_format:{type:"json_object"}`); keep it overridable via config. Test the default.

Shared provider → both orchestrators benefit. Keep the change in `src/shared`.

## F6 — Paired-obligation gate (OBL-CO-01) keyword regex is a hidden contract
**Verified open.** `src/remediate/validation/contractPipelineGates.ts` `validatePairedObligations`
(line ~454): polarity is detected purely by `POSITIVE_ASSERTION_PATTERN` / `NEGATIVE_ASSERTION_PATTERN`
keyword regexes (lines ~430-435). Two defects: (a) the positive pattern omits the literal word "positive"
(the negative pattern includes "negative"), so an explicit `POSITIVE:` label does not satisfy the positive
half; (b) words like "reproduced" don't match `\bproduces\b`. This causes contract-rewrite loops.

**Fix:** recognize an explicit `POSITIVE:` / `NEGATIVE:` label prefix on an assertion as an authoritative
polarity marker (overriding/augmenting the keyword heuristic) — the labels the prompt already implies. Keep
the keyword fallback for unlabeled assertions. Add a test: a spec whose assertions use `POSITIVE:`/`NEGATIVE:`
labels satisfies the gate where it previously failed (red→green). (Mirror the prompt text if it needs to state
the label convention.)

## F7 — S5 seam-derivation gate (INV-CO-12) ignores `seam_adjustments`
**Verified open.** `src/remediate/validation/contractPipelineGates.ts` `validateReconciliationDerivation`
(line ~739): the finalized-contract corpus is built (line ~762) from each module contract's
`inputs|outputs|invariants|side_effects` + `validation_boundary` only — it does NOT scan `seam_adjustments`.
So recording a seam decision in `seam_adjustments` (its natural home) fails the gate; the host must duplicate
the verbatim interface into `outputs`.

**Fix:** include `seam_adjustments` text in the corpus the gate scans (confirm the field's location/shape on the
module contract or resolution first). Add a test: a seam whose `agreed_interface` is reflected only in
`seam_adjustments` now passes the gate (red→green).

## F8 — `validate-artifact` rejects the content-hash-wrapped on-disk form
**Verified open.** `src/remediate/index.ts` `validate-artifact` command (line ~262): it `JSON.parse`s the file
(line ~304) and passes the result straight to the validator. But after `next-step`, every artifact on disk is
the envelope `{artifact_name, content_hash, dependency_hashes, payload}`, so the validator receives the wrapper
(no top-level `contract_version`) and rejects it — to re-validate/re-edit you must manually unwrap `.payload`.

**Fix:** in `validate-artifact`, when the parsed input is a content-hash envelope (has `artifact_name` +
`payload`), auto-unwrap `.payload` before validating; a plain payload still validates as today. Add a test:
validating a wrapped on-disk artifact returns `status:"ok"` (red→green). If audit-code has the same
`validate-artifact` command, mirror the fix (parity).
