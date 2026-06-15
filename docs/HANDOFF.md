# HANDOFF — audit-tools

> **Audience:** the next agent instantiation (no memory of the session that produced this).
> **This is the single rolling handoff** (replaces the old per-name `HANDOFF-*.md` convention —
> keep using *this* file; update/trim it as state changes, don't spawn new per-topic handoffs).
> **Last updated:** 2026-06-15 UTC.

---

## 0. TL;DR

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

---

## 2. Forward work — remaining determinism strategies (HIGH PRIORITY)

Doc: [`docs/contract-authoring-determinism-design.md`](contract-authoring-determinism-design.md).
S1+S3 (§1b) are done. Remaining, prioritized:

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
- **S5 — structural linter before the adversarial phases.** Run fuller ID-integrity/dangling-ref/
  coverage-symmetry checks deterministically *before* critic/judge so the adversarial budget is spent
  on semantics.
- **S6 — single-source the schema.** `schemas/contract_pipeline.schema.json` is stale drift; make it
  (or a regenerated equivalent) the one source the validators/derivers/scaffolds consume, or delete
  it; guard with a generator↔committed test.
- **S7 — audit-code anti-hallucination by grounding the claim.** **Tier-1 (quote-and-verify) is DONE
  (§1c).** Remaining: **tier-2** — executable anchors on behavior claims ("throws"/"test fails"/"no
  cycle"/"unused"): the finding ships a command the tool runs (reuse the runtime-validation path);
  and **tier-3** — traceability of synthesis/severity claims back to grounded tier-1/2 findings (the
  adversarial cross-check already exists). Also a **synthesis-side display** of quarantined
  (ungrounded) findings — today they are marked + warned at ingest but not yet visually separated in
  the report. (Correction baked into §1c: `orchestrator/fileAnchors.ts` is NOT the proof-of-reading
  remnant — it is dispatch-time navigation guidance and was left intact; the real gameable gate was
  `total_lines`.)
- **S8 — audit-code conceptual-design-review fix** (repo-agnostic): general first-principles
  questions, orient-then-roam over real files, a judge that judges, evidence-grounded + gated output.
  Lean *into* judgment here, don't constrain it.

**Virtuous cycle:** now that S1/S3 are live, each remaining strategy can be dogfooded through the
improved pipeline (cheaper, more weak-model-robust). S7/S8 are an independent audit-code track.

---

## 3. Open decisions

- **A — Ship `c6fae403`? → RESOLVED: SHIPPED** (prior turn).
- **B — How to drive the determinism work? → RESOLVED: hand-implemented S1+S3 this turn.**
- **C — How to drive S2/S4–S8?** *(open)* Now that S1/S3 are live, the cleanest options are
  **dogfood** (`/remediate-code` on the determinism design doc, scoped to S2/S4/S5/S6 — the
  improved pipeline implements its own next improvement) or continue **hand-implementing**. **S7+S8
  are an independent audit-code track** and can start anytime (S7 quote-verify is the cheapest
  first win). Recommended: S7 (independent, high-ROI) + dogfood S2/S4 next.

---

## 4. Operational traps (read before any remediate/audit run)

- **The c6fae403 + S1/S3 fixes ARE live now.** Global bins are current (auditor-lambda 0.21.4 /
  remediator-lambda ≥0.19.0). The old "not live until published" caveat is resolved: the tolerant
  `finding_id` merge and `closing_action` honoring are in the live bin. **Confirm the live versions**
  (`npm ls -g`) before assuming a fix is or isn't present.
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
- **remediate-code contract pipeline (for S5/S6):** `src/validation/contractPipelineGates.ts`
  (validators to invert + `deriveNodeModelTier`; the dead `repairDownstreamPhases` was deleted),
  `src/validation/contractPipeline.ts` (`CONTRACT_PIPELINE_VALIDATORS`),
  `src/contractPipeline/artifactStore.ts` (envelope/hash/staleness DAG — the real downstream-re-run
  authority that superseded S2).
- **audit-code S7 (tier-1 done):** `src/validation/quoteGrounding.ts` (verifier),
  `src/validation/auditResults.ts` (demoted `total_lines`), `src/cli/mergeAndIngestCommand.ts`
  (Phase 3.5 grounding pass), `src/cli/validateResultCommand.ts` (self-check),
  `src/prompts/renderWorkerPrompt.ts` (quoted_text requirement), both `schemas/finding.schema.json`,
  `tests/quote-grounding.test.mjs`. **Tier-2/3:** reuse the runtime-validation path
  (`runtime_validation_report.json`) for executable anchors. (`fileAnchors.ts` is navigation
  guidance — leave it.)
- **audit-code S8 target:** `src/orchestrator/designReviewPrompt.ts` + `structureExecutors.ts`
  (conceptual review), `src/cli/nextStepHelpers.ts` (conceptual-finding ingest).
- **Hooks:** `.claude/hooks/pre-commit-gate.mjs` (authoritative commit gate), `async-typecheck.mjs`
  (advisory only).
- **Backlog:** [`docs/backlog.md`](backlog.md).

---

## 6. Commit / ship state

Three releases shipped this turn:
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
