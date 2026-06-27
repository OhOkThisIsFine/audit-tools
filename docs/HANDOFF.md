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

### T1 — Make the loop cheaper: self-scaling pipeline (HIGHEST compounding leverage)
Design of record: [`spec/self-scaling-pipeline-design.md`](../spec/self-scaling-pipeline-design.md)
([[self-scaling-pipeline-not-forked-paths]]). **Slices 1, 2, and 3 (both dials of the adversarial-depth
slice) shipped** — slice 3a (depth dial on the contract pipeline) 0.30.23, slice 3b (lean fast path softened
to a mechanically-gated light review: verdict artifact + resume intercept, clear⇒lean plan, concern⇒escalate
risk signal + full pipeline) 0.30.24. Remaining:
1. **Slice 4b — granularity collapse** *(NEXT)*: round-trip count = f(complexity); collapse coherent authoring
   phases into fewer round-trips for low-tier work (the design's "one coherent act of authoring → ONE
   round-trip producing several artifacts"), keep fine-grained for medium/high. **Slice 4a (escalate-on-evidence
   / optimistic-start) shipped** — `decompositionRiskEvidence` + an in-band intercept at the top of
   `buildNextContractPipelineStep` raises the persisted intake risk signal once decomposition reveals the real
   shape (>1 module ⇒ ≥medium; module file_scope touches a risk subsystem ⇒ high), so the depth dial tightens on
   the same and every later next-step (idempotent/convergent via `escalateRiskSignal`). 4b builds on 4a: when the
   collapsed low-tier framing surfaces complexity, the 4a escalation un-collapses the structural seam/finalize
   phases (already structural, slice 1) and drives full adversarial depth (slice 3a).

### T2 — Make the loop converge & safe (enables unattended autonomy)
4. **repair-cap → convergence-termination** — replace the magic N=2 judge/repair cap with fixpoint
   termination (stop when a round yields no new accepted counterexample) + escalate-on-stall; hard cap stays
   only as a loud backstop. *(forward track; lap-1 converged within the cap but a 3rd new CE would've been cut.)*
5. **Friction detection is mechanical-only** — the meta-audit gap: emitters captured 0 events again this
   session despite turbulent runs. Needs per-event reconciliation at the step boundary (auto-capture phase
   re-emit / artifact reject / repair round / no-change merge; close-out forces host to disposition each) so
   "settled" has a real signal. *(backlog → friction-detection entry; [[meta-audit-friction-must-be-tool-enforced]])*
6. **P0 follow-up — data-loss on a GENUINE fail-loud** — 0.30.17 removed the false-positive trigger, but a
   real generated-artifact-under-scope fail-loud still drops the worker's uncommitted edits before removing
   the worktree. Quarantine (stash/patch) before removal. *(backlog → P0 entry, item 2)*

### T3 — Headline product capability
7. **Remediator auto-phasing** — take an arbitrary N-goal input and auto-derive the foundations→consumers
   phase cut from the dependency DAG (today the host picks the phase at intake via AskUserQuestion). The
   decompose + boundary-enforce + scheduling-dep substrate is shipped; the auto phase-cut is the unshipped
   core. *(forward track; [[remediator-must-decompose-and-boundary-enforce]])*

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

- **T1 first** because every later lap pays the pipeline's cost — making it self-scale compounds across all
  of T3–T5, and turns the T4 host-friction items into cheap lean laps. (Slice 1 shipped; Slice 2 — the shared
  intake risk signal both dials read — is next.)
- **T2 next** because convergence-termination + a real friction signal + no-data-loss are what let the loop
  run *unattended* — the precondition for the scheduled audit→remediate→PR capstone.
- **T3 (auto-phasing)** is the biggest user-facing capability but leans on T1/T2 being solid (it will generate
  many bounded laps).
- **T4** is incremental ergonomics best done *after* T1 makes them cheap; several B/C items are subsumed by
  T1/T3.
- **T5/T6** are product breadth and env-bound work that don't gate the loop.

Each lap: pick the next item, **risk-tier it** (the friction/ergonomic items → lean; T1 slices, T2, T3 →
full pipeline), ship, reinstall, **full friction walk**, update this ordering.
