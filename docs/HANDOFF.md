# HANDOFF — audit-tools

> Rolling cross-machine handoff: current state + the **ordered roadmap** of everything open. Durable
> how-to is in `CLAUDE.md`; full per-item detail in [`docs/backlog.md`](backlog.md); durable design in
> `spec/`. This handoff is the *sequencing* view — every open item appears once, in suggested order,
> with a pointer to its detail.

## Live state

- On npm as `latest` (current version tracked in `package.json`, not pinned here).
- **PUBLISHED v0.30.54 (2026-07-01):** intake stale-report-redelivery fix — a bare `remediate-code next-step`
  no longer silently re-presents a leftover `remediation-report.md` when a fresher default-discovered audit
  doc (`audit-findings.json`/`audit-report.md`) exists; `isDefaultCandidateFresherThanReport`
  (`src/remediate/steps/nextStep.ts`) folds an mtime check into `complete_redelivery`'s `freshIntent` gate, so
  the run falls through to `pending_intake` → the existing `confirm_auto_discovered_input` gate (which already
  surfaces path/type/mtime/finding-count for host confirmation). CI run 28496906825; both global bins
  reinstalled. Also added `.headroom/` to `.gitignore` (untracked local proxy state dir, was blocking the
  release clean-tree guard). Backlog entry closed.
- **PUBLISHED v0.30.53 (2026-06-30):** the **token-budget dispatch gate** (A+B+C+D — see the bullet below and
  `spec/dispatch-token-budget-gate.md`). CI run 28488590041; both global bins reinstalled.
- **PUBLISHED v0.30.51 (2026-06-30):** dogfooded full-sweep remediation of the 186-finding self-audit (15
  module nodes, all 7 HIGH fixes — citation-grounding marker, stale INFRA_FILE_PATHS, roster model routing,
  merge-to-base cleanup, flag-validation-order, stale fixtures, fragile madge test) shipped via combined
  reconciliation. Suites green (remediate 2093/0, audit 2487/0). PLUS the **per-node verify scope guard**
  (`isWholeSuiteTestCommand`) — the tooling fix for the cross-node deadlock. Deliverables:
  `.audit-tools/remediation-{outcomes.json,report.md}`.
- **Token-budget dispatch gate — SHIPPED to main (A+B+C+D), publish-pending.** Replaces the invented
  concurrency cliffs with a real budget gate: concurrency = only (1) IDE/provider subagent allowance +
  (2) token budget. Per-`(pool,window-label)` learned tokens-per-percent (windows scale differently),
  budget = MIN across a pool's windows, partitioned across pools; per-target budget view surfaced to the
  host in the dispatch step; quota-death = retryable pause (preserve worktree, strand `quota_paused` pending,
  resume clean). Design of record `spec/dispatch-token-budget-gate.md`; diagnosis
  `docs/reviews/quota-prewall-pacing-diagnosis-2026-06-30.md`; endpoint-shape finding in memory
  [[claude-usage-endpoint-body-shape]]. **Remaining (env-bound):** live validation on a real rate-limited
  multi-worker run (cold-start slope + resume path).
- **Immediate next (docs/backlog.md → Open bugs):** selective-deepening loop #2 — steward result
  `idempotency_key` collision (confirmed live, 2026-06-30). Fix is concrete and non-env-bound: incorporate
  `task_id` into `result_content_discriminator` for steward/lens-verification/deepening results so distinct
  deepening tasks get distinct ledger records (preserve INV-2 replay-no-op for same-task_id replays); update
  ledger tests. Full diagnosis: `.audit-tools/audit/deepening-loop-diagnosis.md`. **No host-side unblock exists**
  for a stuck run — the code fix must land first, then a clean re-run.
