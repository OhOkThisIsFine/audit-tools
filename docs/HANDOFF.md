# HANDOFF — audit-tools

> Rolling cross-machine handoff: current state + the **ordered roadmap** of everything open. Durable
> how-to is in `CLAUDE.md`; full per-item detail in [`docs/backlog.md`](backlog.md); durable design in
> `spec/`. This handoff is the *sequencing* view — every open item appears once, in suggested order,
> with a pointer to its detail.

## Live state

- On npm as `latest` (current version tracked in `package.json`, not pinned here). `main ==
  audit-tools/main`, clean tree, both global bins reinstalled to the live release.

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
12. **Content-addressed granular staleness — general DAG extension** — per-file coverage-matrix elements +
    per-element baselines + an incremental planning executor (the result-path is shipped; the general
    DAG-model change remains). *(forward track; [[graph-signals-thin-substrate-extraction-persist]])*
13. **Tool-enforced dispatch broker — capability-tiered driver** — `HostSessionQuotaSource` + single-struct
    classifier shipped; the Y-dispatcher-vs-slot-pull driver + proactive pre-wall pacing remain. *(forward track)*
14. **Schema-enforced generation everywhere** — emit-time seam present; CE-004 (claude-code advertises no
    API constraint → ONE-VALIDATOR repair floor) + CE-009 (semantically-wrong-but-schema-valid) are residual.
15. **Codebase-wide churn / context / enforce-in-tooling review** — run the append-only/granular-staleness
    perspective over the whole codebase as a dedicated pass.
16. **Deterministic analyzers — own-vs-acquire acquisition engine** — build the agnostic on-the-fly
    acquire+run+normalize engine (adapters are fixture-ready); + **git-history mining** as an owned
    language-agnostic extraction source. *([[deterministic-analyzers-own-vs-acquire]])*

### T6 — Deferred / waiting (env-bound or low priority)
17. A2 finding-quality oracle (needs hand-labeled corpus); A7 multi-host GUI checklist + gated Codex e2e;
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
