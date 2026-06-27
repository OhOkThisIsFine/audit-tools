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

### T3 — Headline product capability
7. **Remediator auto-phasing — derivation + persistence + ordinal threading + scheduler barrier SHIPPED; one
   sliver remains.** Phase cut is now PERSISTED as a first-class sidecar `intake/contract/phase_cut.json`
   (`src/remediate/contractPipeline/phaseCutArtifact.ts`: `ensurePhaseCutArtifact` derives from
   `finalized_module_contracts`, single-sourced for both the critique render and the DAG promotion — deliberately
   NOT in `CP_ARTIFACT_NAMES` so it doesn't perturb the LLM-phase staleness DAG). Each promoted block carries a
   mechanically-derived `phase_ordinal` (max over its node's obligations, mapped to the owning module by the
   `OBL-<moduleSlug>-…` id fragment via `phaseOrdinalForObligations`; CE-only/unmatched → last phase). The rolling
   scheduler enforces it as a HARD barrier (INV-PHASE-01, `rollingDependencyLevels`): a higher-phase block never
   enters a dispatch level until every lower-phase block is verified-complete — foundations→consumers honoured
   end-to-end. Tests: `phase-cut.test.ts` (module_phase / `phaseOrdinalForObligations` / sidecar persistence),
   `rolling-scheduler.test.ts` (INV-PHASE-01 barrier). **Remaining sliver:** an EXPLICIT whole-repo test-suite
   gate run AT each phase boundary and surfaced to the user (today: per-node verify gates each block + the barrier
   guarantees ordering, but no full-suite run is interposed between phases — only at close). *(backlog →
   remediator-decompose entry; [[remediator-must-decompose-and-boundary-enforce]])*

### T4 — Remaining host-friction inventory (cheap lean laps once T1 lands)
8. **A-items (ambiguous backend direction → host had to pick):** A1 blocking-critique-in-non-rejected-verdict
    should route to repair; A2 judge-independence unstated; A3 merged-base check command unpinned.
9. **B-items (tool-should-decide):** B2 DAG node merge-vs-split left to host; B3 advisory-critique items have
    no structural slot; B4 host-invented timestamps; B5 remediation→main merge left to host. (B1 whole-backlog
    phase-cut is subsumed by T3.)
10. **C/D residue:** C2 host-authored boilerplate for trivial scope (→ subsumed by T1); C3 unchanged
    obligations re-authored each repair round (no diff-carry); D1 CE-006 negative-scoping reports only after
    write (pre-write anchor hint); D3 validate-artifact in-place re-wrap (write-plain-then-it-wraps hazard).
    *(all in backlog → "Contract-pipeline host-friction inventory")*
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