- Per-lap shipped detail is not narrated here (that's changelog creep — see git log). This doc is the
  **open-work roadmap** only: current state above, sequenced open items below.

## Cadence & standing rules (don't re-derive)

- **Risk-tier every lap** ([[risk-tier-loop-laps-cheap-vs-heavy]]): full adversarial contract pipeline only
  for risky/complex changes; trivial mechanical clusters run lean (one implementation agent → full-suite
  gate → ship). This is the *host workaround* until the self-scaling pipeline (T1) makes it the tool's job.
- **Full friction walk every lap** ([[log-all-friction-categories-every-lap]]): log all three categories
  (ambiguous-direction / tool-should-decide / inefficient-feeding) to backlog + `open_observations`; don't
  trust the empty mechanical friction set.
- **Release:** `env -u CLAUDECODE npm run release:patch:publish`; recover a bad attempt with
  `gh release delete vX.Y.Z --cleanup-tag` + forward-bump. Run gate/test with `env -u CLAUDECODE`.
  Run `env -u CLAUDECODE npm run verify:release` locally before tagging (local pre-tag gate is only `check`).
- **Branch-strand trap (bit twice this session):** a remediation run leaves you checked out on its
  worktree branch — commit/push docs from `main` (verify `git rev-parse --abbrev-ref HEAD`) or the commit
  strands off main.

---

## Suggested ordering — everything open, sequenced

Rationale: the **loop is the meta-tool**; making it cheaper, convergent, and safe has compounding leverage
on all downstream work, and is the "redesign before scheduled autonomy" the north star requires
([[autonomous-pipeline-capstone-spec]]). So: loop-infra (T1–T2) → headline capability (T3) → cheap
ergonomics (T4) → product/analysis tracks (T5) → deferred (T6).

### T1 — Self-scaling pipeline — ✅ COMPLETE
Design of record: [`spec/self-scaling-pipeline-design.md`](../spec/self-scaling-pipeline-design.md)
([[self-scaling-pipeline-not-forked-paths]]). All slices shipped: 1 degenerate-collapse, 2 shared signal,
3a depth dial, 3b lean-light-review, 4a escalate-on-evidence, **4b granularity collapse**
(`roundTripGranularityForTier`: low ⇒ framing phases fold into ONE round-trip; un-collapses on 4a escalation;
best-effort fall-back to fine-grained). _Nothing open on this track._

### T2 — Make the loop converge & safe (enables unattended autonomy)
4. **repair-cap → convergence-termination — ✅ SHIPPED.** `evaluateJudgeGate` is fixpoint-terminated:
   approved ⇒ proceed; new accepted CE ⇒ repair; all-already-addressed ⇒ escalate (blocked user-decision);
   `MAX_CONTRACT_REPAIR_ITERATIONS` is now the loud runaway backstop (2 ⇒ 8).
5. **Friction detection is mechanical-only — DESCOPED (env-bound).** Recon found `HostSessionQuotaSource.recordLimit`
   has ZERO production callers, so the whole record→escalate→strand→`quota_escalation`-friction chain is unwired
   end-to-end (not just the friction tap); validating a fix needs a live rate-limited multi-worker run. Root cause +
   seam map recorded in backlog → friction-detection entry; folds into the dispatch capability-tiered driver track.
   *([[meta-audit-friction-must-be-tool-enforced]])*
6. **P0 — data-loss on a GENUINE fail-loud — ✅ FIXED.** `quarantineUncommittedWorktreeEdits` preserves the
   worker's uncommitted source edits under a durable quarantine ref before `removeWorktree` on a commit-refusal.

### T3 — Headline product capability — ✅ COMPLETE
7. **Remediator auto-phasing — derivation + persistence + ordinal threading + scheduler barrier + per-phase
   boundary gate ALL SHIPPED.** Phase cut is PERSISTED as a first-class sidecar `intake/contract/phase_cut.json`
   (`src/remediate/contractPipeline/phaseCutArtifact.ts`); each promoted block carries a mechanically-derived
   `phase_ordinal`; the rolling scheduler enforces a HARD barrier (INV-PHASE-01, `rollingDependencyLevels`):
   foundations→consumers honoured end-to-end. **The final sliver landed 2026-06-27:** a whole-repo test-suite
   gate now runs AT each phase boundary — `phaseBoundaryToGate(state)` (pure, reblock-safe: fires once at the
   untouched entry of each phase P>0) drives `runPhaseBoundaryGate`, interposed in the `implementing` obligation
   BEFORE `buildImplementDispatchStep`. It reuses the all-terminal gate's machinery (`runToolOwnedFinalGate` +
   `applyCoarseReblock` + shared `final-gate.json` sidecar, INV-RS-09/CE-003), so a red foundations phase is
   caught + attributed to that phase before consumers build on it (earlier + more attributable than the close
   gate), and a no-human host converges deterministically. Tests: `rolling-scheduler.test.ts`
   (`phaseBoundaryToGate` predicate: phase-0-no-gate, phase-1-entry, no-re-gate-mid-phase, next-boundary,
   ordinal-free, empty-frontier, dead-ended). _Nothing open on this track._

