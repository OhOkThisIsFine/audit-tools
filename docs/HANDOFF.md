# HANDOFF — audit-tools

> **Audience:** the next agent instantiation (no memory of the session that produced this).
> **This is the single rolling handoff** (replaces the old per-name `HANDOFF-*.md` convention —
> keep using *this* file; update/trim it as state changes, don't spawn new per-topic handoffs).
> **Last updated:** 2026-06-15 UTC.

---

## 0. TL;DR

1. The **workflow-robustness remediation is DONE and committed** (`c6fae403` on `main`), green,
   **NOT pushed, NOT published**. It was committed *together with* the previously-in-tree
   452-finding self-audit remediation as one changeset (per Ethan's choice). See §1.
2. The agreed **next focus** (Ethan, high priority): make creating contracts/obligations/invariants
   **efficient, less error-prone, and manageable by both weak and strong models, via deterministic
   tools.** Strategy doc written: [`docs/contract-authoring-determinism-design.md`](contract-authoring-determinism-design.md)
   (strategies S1–S7). **Not implemented yet.** See §2.
3. **Decision A is resolved: SHIPPED** — `c6fae403` + the docs were committed, pushed, and
   published this turn; global bins reinstalled. Decision B (how to drive the determinism work)
   remains open. See §3.
4. Operational traps the next instance WILL hit are in §4 — read them before any remediate/audit run.

---

## 1. What just shipped — commit `c6fae403` (held, not pushed/published)

Ran `/remediate-code` on the old `docs/HANDOFF-workflow-robustness.md` (now deleted; superseded by
this file — its full content is in git history at `c6fae403`) through the full contract pipeline:
9 modules, 86 obligations, **2 adversarial repair rounds** (independent critic/judge subagents),
10-node implementation DAG, 4 dispatch waves.

**Outcome:** 10/10 nodes resolved, 0 blocked. **Green clean-env (CLAUDECODE unset): shared
550/0/1, audit-code 2121/0/1, remediate-code 77 files / 1513 tests / 0 fail; `npm run build` +
`npm run check` clean.** Commit = 94 files, +13,127/−5,463 — the 9 robustness modules **plus** the
in-tree 452-finding remediation, as one landed changeset on `main`.

The 9 modules (every audit→remediate correctness property moved out of host discretion into tooling):
- **dispatch-seam** (`src/steps/dispatch.ts`): exact node-id + one-result-per-node renderer,
  upstream-evidence threading, tolerant `finding_id`→node merge + multi-entry collapse, git-diff
  write-scope enforcement (fail-closed), `NodeDisposition` (skip ≠ verified_complete), sibling-red→triage.
- **rolling-scheduler** (`src/steps/nextStep.ts`; **deleted `waveScheduler.ts`** in an atomic
  replace): verified-complete rolling per-node dispatch on the shared rolling engine; tool-owned
  env-scrubbed **final clean-env gate (INV-RS-10)** independent of `plan.test_command`;
  coarse-deterministic re-block-all-on-unattributable-red backstop.
- **contract-obligations** (`src/steps/contractPipeline.ts` + `src/validation/contractPipeline*.ts`):
  fail-closed gates (paired-obligation / evidence-threaded / source-type-scoped digest-coverage /
  reconciliation-derivation) + `deriveNodeModelTier` (relative ranks, no model names) +
  downstream-only repair scoping + finding-trace.
- **intake-digest** (`src/intake.ts`): bounded `findings-digest.json` + complete
  `finding-enumeration.json` + content-aware single-writer source registration.
- **coverage-ledger** (`src/state/types.ts` + `src/coverage/findingLedger.ts`): source-type-explicit
  per-finding/per-node completeness gate (no vacuous 0/0 green on document runs).
- **cli-capability** (`src/index.ts` + audit-code `src/cli/nextStepCommand.ts`):
  `--host-can-dispatch-subagents` is now a **true boolean**; `--guidance-file` single-step bootstrap;
  parity across both orchestrators.
- **host-loader-docs**: loader docs aligned to the CLI shape (doc↔CLI parity test).
- **hooks-gate** (`.claude/hooks/async-typecheck.mjs`): debounced, advisory-only.
- **fixture-drift-guard**: regenerated-equals-committed guard + generator output override.

**Carried residuals (deliberate design choices baked into the rolling-scheduler node — know these):**
- **CE-001** — per-package verify is **build-free + single-flight** (no same-package double/concurrent build).
- **CE-002** — the runtime/packaged-bin smoke surface (`verify:release` smokes) is a **declared
  residual**; INV-RS-10's hard floor is scoped to build+check+unit (the smokes are the known
  Windows-flaky surface and run separately at release).
- **CE-003** — the coarse re-block path has a **bounded auto-terminate** (`COARSE_REBLOCK_BOUND=2`)
  so a permanently-red sibling converges to terminal `blocked` for a no-human host (never livelock,
  never a human-triage strand, never force-close-to-green).

---

## 2. Forward work — contract-authoring determinism (HIGH PRIORITY, not implemented)

**Ethan's ask:** make creating contracts/obligations/invariants efficient, less error-prone, and
doable by **both weak and strong models**, leveraging **deterministic tools**.

**Doc:** [`docs/contract-authoring-determinism-design.md`](contract-authoring-determinism-design.md).
**Core idea:** *invert* authoring — the tool owns structure / IDs / cross-refs / derivation /
validation; the LLM authors only irreducible **judgment** content in small pre-scaffolded,
write-validated slots. Today all 13 contract artifacts are 100% LLM-authored and the backend only
validates. The derivable ones (`obligation_ledger`, `test_validator_plan`, `implementation_dag`
skeleton) have their mapping rules **already encoded as the inverse of existing validators**
(`validatePairedObligations`, `deriveNodeModelTier`, `validateImplementationDAGIntegrity`); a pure
`repairDownstreamPhases` deriver exists but is **unwired**; there is **no single ID authority**
(root of the merge trap in §4).

Strategies (prioritized; plug-in points in the doc):
- **S1** derive the derivable artifacts in code + **S3** skeleton-scaffold + write-time validation
  → **do first** (biggest efficiency+robustness; unblocks the weak-model goal).
- **S2** patch-based repair + wire the dead `repairDownstreamPhases`; **S4** single ID authority
  (kills the merge trap at the root).
- **S5** structural linter before the LLM adversarial phases; **S6** single-source the schema
  (`schemas/contract_pipeline.schema.json` is stale drift).
- **S7** (parallel **audit-code** track) anti-hallucination by **grounding the claim, not attesting
  the read**: quote-and-verify on defect claims (tool re-reads the cited verbatim span), executable
  anchor on behavior claims (tool runs the command), adversarial cross-check + traceability on
  judgment. Replaces the gameable proof-of-reading remnant (`file_coverage[].total_lines`,
  `src/orchestrator/fileAnchors.ts`). Cheap + high-ROI; can land early on its own.
- **S8** (audit-code) apply the same treatment to the **conceptual design review step itself** — it
  caught *none* of this class in the 452-self-audit because it's a single-pass, risk-scoped,
  improvement-framed, ungrounded, ungated LLM step (the same green-but-wrong shape). Fixes:
  first-principles prompt framing (is-the-approach-right / where's-determinism-missing /
  what-breaks-for-a-weak-model / what-lacks-ground-truth), whole-system topology scope (not
  risk-truncated units), an independent adversarial critic for *missed classes*, grounding (S7)
  + a gate so it can't auto-complete empty. Code-grounded reasons + plug-in points are in the
  determinism doc S8. (Honest limit: conceptual insight is tier-3 — raise the odds, can't guarantee.)

---

## 3. Open decisions for Ethan (ask before acting)

- **A — Ship `c6fae403`? → RESOLVED: SHIPPED this turn** (Ethan green-lit). `main` pushed + changed
  packages published via `/ship`; global bins reinstalled. (The 2 CRLF files —
  `scripts/generate-auditor-contract-fixture.mjs`, `tests/fixtures/audit-findings-simple.json` —
  were renormalized to LF as part of the ship clean-tree guard.)
- **B — How to drive the determinism work?** *(open)* Implement **S1+S3** directly, or **dogfood** it via
  `audit-code → remediate-code` (once S1/S3 land, the pipeline pays for its own improvement). S7 is
  independent and can start anytime.

---

## 4. Operational traps (read before any remediate/audit run)

- **Dogfooding separation (critical):** the `/remediate-code` and `/audit-code` slash workflows run
  the **global bins** (`remediator-lambda@0.18.1`, `auditor-lambda@0.21.3`), **NOT the working
  tree**. So the fixes in `c6fae403` are **not live until published** — a fresh run still hits the
  OLD behavior (the next two traps). Test working-tree changes via the dev wrappers / direct tests,
  not the slash workflow.
- **`finding_id` vs `block_id` merge trap (live bin):** implement workers emit the
  `CP-BLOCK-N-*` block id; `merge-implement-results` wants the **bare `N-*` node id** → "Unknown
  finding_id". Until the tolerant merge (S4) is published, either instruct workers to emit the bare
  node id, or patch result files (strip the `CP-BLOCK-` prefix) before merging.
- **`closing_action` ignored (live bin):** the `intent_checkpoint.closing_action` ("commit") is not
  honored — close runs "none". Commit manually if needed.
- **Async typecheck Stop-hook lies during concurrent edits** (snapshots mid-edit states). Trust the
  authoritative `npm run check`; verify from disk.
- **Build-race:** never run two `npm run build` on one package concurrently (corrupts `dist`). Until
  the rolling scheduler is live, the **host** manages this — verify **build-free**: `npm run check`
  (no emit) + `npx vitest run` (remediate-code) / `node --import tsx/esm --test` (audit-code, shared);
  **never** `npm test` / `npm run build` (they build). Rebuild `shared` once between dependency levels.
- **Always run tests with `CLAUDECODE` unset** (bash: `env -u CLAUDECODE …`; PowerShell:
  `$env:CLAUDECODE=$null; …`). A Claude session sets `CLAUDECODE=1`, which hard-fails a provider
  test and poisons runtime grading.
- **Build order:** `npm run build -w @audit-tools/shared` → `npm run build` → `npm run check`.
  Green-at-every-commit is hook-enforced (`.claude/hooks/pre-commit-gate.mjs` runs `check`).
- **Backend commands** (`next-step`, `merge-implement-results`) run **un-wrapped**; parse `next-step`
  output by slicing the first `{` to the last `}` (a `[remediate-code] …` log line precedes the JSON).
- **Delegate adversarial phases** (critic / judge / counterexample) to **independent** subagents —
  not author-marks-own-homework.
- **Resume gate:** passing `--input` to `next-step` when a run is already past intake triggers a
  resume-vs-restart gate → write `confirm_resume_ack.json` `{ "choice": "resume" }` and re-run
  **without** `--input`.

---

## 5. Key file locations

- **Determinism strategy:** [`docs/contract-authoring-determinism-design.md`](contract-authoring-determinism-design.md).
- **remediate-code contract pipeline:** `src/steps/contractPipeline.ts` (driver/ingest/gates),
  `src/steps/contractPipelinePrompts.ts` (phase-prompt renderer), `src/validation/contractPipeline.ts`
  + `contractPipelineGates.ts` (per-artifact validators + the two deterministic transforms
  `deriveNodeModelTier` / `repairDownstreamPhases`), `src/contractPipeline/artifactStore.ts`
  (envelope, content/dependency hashing, staleness DAG), `src/steps/dispatch.ts`
  (`buildBlockAliasMap` / `collapseItemResults` / `mergeImplementResults` — the merge-trap seam),
  `src/steps/nextStep.ts` (rolling dispatch + final gate), `src/coverage/findingLedger.ts`.
- **audit-code (S7 target):** `schemas/audit_result.schema.json`, `src/validation/auditResults.ts`,
  `src/orchestrator/resultIngestion.ts` + `ingestionExecutors.ts`, `src/cli/mergeAndIngestCommand.ts`,
  `src/cli/validateResultCommand.ts` (existing write-time validator affordance),
  `src/prompts/renderWorkerPrompt.ts`, `src/orchestrator/fileAnchors.ts` (the proof-of-reading
  remnant to generalize/replace).
- **Hooks:** `.claude/hooks/pre-commit-gate.mjs` (authoritative commit gate), `async-typecheck.mjs`
  (advisory only).

---

## 6. Commit / ship state

`c6fae403` = the remediation (9 modules + the in-tree 452 work). A follow-up commit landed the docs
(`docs/contract-authoring-determinism-design.md`, this `docs/HANDOFF.md`, deletion of the old
`docs/HANDOFF-workflow-robustness.md` — its content is in git history at `c6fae403`). Both were
**pushed to `main` and the changed packages published to npm this turn** via `/ship`; global bins
were reinstalled. Working tree should be clean. (Memory files live under `~/.claude/…/memory/`,
outside the repo.) For exact published versions, see the latest `*-v*` git release tags / `npm view`.

---

## 7. References

- **CLAUDE.md** governing invariant: *"Auditor-agnostic robustness — enforce in tooling, never host
  discretion."* The determinism (§2, S1–S6) and anti-hallucination (S7) work is that invariant
  applied to the pipeline's own authoring and to the auditor's claims.
- **Completed-run artifacts:** `.audit-tools/remediation-report.md`,
  `.audit-tools/remediation-outcomes.json` (gitignored; on disk).
- **Companion design docs:** `docs/remediation-workflow-design.md`, `docs/audit-workflow-design.md`.
