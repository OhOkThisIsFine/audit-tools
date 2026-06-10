# Build handoff — free-form remediation quality

**Purpose.** Make `remediate-code` produce *quality* results when its input is
free-form prose (a `backlog.md`-style list of issues, a conversation, a design
doc) rather than a structured `auditor` `audit-findings.json`. Today the
free-form path runs end-to-end but its findings are not *grounded*, and the
contract pipeline's adversarial quality gate is dead code. This doc is the
execution plan for the "What remains" bullet under **Contract-governed
implementation pipeline** in [`backlog.md`](backlog.md).

**How to use this doc.** Execute the three workstreams below. WS1 → WS2 → WS3 is
the intended order (increasing size; WS1 is the load-bearing fix). Each
workstream is independently shippable and independently testable. Verify against
the actual code before editing — `file:line` anchors below were accurate at
`main` `622ba63` and may have drifted; treat the **symbol names** as the source
of truth and re-grep. Remove this file once all three ship.

> Run `npm install` at the repo root first (fresh clones/worktrees resolve
> `@audit-tools/shared` against stale `dist/` otherwise). Build order: shared
> first. All test/verify commands must run with `CLAUDECODE` **unset** (a
> provider test fails under it) — use the Bash tool's `env -u CLAUDECODE …`.

---

## Background: how the free-form path works today (verified)

Two intake shapes converge on one downstream flow:

```
structured audit-findings.json
  └─ runPlanPhase → parseAuditFindingsReport ────────────┐  (deterministic, grounded)
                                                          ├─ dedup → intent-checkpoint
free-form prose / conversation / document                │     filter → applyPlanPipeline
  ├─ intake synthesis (LLM)         intakeResolver.ts     │     → blocks → document/implement
  ├─ [clarification loop]           intakeResolver.ts     │     dispatch → close
  ├─ extract_findings (LLM)  ───────┐ plan.ts             │
  │     ↳ optional contract pipeline│ contractPipeline.ts │
  │       goal→context→design→      │                     │
  │       critique→assessment→DAG   │                     │
  └─ handlePendingExtractedPlan ────┴─────────────────────┘  nextStep.ts ≈1179
```

Key anchors:

- **Free-form → findings.** `extractFindingsWithProvider` (`src/phases/plan.ts`
  ≈1019) runs an LLM worker that writes `extracted-plan.json` (a
  `{ findings, blocks }` object whose findings match the shared `Finding`
  schema). Called from `runPlanPhase` (`plan.ts` ≈847).
- **Only existing "validation" of extracted findings.** `plan.ts` ≈868–886
  drops findings whose `evidence` array is empty (warn, not error). After that:
  cross-lens dedup (≈889), intent-checkpoint filter (≈906), then
  `applyPlanPipeline` (≈930) which does file-overlap merge, context-budget split,
  and `snapshotAffectedFileHashes`.
- **The integrity check does NOT validate extracted paths.**
  `checkAffectedFileIntegrity` (`src/utils/fileIntegrity.ts` ≈167) only re-checks
  files that already carry `hash_at_plan_time` (≈178 `if (!af.hash_at_plan_time …) continue`).
  It is a *staleness* guard for already-valid paths, not an existence validator —
  a hallucinated path never gets a plan-time hash, so it is skipped and flows
  straight to a worker.
- **Contract pipeline driver.** `src/steps/contractPipeline.ts`:
  `shouldEnterContractPipeline` (≈71), `nextMissingContractPhase` (≈95),
  `buildNextContractPipelineStep` (≈123), `promoteImplementationDagToExtractedPlan`
  (≈265). Dispatched from `src/steps/nextStep.ts` ≈1211/1230, after intake is
  ready and `source_type !== "structured_audit"`.
- **Phase order.** `CONTRACT_PIPELINE_PHASE_ORDER`
  (`src/steps/contractPipelinePrompts.ts` ≈236) =
  `goal_normalization → context_collection → design → critique → assessment →
  implementation_planning → closing`. `PRE_IMPLEMENTATION_PHASE_ORDER`
  (`contractPipeline.ts` ≈52) filters out `closing`, so **`verification_report`
  is never produced** in the live loop. `PHASE_TO_ARTIFACT` (`contractPipeline.ts`
  ≈36) maps phase→artifact. `obligation_ledger` is a sub-phase before `assessment`
  (`contractPipeline.ts` ≈101, `"obligation_ledger_phase"`).
- **Role prompts.** `ROLES` in `contractPipelinePrompts.ts` (≈24–138) defines 7
  roles (one per phase). There is **no `critic`/`counterexample` role and no
  `judge` role.**
- **Dead shared types** (defined, never produced/consumed):
  `Counterexample`, `JudgeReport`, `VerificationReport`/`FindingVerificationTrace`/
  `VerificationTraceEntry` in `packages/shared/src/types/contractPipeline.ts`
  (≈169/188/265). `counterexample` and `judge_report` are also resolvable
  `ContractPipelineArtifactName`s (path slots wired in `buildNextContractPipelineStep`
  ≈140–151) but have no producing phase.

---

## WS1 — Ground `affected_files` at extraction (highest leverage)