### T4 — Remaining host-friction inventory (cheap lean laps once T1 lands)
8. **A-items (ambiguous backend direction → host had to pick): ✅ ALL SHIPPED.** A1 (blocking-critique→repair)
    + A2 (judge marked MANDATORY-independent) shipped 0.30.29. **A3 merged-base check command pinned** —
    `mergedBaseCheckArgv(root)` (new leaf module `src/remediate/steps/gateCommands.ts`, single-sourcing
    `isAuditToolsMonorepo` / `toolOwnedFinalGateCommands` so `dispatch.ts` reuses the gate's `check`-layer argv
    with no import cycle) replaces the hardcoded `"npm run check"` default; runs via `runCommand` (argv +
    CLAUDECODE scrub, no `shell:true`); `null`/skip on a non-monorepo target. _Nothing open on this track._
9. **B-items (tool-should-decide):** **B2 ✅ SHIPPED** (`buildImplementationDagScaffold` groups a module's
    obligations into ONE node via a `module` field threaded onto design_spec obligations — 1-module change derives
    1 node); **B3 ✅ SHIPPED** (advisory-critique carrier `addressed_critique_items` + `advisoryCritiqueItems()`);
    **B4 ✅ SHIPPED** (`created_at` tool-stamped, dropped from host schemas — except the lean-light-review verdict,
    a separate read-path); **B5 ✅ SHIPPED** (opt-in `merge-to-base` closing action: tool records launch branch in
    a sidecar, at close does `git merge --no-ff remediation/<runId>`, aborts+restores on conflict, base untouched
    by default — kills the strand-trap without changing the safe default). (B1 subsumed by T3.) _Nothing open on
    this track._
10. **C/D residue:** **C3 ✅ SHIPPED** (test-plan diff-carry: `captureTestPlanCarry` snapshots authored specs on
    ingest, `buildTestValidatorPlanScaffold` pre-fills assertions for obligations whose premise is unchanged —
    fail-safe toward re-author). **D1 ✅ SHIPPED** (per-spec `scope_anchors`). **D3 ✅ SHIPPED** — host INPUT path
    (`<name>.input.json`, `contractInputFilePath`) separated from the tool-owned canonical envelope (`<name>.json`):
    host writes/reads only plain `.input.json`; ingest derives the envelope (idempotent via semantic-hash, never an
    in-place re-wrap); `archiveContractArtifact` preserves the host input + clears the canonical so the gate re-fires;
    every host-facing path points at the input file. Remaining: C2 host-authored boilerplate for trivial scope
    (→ subsumed by T1). *(all in backlog → "Contract-pipeline host-friction inventory")*
11. **Selective-deepening task_id convergence** — partial fix needs a live deepening-capable run to validate.

### T5 — Product / analysis forward tracks
12. **Content-addressed granular staleness — ✅ TRACK COMPLETE (2026-06-28).** Coverage slice
    (`coverageElementBaseline.ts`), per-result ledger (`resultBaseline.ts`), design-review snapshots, git-history mine
    (`gitHistoryBaseline.ts`), and now **incremental graph-build (C2, v0.30.45)** — `buildGraphBundle` caches each
    file's per-file edge contribution keyed (real content hash + global pathLookup hash), reuses unchanged, re-extracts
    on drift; cross-file work always re-runs (`extractPerFileContribution`, `graphEdgeCache.ts`,
    `graph-edge-cache.json`). Every target where re-derive destroys expensive carried state is done; the remaining
    structure artifacts are deterministic+idempotent (preserving = gratuitous). _Nothing open on this track._
    *([[graph-signals-thin-substrate-extraction-persist]])*
13. **Tool-enforced dispatch broker — ✅ driver SELECTION + prompt rendering SHIPPED (2026-06-27).**
    `selectDispatchDriver` picks Y-dispatcher vs slot-pull vs in-process off the single classification + live
    frontier/slots (`DISPATCH_Y_DISPATCHER_MIN_ITEMS`); `renderDispatchDriverInstruction` single-sources the host
    instruction across both orchestrators. **Remaining (env-bound):** live Y-dispatcher validation (nested-agent host)
    + proactive pre-wall pacing. *(forward track)*
14. **Schema-enforced generation everywhere** — emit-time seam present; **CE-009 SHIPPED (2026-06-27):** semantic-validity
    gate hard-rejects significant `total_lines` divergence (>2 lines AND >5%) → re-dispatch, small stays S7 advisory
    (`isSignificantLineCountDivergence`). **Residual:** CE-004 (claude-code advertises no API constraint → ONE-VALIDATOR
    repair floor) is env-bound; broader semantic checks are candidates.
