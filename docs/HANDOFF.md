# HANDOFF — audit-tools

> **Audience:** the next agent instantiation (no memory of the session that produced this).
> **This is the single rolling handoff** (replaces the old per-name `HANDOFF-*.md` convention —
> keep using *this* file; update/trim it as state changes, don't spawn new per-topic handoffs).
> **Last updated:** 2026-06-15 UTC.

---

## 0. TL;DR

0. **MOST RECENT TURN — S7 is now COMPLETE.** S7 **tier-3** (surface quarantined/ungrounded findings:
   `grounding_status_breakdown` + an "Ungrounded Findings (quarantined)" report section + inline ⚠
   marks; plus a grounded-wins merge fix) and S7 **tier-2** (executable anchors: a finding's behavior
   claim ships a read-only `executable_anchor` command the tool runs at ingest, refute→quarantine;
   inspection-only allowlist + 60s timeout + env kill-switch) are IMPLEMENTED + SHIPPED →
   **shared 0.19.0 / auditor-lambda 0.23.0 / remediator-lambda 0.22.0** (CI-green, global bins
   reinstalled, verified live). A **latent S7 tier-1 schema drift** was also fixed
   (`audit_findings.schema.json` lacked `grounding`/`quoted_text` under `additionalProperties:false`).
   See §1e. Commits `3e7a47b` (tier-3) + `a9d6ac2` (tier-2). **S8 (conceptual design review fix) is
   ALSO shipped this turn** → auditor-lambda **0.24.0**, commit `b431367` (§1f): repo-agnostic
   first-principles questions + orient-then-roam + a judging judge + grounded conceptual findings.
   **S5 + S6 (remediate-code) are ALSO shipped this turn** → remediator-lambda **0.23.0**, commits
   `3b39377` (S5 — deterministic structural floor before the adversarial phases) + `94a2c33` (S6 —
   single-source the contract-pipeline contract in the TS validators; deleted the stale JSON schema)
   (§1g). **The contract-authoring determinism roadmap is COMPLETE** (S1/S3/S4/S5/S6 + S7 all tiers
   + S8 done; S2 dropped). **The S7 ingest-anchor parallelization follow-on is ALSO shipped** (later
   turn) → **shared 0.20.0 / auditor-lambda 0.25.0 / remediator-lambda 0.24.0**, commit `4cb75931`
   (§1h): new shared `mapWithConcurrency` grounds findings under a bounded pool (the serial
   sum-of-spawns was genuinely slow — Ethan flagged it; my "rare" deferral was wrong). **Only ONE
   low-priority deferred follow-on now remains: S8 fix 4b** (make the headless empty-auto-complete
   review visible — the path is largely vestigial). Items 1–7 below are prior-turn context (still accurate).

1. **Workflow-robustness remediation (`c6fae403`) is SHIPPED** (prior turn): shared 0.17.3 /
   auditor-lambda 0.21.4 / remediator-lambda 0.18.2, live in the global bins. See §1a.
2. **Contract-authoring determinism S1 + S3 is now IMPLEMENTED + SHIPPED this turn**
   (remediate-code only): the obligation ledger is *derived deterministically* (no longer an LLM
   phase); the test plan and implementation DAG are *skeleton-scaffolded* (the tool pre-fills
   structure/ids, the model fills only judgment slots); and a `validate-artifact` write-time
   validator CLI + a generic per-phase self-check reference land S3. See §1b.
3. **Contract-authoring determinism S7 tier-1 (audit-code) is also IMPLEMENTED + SHIPPED this turn**:
   findings now carry a verbatim `quoted_text` span the tool re-reads from disk and content-matches;
   ungrounded findings are surfaced (not silently admitted); the gameable `total_lines` proof gate is
   demoted to advisory. See §1c.
4. **S4 (single ID authority) IMPLEMENTED + SHIPPED this turn, and S2 DROPPED** — found via a
   **dogfood** of the 0.20.0 pipeline on the determinism work itself: its independent critique caught
   (verified in code) that S2's "wire `repairDownstreamPhases`" premise is redundant with the existing
   staleness DAG, so S2 was dropped + its dead code deleted; S4's id registry kills the merge trap.
   remediator-lambda **0.21.0**. See §1d.
5. **Remaining determinism work:** S5, S6 (remediate-code) + S7 tier-2/3, S8 (audit-code). S2 dropped;
   S1/S3/S4 done. See §2.
6. **Decisions resolved this turn** (hand-implemented S1+S3, S7, S4; dropped S2). The dogfood proved
   the pipeline can improve itself *and* catch a bad plan. See §3.
7. Operational traps the next instance WILL hit are in §4 — read them before any remediate/audit run.

---

## 1. What's implemented & shipped

### 1a. Workflow robustness — `c6fae403` (shipped prior turn)

`/remediate-code` ran on the old workflow-robustness handoff through the full contract pipeline
(9 modules, 86 obligations, 2 adversarial repair rounds, 10-node DAG). Every audit→remediate
correctness property was moved out of host discretion into tooling: tolerant `finding_id`→node
merge, git-diff write-scope enforcement, `NodeDisposition`, rolling per-node dispatch (deleted
`waveScheduler.ts`), tool-owned env-scrubbed final gate (INV-RS-10), coarse re-block backstop,
source-type coverage ledger, `--host-can-dispatch-subagents` true boolean + `--guidance-file`,
fixture-drift guard. **Shipped** as shared 0.17.3 / audit-code 0.21.4 / remediate-code 0.18.2;
global bins reinstalled. (Full module list + carried residuals CE-001/002/003 are in git history
of this file at `c6fae403`; they remain accurate.)

### 1b. Contract-authoring determinism S1 + S3 (this turn — remediate-code)

Implements the first wave of [`docs/contract-authoring-determinism-design.md`](contract-authoring-determinism-design.md):
*the tool owns structure/ids/cross-refs/derivation; the LLM authors only judgment.*

- **S1 flagship — `obligation_ledger` is derived, not authored.** New
  `src/contractPipeline/derive.ts` → `deriveObligationLedger(finalized_module_contracts)`: a pure
  function mapping each module to one **structural** "implement per contract" obligation, each
  module **invariant** to an `invariant` obligation, and each **failure_mode** to a `behavioral`
  obligation (stable ids, `depends_on: []`). Assembled via the shared `buildObligationLedger`
  (single-sourced cycle check + envelope). Wired as an **intercept** in
  `buildNextContractPipelineStep` (`steps/contractPipeline.ts`, after the goal-id gate): when the
  next phase is `obligation_ledger`, the tool derives → `writeContractArtifact` → recurses —
  mirroring the cyclic-seam no-cycles fast path. **The obligation ledger is no longer dispatched as
  an LLM phase.**
- **S1 skeletons + S3 scaffold — `test_validator_plan` & `implementation_dag`.** These keep an
  irreducible judgment slot (assertion text; node title/description/commands), so the tool derives
  their **skeleton** (`buildTestValidatorPlanScaffold` / `buildImplementationDagScaffold` in
  `derive.ts`) — ids/cross-refs filled, judgment fields blank — and injects it into the dispatch
  prompt via the existing `buildPhaseStep(phase, extraSection)` mechanism. The model fills only the
  blanks; it cannot drop, misname, or mis-reference an obligation.
- **S3 write-time validator — `validate-artifact` CLI** (`src/index.ts`): wraps
  `CONTRACT_PIPELINE_VALIDATORS`; `--name <artifact> --file <path>` (or stdin); prints
  `status: ok|error` + issues, exits 0/1. Every contract-pipeline prompt now references it as a
  pre-`next-step` self-check (generic hint in `renderContractPipelinePrompt`).
- **Grounding correction (verified against code, not the doc):** `design_spec` is **legacy/unused**
  — `validateDesignSpecGates` is invoked on `finalized_module_contracts`, whose `invariants` are
  per-module bare strings, so Gate 3 (invariant↔obligation) never fires. Obligations derive from
  `finalized_module_contracts` invariants/failure_modes, **not** a `design_spec`.
- **Tests:** `tests/contract-pipeline-derive-obligations.test.ts` (8: deriver mapping, intercept
  end-to-end, scaffolds, CLI registration). **Green: remediate-code 1521/0; `npm run build` +
  `npm run check` clean.** Shipped as remediate-code **0.19.0** (minor; additive CLI + internal
  derivation — see latest `remediate-code-v*` tag / `npm view`).
- **Carried residuals (know these):**
  - The skeleton scaffold is injected only on the **initial-authoring** dispatch of the two phases,
    not on the judge `proceed_residual` path or the DAG integrity/traceability **repair re-emits**
    (those keep their targeted error guidance). Low stakes; revisit if repair quality lags.
  - The `obligation_ledger` **ROLE** in `contractPipelinePrompts.ts` is now vestigial on the normal
    path (kept for the judge-repair path, where a judge may target `obligation_ledger`, and as shape
    documentation). The intercept only fires when the artifact is **missing**, so a judge-authored
    repair is honored; a `finalized_module_contracts` repair staleness-archives the ledger → it
    **re-derives** from the repaired contracts. This composition is intentional and correct.

### 1c. Contract-authoring determinism S7 tier-1 (this turn — audit-code)

Implements *grounding the claim, not attesting the read* (S7 tier-1) — the cheapest, ungameable,
highest-ROI anti-hallucination win, landable on its own.

- **Findings carry a verbatim span.** `FindingLocation` (shared) gains `quoted_text?` — a verbatim
  span copied from the cited file. The worker prompt (`renderWorkerPrompt.ts`) now requires at least
  one affected-file `quoted_text` per finding.
- **The tool re-reads and content-matches.** New `src/validation/quoteGrounding.ts`
  (`verifyFindingGrounding`): re-reads each cited span from disk and matches on **content**
  (whitespace/CRLF-normalized), not line numbers — so edits that shift lines don't false-fail, but a
  quote naming code that doesn't exist cannot match. Confirmed bit = the tool's re-check, never the
  model's word.
- **Ungrounded findings are surfaced, not admitted.** At ingest (`mergeAndIngestCommand.ts`, Phase
  3.5, repo root = `workerTask.repo_root`) each finding is annotated `grounding: {status, reason}`
  (shared `FindingGrounding`); ungrounded ones (quote not on disk, or no quote) are logged + carried
  with the marker — never silently dropped, never silently confirmed. The worker self-check
  (`validate-result`) runs the same pass (repo root = cwd) so workers fix it before submitting.
- **The gameable gate is demoted.** `file_coverage[].total_lines == disk` (the proof-of-reading
  attestation, `auditResults.ts`) is now an advisory **warning**, not a gating error — it attests
  breadth, is gameable, and proves nothing about truth; quote-and-verify replaces it.
- **Correction (verified in code):** `orchestrator/fileAnchors.ts` is NOT a proof-of-reading remnant
  (the doc conflated it) — it is dispatch-time large-file navigation guidance (symbols/routes/
  keywords), unrelated to grounding, and was **left intact**. The real gameable gate was `total_lines`.
- **Schemas:** `quoted_text` + `grounding` added to **both** `finding.schema.json` (audit-code +
  remediate-code) so grounded findings flow through the pipeline without rejection.
- **Tests:** `tests/quote-grounding.test.mjs` (8) + updated `field-trial-remediation.test.mjs`.
  **Green: audit-code 2129/0, shared 550/0, remediate-code 1521/0.** Shipped as shared **0.18.0** /
  auditor-lambda **0.22.0** / remediator-lambda **0.20.0** (see latest `*-v*` tags).
- **Residual:** ungrounded findings are marked + warned but not yet visually separated in synthesis/
  report (tier-1 surfaces; the report-side quarantine section is the follow-up, see §2).

### 1d. S4 (single ID authority) + the S2/S4 dogfood finding (this turn — remediate-code)

Ran `/remediate-code` (the just-shipped 0.20.0 pipeline) on a scoped S2+S4 brief — **dogfooding the
S1+S3 improvements.** The pipeline ran cleanly through the contract phases (the obligation ledger
auto-**derived**, the test/dag phases carried the **scaffold**, and `validate-artifact` self-checks
appeared in every prompt — all three S1+S3 features confirmed live), and its **independent conceptual
critique caught a blocking design flaw in S2** that a code re-read confirmed (see §2 / the design-doc
S2 banner). Net: **S2 dropped, S4 implemented.**

- **S4 implemented.** New `src/contractPipeline/idRegistry.ts` (`toBlockId` / `fromBlockId` /
  `isBlockId` / `CP_BLOCK_PREFIX`) is the single authority for the `CP-BLOCK-`↔bare-node-id mapping —
  the verified root of the recurring "Unknown finding_id" merge trap. Repointed the three inline
  prefix sites (`promoteImplementationDagToExtractedPlan` ×2: node block_id + dependency edges;
  `buildBlockAliasMap` ×1) to `toBlockId`, and made `collapseItemResults` **registry-first**
  (`fromBlockId` resolves a reported block id deterministically *before* the alias map) — so a node id
  round-trips dispatch→result→merge without the tolerant remap. The remap stays as defence-in-depth
  for non-block aliases (mislabelled obligation ids) only.
- **S2 dropped + dead code deleted.** `repairDownstreamPhases` (+ `CONTRACT_PHASE_SEQUENCE` /
  `ARTIFACT_NAME_TO_PHASE`) in `validation/contractPipelineGates.ts` had **no production caller** and
  was a linear-slice re-run authority inferior to the existing hash-based `DEPENDENCY_MAP` staleness —
  deleted (with an in-code note so it isn't re-added) + its test removed.
- **Tests:** `tests/id-registry.test.ts` (8: registry bijection + the falsifiable "block id resolves
  via the registry with an EMPTY alias map" property the critique asked for). **Green: remediate-code
  1525/0; build + check clean.** Shipped as remediator-lambda **0.21.0** (shared + audit-code
  unchanged). The design doc S2 section carries a verified SUPERSEDED banner.

### 1e. Contract-authoring determinism S7 tier-2 + tier-3 (MOST RECENT turn — audit-code)

Completes S7 (audit-code anti-hallucination). Tier-1 (quote-and-verify, prior turn) proves a finding
*cites code that exists*; tier-2/3 ground *behavior* claims and *surface* what can't be confirmed.

- **Tier-3 — surface quarantined findings (commit `3e7a47b`).** The per-finding `grounding` verdict
  (set at ingest) now survives synthesis into a `grounding_status_breakdown` summary field and a
  dedicated **"Ungrounded Findings (quarantined)"** section in `audit-report.md` + an inline ⚠ mark on
  each ungrounded finding — visually separated, never silently confirmed (the explicit tier-1
  residual). `mergeFindings` gains **grounded-wins** semantics: a grounded re-emission upgrades the
  merged verdict so an ungrounded same-identity twin can't falsely quarantine a finding that
  re-verified on another pass. **Fixed a latent tier-1 schema drift:** `audit_findings.schema.json`
  inlined a finding shape that (under `additionalProperties:false`) lacked `grounding`/`quoted_text`,
  so a grounded report would have failed the synthesis-narrative schema assertion once a fixture
  exercised it — added both + `grounding_status_breakdown`.
- **Tier-2 — executable anchors (commit `a9d6ac2`).** A finding making a *behavior* claim ("no cycle",
  "unused symbol", "throws") may carry an `executable_anchor` `{command, confirm_if, claim?}`. At
  ingest (and in the worker self-check) the tool **runs the read-only command** and folds the verdict
  into `grounding`: a **refuting** run quarantines the finding, a **confirming** run grounds it, an
  inconclusive/skipped run leaves tier-1 in place. The confirmed bit is the tool's run, not the
  model's word — exactly what disproved the hallucinated cycle/const-compare findings in the
  452-self-audit (`madge`/`grep`). **Safety (model-authored command exec is a new trust surface):**
  `src/validation/anchorGrounding.ts` runs anchors only when the executable is on an **inspection-only
  allowlist** (grep/rg/findstr/madge/ast-grep + read-only git subcommands — no node/npm/rm/bare-git,
  nothing with a write/exec flag), under a **60s timeout**, env-stripped, never via a shell;
  off-allowlist → skipped (recorded, not run); `AUDIT_CODE_DISABLE_ANCHORS=1` disables the pass.
- **Tests:** `tests/grounding-surfacing.test.mjs` (4) + `tests/anchor-grounding.test.mjs` (8).
  **Green: shared 550/0, audit-code 2141/0, remediate-code 1525/0.** Shipped as **shared 0.19.0 /
  auditor-lambda 0.23.0 / remediator-lambda 0.22.0** (CI-green, global bins reinstalled, verified live).
- **Residual:** anchors now run under a bounded concurrency pool at ingest (§1h — the serial pass was
  genuinely slow). The allowlist is deliberately tight (inspection-only): a "test fails" claim needing a
  test run is *skipped* (falls back to tier-1 + the adversarial cross-check), per the proportionality caveat.

### 1f. Contract-authoring determinism S8 — conceptual design review fix (this turn — audit-code)

The conceptual design review is the lens meant to catch deep architectural mistakes; it caught none in
the 452-self-audit because the implementation had degraded it. Restored it **repo-agnostically**
(general questions, never project lenses — the design's "lean INTO judgment" exception). Commit
`b431367`; auditor-lambda **0.24.0** (shared/remediate unchanged).

- **First-principles questions (fix 1).** `conceptualCritiqueInstructions()` (designReviewPrompt.ts)
  replaces the narrow library/pattern/simplification checklist with general questions: is the
  fundamental approach right; what core assumption does it rest on, is it sound; where is the deepest
  structural risk; does the structure match the problem; what is it optimizing for; what is missing.
- **Orient-then-roam (fix 2).** The conceptual instructions tell the reviewer to read the project's
  own docs first, then roam the real code freely; the shared reading-list framing
  (`renderSharedStructuralContext`) no longer says "focus only on the highest-risk units."
- **Judging judge (fix 3).** `renderConceptualJudgePrompt` no longer says "you are merging, not
  reviewing" — it evaluates on merit AND flags what every perspective collectively MISSED
  (`(judge-added)`, same evidence + grounding bar).
- **Ground the output (fix 4a).** New `src/validation/designFindingGrounding.ts` (= S7 applied to the
  reviewer): a conceptual/contract finding must cite a real repo component (an `affected_files` path in
  the manifest) or it is marked `ungrounded` and surfaced via the **S7 tier-3 quarantine machinery**.
  Wired into `handleDesignReviewBranch` ingest (was `Array.isArray`-only). No-manifest → pass-through
  (no false-quarantine).
- **Deferred — fix 4b (low priority).** Make the headless `runDesignReviewAutoComplete` empty-skip
  visible (it sets `*_reviewed=true` with `[]` and no LLM call). Deferred because the conversation-first
  product flow ALWAYS runs the review via host_delegation (intercepted in `nextStepHelpers` before
  auto-complete) and the run-to-completion batch loop is gone, so the empty-auto-complete path is
  largely vestigial. If done: set a `*_review_skipped` flag in auto-complete, carry it forward, clear on
  real ingest, and surface it in the report.
- **Tests:** `tests/s8-conceptual-review.test.mjs` (new) + updated `tests/design-review-budget.test.mjs`.
  **Green: audit-code 2146/0.**

### 1g. Contract-authoring determinism S5 + S6 (this turn — remediate-code)

Closes the remediate-code contract-authoring track. Commits `3b39377` (S5) + `94a2c33` (S6);
remediator-lambda **0.23.0** (shared/audit-code unchanged; CI-green, bin reinstalled + smoke).

- **S5 — deterministic structural floor before the adversarial phases.** New
  `evaluatePreCriticStructuralGate` (`src/steps/contractPipeline.ts`) runs the contract-obligation
  structural checks whose inputs all exist by the critic phase — paired-obligation coverage
  (`validatePairedObligations`), source-scoped digest coverage (`validateDigestCoverage`), seam
  reconciliation derivation (`validateReconciliationDerivation`) — as a cheap deterministic floor at
  the critic gate, so the LLM critic/judge only ever see structurally-sound obligations/tests/contracts.
  A gap re-emits the **precise responsible phase** (`test_validator_plan` or `contract_finalization`)
  instead of being discovered only at promotion (after the adversarial budget is spent) and re-emitted
  to the wrong phase (`implementation_planning`, relying on host discretion). Ordering: the design-spec
  gate runs first (its circular-obligation **warning** still reaches the critic as advisory); the floor
  runs once the design artifact is clean. `evaluateContractObligationsPromotionGate` stays the
  fail-closed backstop at promotion (it additionally runs `validateEvidenceThreaded`, which needs the
  judge + DAG and so cannot run pre-critic), so the design-warning + floor-gap edge case is still caught.
- **S6 — single-source the contract-pipeline contract; delete the drift.** `contract_pipeline.schema.json`
  was unused at runtime (`CONTRACT_PIPELINE_VALIDATORS` in `src/validation/contractPipeline.ts` is the
  canonical, runtime-enforced contract) and had drifted (stale `DesignSpec` def + ~6 missing modern
  artifacts). Imperative validators can't be auto-generated into a JSON schema, so a second
  hand-maintained source can only ever drift again → **deleted** the schema + its drift-prone
  `schema-contracts.test.ts` assertions; added a guard test rejecting silent re-introduction. The one
  invariant the schema test guarded (INV-remediate-infra-06: `JudgeRepairDirective.target` enum) is
  already enforced + tested on the TS validator itself (`validation.test.ts`), so no coverage is lost.
- **Tests:** +3 cases in `tests/contract-obligations-and-gates.test.ts` (S5 gate) + an S6 guard test.
  **Green: remediate-code 1521/0.**

### 1h. S7 ingest-anchor parallelization (later turn — shared + audit-code)

The S7 tier-2 grounding pass spawned each finding's anchor command **sequentially** at ingest
(`groundPassingFindings`) and in the worker self-check, so many anchored findings cost the *sum* of
their runtimes — genuinely slow. Ethan flagged it; the earlier "rare / only if it bites" deferral was
wrong (see memory `proportionality-defer-needs-user-signal`). Commit `4cb75931`; **shared 0.20.0 /
auditor-lambda 0.25.0 / remediator-lambda 0.24.0** (remediate republished as a shared dependent).

- New shared primitive `mapWithConcurrency(items, limit, fn)` (`packages/shared/src/concurrency.ts`):
  order-preserving bounded parallel map. Clamps `limit` ≥ 1; empty → `[]`; a rejection propagates.
- `groundPassingFindings` (ingest) and the `validate-result` self-check now ground findings under a
  CPU-derived cap `ANCHOR_GROUNDING_CONCURRENCY` (clamped [2, 8], in `anchorGrounding.ts`): serial
  sum-of-spawns → ~N/cap batches, concurrent spawns capped so the audited machine isn't thrashed. Each
  unit mutates only its own finding and input order is preserved, so the ungrounded list is deterministic.
- Coverage gap caught while doing this: `groundPassingFindings` was never exercised with findings by the
  suite (only the per-finding verifiers were) — exported it + added `tests/grounding-ingest-pass.test.mjs`
  (multi-result flatten → parallel → ordered ungrounded), plus `shared/tests/concurrency.test.mjs`.
  **Green: shared 555/0, audit-code 2147/0, remediate-code 1521/0.**

---

## 2. Forward work — determinism roadmap COMPLETE; residual low-priority follow-ons

Doc: [`docs/contract-authoring-determinism-design.md`](contract-authoring-determinism-design.md).
**Every contract-authoring determinism strategy is now done: S1/S3/S4/S5/S6 + S7 (all tiers) + S8;
S2 dropped (verified redundant).** The S7 ingest-anchor parallelization follow-on also shipped (§1h).
**Only ONE low-priority deferred follow-on remains** — it doesn't block anything (the current path has
a working fallback):
- **S8 fix 4b** — make the headless `runDesignReviewAutoComplete` empty-skip visible (set a
  `*_review_skipped` flag; surface it in the report). Low value: the conversation-first flow always
  runs the review via host_delegation (intercepted before auto-complete) and the batch loop is gone,
  so the path is largely vestigial. Map in §1f / §5.

The per-strategy record (S2–S8) is below for reference:

- **S2 — ⚠️ DROPPED (verified redundant via the S2/S4 dogfood, §1d).** Its headline mechanism ("wire
  the dead `repairDownstreamPhases`") was a **linear phase-slice**, an ad-hoc re-run authority that the
  hash-based `DEPENDENCY_MAP` staleness DAG **already supersedes** (and better) — so the dead
  `repairDownstreamPhases` was **deleted**, not wired. The remaining half (patch-vs-rewrite repair
  shape) is high-complexity/thin-ROI; deferred (an easy lever if repair-token cost ever bites — scope
  to the repair *shape* only, keep the staleness DAG as the downstream authority). See the design doc
  S2 banner.
- **S4 — single ID authority. ✅ DONE (§1d).** New `contractPipeline/idRegistry.ts` owns the
  `CP-BLOCK-`↔bare-node-id mapping (the merge-trap root); promote + dispatch repointed; the tolerant
  remap is now non-load-bearing. (Scoped to the verified problem — the critique corrected the original
  doc: `goal_id` is LLM-authored free-form so it's *adopted*, not minted; obligation ids stay
  deterministic in `derive.ts`. Broader id-minting consolidation was over-reach and dropped.)
- **S5 — structural floor before the adversarial phases. ✅ DONE (§1g).**
  `evaluatePreCriticStructuralGate` runs paired-obligation / digest-coverage / reconciliation-derivation
  checks at the critic gate (after the design-spec gate); a gap re-emits the precise responsible phase
  (`test_validator_plan` / `contract_finalization`). The promotion gate stays the fail-closed backstop.
- **S6 — single-source the schema. ✅ DONE (§1g).** Deleted the stale, unused
  `contract_pipeline.schema.json` (drift); the TS `CONTRACT_PIPELINE_VALIDATORS` are the single
  canonical source; a guard test rejects re-introduction.
- **S7 — audit-code anti-hallucination by grounding the claim. ✅ COMPLETE (all tiers).** Tier-1
  (quote-and-verify, §1c), tier-2 (executable anchors, §1e), and tier-3 (quarantine display +
  grounded-wins merge, §1e) all shipped; ingest-anchor parallelization shipped too (§1h). Optional
  follow-on (non-blocking): add flag-level filtering to widen the inspection-only anchor allowlist if
  "test fails" anchors prove worth running. (`orchestrator/fileAnchors.ts` is
  dispatch-time navigation guidance, left intact — the real gameable gate was `total_lines`, demoted
  in tier-1.)
- **S8 — audit-code conceptual-design-review fix. ✅ DONE (§1f).** Repo-agnostic first-principles
  questions, orient-then-roam over real files, a judging judge, and grounded conceptual findings all
  shipped (auditor-lambda 0.24.0). Deferred: fix 4b (visible headless-skip gate — low priority, the
  path is vestigial).

**Virtuous cycle:** now that S1/S3 are live, each remaining strategy can be dogfooded through the
improved pipeline (cheaper, more weak-model-robust). S7/S8 are an independent audit-code track.

---

## 3. Open decisions

- **A — Ship `c6fae403`? → RESOLVED: SHIPPED** (prior turn).
- **B — How to drive the determinism work? → RESOLVED: hand-implemented S1+S3 this turn.**
- **C — How to drive the remaining strategies? → RESOLVED (standing directive).** Ethan (this turn):
  *"We're eventually going to do all of them, and the order is irrelevant to me. Do whatever seems
  most logical to you."* So the next instance has full discretion — just proceed. S2 dropped;
  S1/S3/S4 + S7(all tiers) done. **Remaining: S8 (recommended next — mapped in §5, fixes a
  demonstrated miss), then S5, S6 (remediate-code — natural dogfood candidates through the improved
  pipeline).** Hand-implementing has been the proven path for the last four waves; dogfooding S5/S6 is
  a good option since they harden the very pipeline that would implement them.

---

## 4. Operational traps (read before any remediate/audit run)

- **Global bins are current: auditor-lambda 0.25.0 / remediator-lambda 0.24.0 (shared 0.20.0).** All
  shipped fixes (tolerant `finding_id` merge, `closing_action` honoring, S1/S3/S4/S5/S6, S7 all tiers + ingest-anchor parallelization, S8)
  are in the live bins. **Confirm the live versions** (`npm ls -g`) before assuming a fix is or isn't
  present.
- **Ingest now RUNS commands (S7 tier-2).** `merge-and-ingest` (and the worker `validate-result`
  self-check) execute a finding's `executable_anchor` command when present, from the repo root. It is
  bounded — inspection-only allowlist (grep/rg/findstr/madge/ast-grep + read-only git), 60s timeout,
  env-stripped, no shell — and off-allowlist commands are skipped (not run). Set
  `AUDIT_CODE_DISABLE_ANCHORS=1` to disable the pass entirely if a context must not execute anything.
- **`obligation_ledger` is now tool-derived.** A fresh `/remediate-code` run will **not** dispatch an
  obligation-ledger authoring step — it is auto-written from `finalized_module_contracts`. The
  `test_validator_plan` and `implementation_planning` prompts now carry a **pre-filled skeleton**;
  the worker fills only the blank slots. Don't be surprised by either.
- **Build-race:** never run two `npm run build` on one package concurrently (corrupts `dist`). During
  dev, verify **build-free**: `npm run check` (no emit) + `npx vitest run` (remediate-code) /
  `node --import tsx/esm --test` (audit-code, shared); **never** `npm test` / `npm run build` (they
  build). Rebuild `shared` once between dependency levels.
- **Always run tests with `CLAUDECODE` unset** (bash: `env -u CLAUDECODE …`; PowerShell:
  `$env:CLAUDECODE=$null; …`). A Claude session sets `CLAUDECODE=1`, which hard-fails a provider test
  and poisons runtime grading.
- **Build order:** `npm run build -w @audit-tools/shared` → `npm run build` → `npm run check`.
  Green-at-every-commit is hook-enforced (`.claude/hooks/pre-commit-gate.mjs` runs `check`).
- **Backend commands** (`next-step`, `merge-implement-results`, `validate-artifact`) run **un-wrapped**;
  parse `next-step` output by slicing the first `{` to the last `}` (a `[remediate-code] …` log line
  precedes the JSON).
- **Delegate adversarial phases** (critic / judge / counterexample) to **independent** subagents —
  not author-marks-own-homework.
- **Resume gate:** passing `--input` to `next-step` when a run is already past intake triggers a
  resume-vs-restart gate → write `confirm_resume_ack.json` `{ "choice": "resume" }` and re-run
  **without** `--input`.
- **Async typecheck Stop-hook lies during concurrent edits** (snapshots mid-edit states). Trust the
  authoritative `npm run check`; verify from disk.

---

## 5. Key file locations

- **Determinism strategy:** [`docs/contract-authoring-determinism-design.md`](contract-authoring-determinism-design.md).
- **S1+S3 (new):** `packages/remediate-code/src/contractPipeline/derive.ts` (all derivers +
  scaffolds), `src/steps/contractPipeline.ts` (the `obligation_ledger` intercept + `buildScaffoldSection`
  + the dispatch branch), `src/steps/contractPipelinePrompts.ts` (generic self-check reference;
  vestigial `obligation_ledger` ROLE), `src/index.ts` (`validate-artifact` command),
  `tests/contract-pipeline-derive-obligations.test.ts`.
- **S4 (done):** `src/contractPipeline/idRegistry.ts` (the `CP-BLOCK-` authority),
  `src/steps/contractPipeline.ts` (`promoteImplementationDagToExtractedPlan` → `toBlockId`),
  `src/steps/dispatch.ts` (`buildBlockAliasMap` + `collapseItemResults` registry-first),
  `tests/id-registry.test.ts`.
- **remediate-code contract pipeline S5/S6 (✅ DONE §1g):** S5 — `evaluatePreCriticStructuralGate` in
  `src/steps/contractPipeline.ts` (called at the `nextPhase === "critic"` gate, after the design-spec
  gate; reuses `validatePairedObligations` / `validateDigestCoverage` / `validateReconciliationDerivation`
  from `src/validation/contractPipelineGates.ts`); `tests/contract-obligations-and-gates.test.ts`.
  S6 — `schemas/contract_pipeline.schema.json` **deleted**; `src/validation/contractPipeline.ts`
  (`CONTRACT_PIPELINE_VALIDATORS`) is the single canonical contract; guard + the repair-target invariant
  in `tests/schema-contracts.test.ts` + `tests/validation.test.ts`. (`src/contractPipeline/artifactStore.ts`
  envelope/hash/staleness DAG is the downstream-re-run authority that superseded S2.)
- **audit-code S7 (ALL tiers done):** tier-1 — `src/validation/quoteGrounding.ts` (verifier),
  `src/validation/auditResults.ts` (demoted `total_lines`); tier-2 —
  `src/validation/anchorGrounding.ts` (allowlist + bounded runner + `verifyFindingAnchor` +
  `combineGroundingWithAnchor`); tier-3 — `src/reporting/synthesis.ts` (`groundingStatusBreakdown` +
  quarantine render), `src/reporting/mergeFindings.ts` (`mergeGrounding` grounded-wins). Wiring:
  `src/cli/mergeAndIngestCommand.ts` (`groundPassingFindings` runs tier-1+tier-2),
  `src/cli/validateResultCommand.ts` (self-check), `src/prompts/renderWorkerPrompt.ts`
  (quoted_text + executable_anchor guidance). Schemas: both `schemas/finding.schema.json` +
  `audit_findings.schema.json` (grounding/quoted_text/executable_anchor/grounding_status_breakdown).
  Tests: `tests/quote-grounding.test.mjs`, `tests/grounding-surfacing.test.mjs`,
  `tests/anchor-grounding.test.mjs`. (`fileAnchors.ts` is navigation guidance — leave it.)
- **audit-code S8 (✅ DONE §1f — auditor-lambda 0.24.0; file locations below double as the map for the
  deferred fix 4b):**
  - *First-principles questions:* `src/orchestrator/designReviewPrompt.ts` `conceptualCritiqueInstructions()`
    (~246-257) — today a narrow library/pattern/simplification checklist; replace with general
    architectural questions (is the approach right? what core assumption? clean-sheet redesign?
    deepest structural risk?). Keep REPO-AGNOSTIC — no project lenses.
  - *Orient-then-roam:* `buildPrioritizedReadingList` (~69-110, takes top-N highest-RISK units,
    summaries only) + `renderConceptualReviewPrompt` (~403-422) / `renderConceptualPerspectivePrompt`
    (~431-459) / `renderSharedStructuralContext`. Add project docs + an /init-style overview + freedom
    to roam real files (not a risk-truncated summary feed).
  - *Judging judge:* `renderConceptualJudgePrompt` (~468-500) — line ~494 says "you are merging, not
    reviewing"; restore evaluative role (assess merit/validity/severity, flag what's MISSING).
  - *Ground + gate output:* `src/cli/nextStepHelpers.ts` `handleDesignReviewBranch` (~274-358) ingests
    conceptual/contract findings on `Array.isArray()` ALONE (no evidence/schema) — require evidence +
    validate; `src/orchestrator/structureExecutors.ts` `runDesignReviewAutoComplete` (~125-161) sets
    `*_reviewed=true` with `[]` and no LLM call — gate so an empty auto-complete can't silently pass.
    Obligation is the boolean `*_reviewed` flag (`src/orchestrator/state.ts` 149-161 — correctly
    `? "satisfied" : "missing"`, NOT a bug; the gap is upstream in auto-complete/ingest).
    `DesignAssessment` type: `src/types/designAssessment.ts` (3-18; `conceptual_findings`/`contract_findings`).
  - *Tests:* `tests/design-review-parallel.test.mjs`, `tests/design-assessment.test.mjs`,
    `tests/design-review-budget.test.mjs`, `tests/design-docs-declarative.test.mjs`.
  - **Synthesis:** S8 is the one place to lean INTO judgment — enable + ground/gate, never constrain
    with checklists or project lenses.
- **Hooks:** `.claude/hooks/pre-commit-gate.mjs` (authoritative commit gate), `async-typecheck.mjs`
  (advisory only).
- **Backlog:** [`docs/backlog.md`](backlog.md).

---

## 6. Commit / ship state

**Most recent release — S7 ingest-anchor parallelization** (§1h): commit `4cb75931`, releases
`bc7859ab` / `0b1f655c` / `fe2cd0ad` → **shared 0.20.0 / auditor-lambda 0.25.0 / remediator-lambda 0.24.0**
(all 3 publish-package CI runs green; bins reinstalled + smoke `audit-code 0.25.0` / `remediate-code 0.24.0`).

The determinism work shipped three releases before it: **(1) S5 + S6 (remediate-code contract-authoring
track):** commits `3b39377` (S5 pre-adversarial structural floor) + `94a2c33` (S6 single-source schema /
delete drift), release `0250572e` → **remediator-lambda 0.23.0** (shared/audit-code unchanged); CI run
`27530893683` green; bin reinstalled + smoke (`remediate-code 0.23.0`). **(2) S8 conceptual design review fix:** commit
`b431367`, release `08aaf6c1` → **auditor-lambda 0.24.0** (shared/remediate unchanged); CI run
`27529084396` green; bin reinstalled + `--allow-scripts` postinstall + smoke (`audit-code 0.24.0`).
**(3) S7 tier-2 + tier-3** (audit-code anti-hallucination complete):
commits `3e7a47b` (tier-3 surfacing + grounded-wins + tier-1 schema-drift fix) + `a9d6ac2` (tier-2
anchors) → **shared 0.19.0 / auditor-lambda 0.23.0 / remediator-lambda 0.22.0**. Committed, pushed to
`main` (release commits `34822d52` / `d14606ac` / `b632ab50`), published (all 3 publish-package CI runs
green), global bins reinstalled + deferred postinstall run via `--allow-scripts` + smoke-verified
(`audit-code 0.23.0` / `remediate-code 0.22.0`). Tree clean.

Prior-turn releases (still accurate):
- **S1+S3** (remediate-code: `derive.ts` + intercept/scaffold wiring + `validate-artifact` CLI +
  prompt self-check) → **remediator-lambda 0.19.0** (shared + audit-code unchanged).
- **S7 tier-1** (shared `FindingLocation.quoted_text` + `FindingGrounding`; audit-code
  `quoteGrounding.ts` + ingest/self-check wiring + `total_lines` demote + worker prompt; both
  `finding.schema.json`) → **shared 0.18.0 / auditor-lambda 0.22.0 / remediator-lambda 0.20.0**.
- **S4 + S2-drop** (remediate-code: `idRegistry.ts` + promote/dispatch repointing + `collapseItemResults`
  registry-first + deleted dead `repairDownstreamPhases`; design-doc S2 banner) → **remediator-lambda
  0.21.0** (shared + audit-code unchanged).

All were committed, pushed to `main`, published to npm, and the global bins reinstalled. Working
tree should be clean. For exact published versions, see the latest `*-v*` git release tags / `npm view`.

---

## 7. References

- **CLAUDE.md** governing invariant: *"Auditor-agnostic robustness — enforce in tooling, never host
  discretion."* The determinism (§2) and anti-hallucination (S7) work is that invariant applied to the
  pipeline's own authoring and to the auditor's claims.
- **Companion design docs:** `docs/remediation-workflow-design.md`, `docs/audit-workflow-design.md`.
- **Completed-run artifacts (gitignored, on disk):** `.audit-tools/remediation-report.md`,
  `.audit-tools/remediation-outcomes.json`.