**Problem.** LLM-extracted findings cite `affected_files[].path`s the model
guessed from prose. Nothing checks they exist on disk before a worker is
dispatched, so workers fail on non-existent/wrong paths. This is the single
biggest quality killer for free-form input.

**Where.** `src/phases/plan.ts`, immediately after `extractFindingsWithProvider`
returns and **before** dedup/checkpoint/`applyPlanPipeline` (≈855–887, alongside
the existing empty-evidence drop). Apply it **only to the extracted path**, not
to `parseAuditFindingsReport` output (auditor paths are already grounded — gating
them would be a regression; keep parity by grounding at the point prose enters).

**Build.**
1. Add a deterministic grounding pass: for each extracted finding, resolve each
   `affected_files[].path` with `resolveAffectedPath(root, path)` (export it from
   `src/utils/fileIntegrity.ts` if not already) and `existsSync`. Partition into
   real vs. phantom paths.
2. **Bounded repair, not silent drop:**
   - Drop phantom paths from the finding; keep real ones.
   - A finding left with **zero** real paths → one bounded re-extraction attempt
     (re-prompt the worker for that finding with the phantom paths named and an
     instruction to cite real repo paths, or to mark the finding
     `no_change`/withdraw it). Cap at **1 retry** (mirror the
     `MAX_AUTO_RETRIES`/loop-cap discipline in `phases/triage.ts`); if it still
     has no real path, drop it and record why.
   - Record every drop/repair in the coverage ledger (the same ledger that tracks
     `dropped_by_checkpoint` / empty-evidence skips) so nothing is silently lost —
     this is a hard project invariant.
3. Optionally tighten the worker extraction prompt (`extractFindingsWithProvider`
   / its prompt in `src/steps/prompts.ts`) to instruct: cite only repo-relative
   paths that exist; prefer `no_change` over guessing.

**Acceptance.**
- An extracted finding with a phantom `affected_files` path is repaired or dropped
  before dispatch; no worker is ever handed a non-existent path.
- Drops/repairs appear in the coverage ledger and the run summary.
- The structured `audit-findings.json` fast path is byte-for-byte unaffected.

**Tests** (`vitest`, `packages/remediate-code/tests/`). Add to the plan-phase
tests: feed an extracted plan with a mix of real + phantom paths; assert phantom
paths are stripped, a zero-real-path finding is dropped/withdrawn, the ledger
records it, and a structured-input control is unchanged.

---

## WS2 — Ground evidence

**Problem.** Extracted `evidence` is free-text the model wrote; nothing links it
to a real source location, so a hallucinated finding is indistinguishable from a
real one. Today only *empty* evidence is filtered (`plan.ts` ≈868).

**Where.** Same extraction post-processing block in `plan.ts` (after WS1).

**Build.**
1. Define a "grounded evidence" expectation: at least one `evidence` entry should
   reference a real repo path (and ideally `path:line`) that exists. Parse a
   `path` (and optional `:line`) token from each evidence string; validate the
   path with `existsSync` and, when a line is given, that the file has ≥ that many
   lines.
2. **Downgrade, don't hard-fail:** a finding with no grounded evidence is not
   dropped outright (prose findings can be legitimately high-level) — instead mark
   it lower confidence and surface it for the WS3 judge to adjudicate. Record the
   ungrounded status on the finding/coverage ledger.
3. Tighten the extraction prompt to request `path:line` evidence citations.

**Acceptance.** Findings carry a machine-checkable "evidence grounded: yes/no"
signal that WS3 consumes; ungrounded findings are flagged, not silently trusted;
structured path unaffected.

**Tests.** Evidence with a real `path:line`, a phantom path, and a bare prose
string → assert the grounded/ungrounded classification and that nothing is
dropped purely for being ungrounded.

---

## WS3 — Wire the adversarial critic → judge → repair loop (largest)

**Problem.** The contract pipeline's quality gate is dead. `Counterexample` and
`JudgeReport` types and artifact-name slots exist, but there is **no critic role,
no judge role, no phase producing them, and no repair step** — so design flaws
and weak/hallucinated findings flow straight to implementation. This is the
mechanism that turns "the pipeline ran" into "the pipeline produced something
trustworthy."

**Target shape.** Insert, between `assessment` and `implementation_planning`, a
bounded loop:

```
… → assessment → [ critic → judge → (repair?) ]* → implementation_planning → …
                   produces      verdict +     regenerates the contract
                   counterexamples accepted/    artifact at fault
                   against the    rejected      (design_spec / obligation_ledger
                   design+obligations           / assessment), marks downstream
                                                stale, loops
```

**Build.**
1. **Shared contracts.** The `Counterexample` and `JudgeReport` types already
   exist in `packages/shared/src/types/contractPipeline.ts` — reuse them; extend
   only if needed (e.g. a `repair_directive` on the judge report). A counterexample
   classification of `accepted | out_of_scope | duplicate | invalid | residual_risk`
   is the intended taxonomy (see `backlog.md`). Rebuild shared and typecheck both
   dependents after any type change.