15. **Codebase-wide churn / context / enforce-in-tooling review** — pass run 2026-06-27
    ([`docs/reviews/churn-context-enforce-pass-2026-06-27.md`](reviews/churn-context-enforce-pass-2026-06-27.md)).
    Shipped: auth-session O(auth×files)→O(files), E1 write-scope required-param, E3 load-time executor-registry
    invariant, **E2 incomplete-coverage convergence (v0.30.44)**, **C2 incremental graph-build (v0.30.45)**.
    **X-cluster RESOLVED (v0.30.46):** adversarial verification falsified the "minimal contract + sidecar pointers"
    premise — workers never read JSON sidecars and the full `Finding` is consumed verbatim at outcomes-write
    (`close.ts:191`); only 3/12 flagged fields are truly dead (9 are live in dedup/fastpath/review/intent/close), so
    the X2 state-projection is closed as not-worth-it. Shipped the genuine win — **X1 prompt-render trim**
    (`showAdvisoryMeta` opt gates worker-irrelevant systemic/impact/likelihood; Contract Pipeline Traceability section
    removed from the implement prompt with its dead helpers; zero worker-behavior change). Low-value/needs-design-intent
    items (C3,C5,C6,E4,E5) not scheduled. **T5 #15 now has nothing scheduled.**
16. **Deterministic analyzers — own-vs-acquire acquisition engine** — build the agnostic on-the-fly
    acquire+run+normalize engine (adapters are fixture-ready). **Git-history mining ✅ SHIPPED (0.30.34)** —
    `runStructureExecutor` now wires the (previously unwired) F6 extractor: co-change → own `co_change` graph bucket
    (skipped by `allGraphEdges` so it never feeds structural signals), churn/authorship risk signals, churn ×
    complexity `risk_concentration` compound, persisted `git_history.json`. **Hidden-coupling design finding
    SHIPPED (0.30.35)** — `detectHiddenCoupling` surfaces co-change pairs with no structural edge.
    **✅ Secret scanning — own-vs-acquire CORRECTED + SHIPPED via gitleaks.** All five slices A–E done: array
    artifact model (`f5097e72`), binary runner + checksum-verified download seam (`c2a467a2`), gitleaks candidate
    (`7c393409`), **D production wiring** (`external_analyzers_current` obligation + `external_analyzer_acquisition_executor`
    + marker artifact + hermetic `externalAcquisition.{enabled,fetch,consentToken}` gate; tests
    `acquisition-executor.test.mjs`), **E surface** (findings rejoin via `buildExternalAnalyzerFollowupTasks` →
    mergeFindings, same seam as imported analyzers). Default-ON on the real CLI next-step path (gitleaks pinned
    8.21.2, PATH→cache→checksum-verified download); `session-config.external_acquisition.enabled:false` opts out;
    `consent_token` unlocks semgrep/eslint. _Nothing open on this track._ *([[deterministic-analyzers-own-vs-acquire]])*

### T6 — Deferred / waiting (env-bound or low priority)
17. A2 finding-quality oracle (needs hand-labeled corpus); A7 multi-host GUI checklist;
    manual OpenCode permission-propagation validation; gated live e2es (`RUN_NIM_E2E` etc.); provider
    `queryLimits` (revisit if a provider gains a proactive endpoint); **headroom proxy** validate-before-flip;
    narrow-staleness on prose-heavy artifacts (bounded semantic judgment, defer until churn is measured).
    *(backlog → "Deferred / waiting")*

---

## Why this order

- **T1 (self-scaling pipeline) is COMPLETE** — every later lap now pays a complexity-scaled pipeline cost, and
  the T4 host-friction items become cheap lean laps.
- **T2** — convergence-termination ✅ and no-data-loss ✅ shipped; the remaining T2 item (a real friction signal)
  is env-bound (needs a live rate-limited run) and folds into the dispatch-driver track. These are what let the
  loop run *unattended* — the precondition for the scheduled audit→remediate→PR capstone.
- **T3 (auto-phasing)** is the biggest user-facing capability but leans on T1/T2 being solid (it will generate
  many bounded laps).
- **T4** is incremental ergonomics best done *after* T1 makes them cheap; several B/C items are subsumed by
  T1/T3.
- **T5/T6** are product breadth and env-bound work that don't gate the loop.

Each lap: pick the next item, **risk-tier it** (the friction/ergonomic items → lean; T1 slices, T2, T3 →
full pipeline), ship, reinstall, **full friction walk**, update this ordering.