2. **Roles.** Add `critic` and `judge` entries to `ROLES`
   (`contractPipelinePrompts.ts`), each with `requiredInputKeys`, `outputKey`
   (`counterexample` / `judge_report`), and an `outputSchema`. The critic generates
   concrete counterexamples against the `design_spec` invariants + `obligation_ledger`;
   the judge classifies each and emits an overall `verdict` plus, on failure, which
   contract artifact to repair.
3. **Phases + driver.** Add the new phases to `CONTRACT_PIPELINE_PHASE_ORDER` and
   `PHASE_TO_ARTIFACT`, between `assessment` and `implementation_planning`. Teach
   `nextMissingContractPhase` / `buildNextContractPipelineStep`
   (`contractPipeline.ts`) to dispatch them. Because the pipeline is resumable and
   **one bounded step per invocation**, the loop lives across `next-step`
   invocations with state in the contract-pipeline artifacts — not an in-process
   `while`.
4. **Repair + staleness.** On a failing judge verdict, regenerate the named
   contract artifact (design/obligations/assessment) and let the existing
   content-hash staleness DAG (`src/contractPipeline/artifactStore.ts`) invalidate
   the downstream artifacts so the loop re-derives them. **Cap iterations**
   (e.g. 2–3) to guarantee termination — an unbounded critic↔repair loop is the
   failure mode to avoid (cf. the audit-code finalization-oscillation lesson).
   After the cap, proceed with the residual risks recorded on the judge report.
5. **Traceability invariant.** No `implementation_dag` node may be emitted without
   tracing to a requirement, invariant, or **accepted** counterexample. Enforce in
   `promoteImplementationDagToExtractedPlan` / validation.
6. **(Optional, same area) verification_report.** `closing`/`verification_report`
   has a role but is filtered out of the live loop. Either wire it into the
   `close` phase (`src/phases/close.ts`) to emit a real `VerificationReport`, or
   leave it explicitly out of scope and note so. "Tests pass" is never sufficient
   proof of completion — a real verification trace is the durable goal.
7. **Validation + tests.** Add validators in `src/validation/contractPipeline.ts`
   for the new artifacts; extend `tests/contract-pipeline.test.ts` and
   `tests/contract-pipeline-prompts.test.ts` to cover: a clean run (judge passes,
   no repair), a repair cycle that converges, and the iteration cap halting a
   non-converging loop.

**Acceptance.**
- A free-form run dispatches critic → judge after assessment; a failing verdict
  triggers exactly one targeted repair + re-derive; the loop terminates within the
  cap.
- `implementation_dag` nodes are traceable to obligations/accepted counterexamples.
- Defaults remain safe: a run with no provider, or a structured input, never
  enters the loop.

---

## Cross-cutting requirements

- **Conventions** ([`CLAUDE.md`](../CLAUDE.md)): ideal-code over back-compat
  (one consumer — delete legacy, no shims); deterministic-before-LLM (the WS1/WS2
  grounding is deterministic and must run before any LLM critic); language-neutral
  contracts; one-bounded-step-per-invocation; treat all LLM output as untrusted
  until validated; nothing silently dropped (coverage ledger).
- **Parity.** Where a concept is shared (counterexample taxonomy, verification
  trace), it belongs in `@audit-tools/shared`; mirror naming with audit-code's
  contract-assessment posture (`packages/audit-code/src/orchestrator/designReviewPrompt.ts`,
  `packages/audit-code/spec/artifact-contract.md`). A fix here that also applies to
  audit-code should land in both.
- **Windows/host.** Prompts that ask a worker to run commands must be
  cwd-explicit (forward-slash paths via `toPromptPathToken`); don't pipe an inline
  PowerShell `foreach` into `ConvertTo-Json`.
- **Verify** (CLAUDECODE unset): `npm run check` (all 3 workspaces) and
  `npm test -w packages/remediate-code`. Before any release, `npm run verify:release`
  (includes smoke, which `npm test` does not). Regenerate the auditor-contract
  fixture with `npm run fixtures:auditor-contract` if the structured shape changes.
- **Dogfooding trap.** The `/remediate-code` slash command runs the *global* bin,
  not the working tree — test fixes with the dev wrapper
  (`node remediate-code.mjs next-step …`) or `npm test`, not the slash command.

## Out of scope / non-goals

- **Curating `backlog.md` itself.** `backlog.md` is heterogeneous (dev-friction,
  deferred-by-design items, large features) and is *not* a good remediation target
  as-is regardless of tool quality. This build makes the *tool* trustworthy on
  free-form input; selecting/curating what to feed it is a separate, per-run
  human/LLM step.
- **Replacing the structured fast path.** `audit-findings.json` stays the
  deterministic, grounded, highest-quality route and must be untouched.

## Definition of done

WS1+WS2+WS3 merged, both dependents typecheck, `remediate-code` suite green
(CLAUDECODE unset), `verify:release` green, and a free-form end-to-end run on a
small grounded fixture produces an `implementation_dag` whose nodes trace to
obligations/accepted counterexamples — with phantom paths and ungrounded findings
caught before dispatch. Then delete this file and trim the corresponding
"What remains" bullet in `backlog.md`.
