# Remaining-specs remediation plan (whole actionable backlog)

Point-in-time **plan** produced 2026-06-20 by `/remediate-code over docs/remaining-specs.md`.
Scope decision (Ethan): **whole actionable backlog**; this session **finishes the plan
and defers all implementation**. Collapse / delete sections here as items ship.

> Machine source of truth: the validated contract-pipeline artifacts under
> [`.audit-tools/remediation/intake/contract/`](../.audit-tools/remediation/intake/contract/)
> (gitignored). The remediation run is **paused at the pre-implementation
> review-approval gate** — resume to build (see *Resuming the build* below).

## What this plan covers

14 modules, one per actionable backlog item (already-shipped F-2/F-3/F-5/F-6/F-7/PB-1 and
deferred-by-design F-4/PB-2 excluded). Each module carries: a finalized seam contract,
its invariants + failure-mode obligations (162 total), a per-obligation test-validator
plan (148 positive+negative specs), and a build node in the implementation DAG with
verification commands.

The plan went through the full adversarial gauntlet (independent agents): conceptual
critique → contract assessment (132 satisfied / 30 uncertain) → 13 counterexamples →
judge (all 13 = **residual_risk**, recorded for build). The counterexample fixes are
**folded into the module designs** below.

## DECISION resolutions (Ethan-confirmed 2026-06-19/20)

| Q | Item | Decision |
|---|---|---|
| Q-001 | A2 CI | **track-don't-gate** — emit scorecard, fail only on hallucination-rate regression |
| Q-002 | A9 | **stop-at-branch** — hermetic, no PR/GitHub |
| Q-003 | DC-2 | **timestamp + roster-snapshot** re-confirmation |
| Q-004 | DC-5 | **deterministic heuristic + LLM-confirm** classification |
| Q-005 | F-1 | **take this run** (not deferred) |

## Build order (dependency DAG)

```
INV-2 ─► A-10 ─► A-8 ─┬─► DC-6
                      └─► DC-2
DC-3 ─► DC-5
DC-4 ─► F-1
A-8, A-10, DC-6, DC-2 ─► A-9   (capstone, last)
DC-1, A-2, A-7, INV-1          (independent, any time)
```

## The 14 modules

**Bounded fixes (worker-buildable, hermetic):**
- **IMPL-dc1 — DC-1 free-form-intent escalation.** Unencodable clauses block the audit
  intent checkpoint, keyed on **clause identity** (not the rendered `checkpoint_question` —
  fixes CE-004 collision); headless path auto-records an answer to converge. Remediate folds
  structured intent into ordering, honors `readSharedProviderConfirmation` without blocking
  standalone, never threads `free_form_intent` verbatim (sentinel guard).
- **IMPL-dc3 — Parallel per-module contract phases.** Fan out drafting/finalization one
  agent-per-module through `waveScheduler`; merge complete-before-`deriveObligationLedger`.
  Edits only wave-dispatch/merge (S3 partition, disjoint from dc5).
- **IMPL-dc4 — Audit pause / scope-annotate / fold-ingest.** Pause resumably **only after
  a8 spill exhausted**, sharing the `SettledExclusionSet` (CE-001/CE-009); annotate
  design-review units from **structured** IntentCheckpoint scope only; fold `mergeAndIngest`
  into the dispatch turn (identical staleness DAG).
- **IMPL-dc5 — Paired pos/neg test-specs.** Deterministic touches-existing-symbol heuristic
  **then** LLM-confirm (fixes CE-013); behavior-change ⇒ paired specs, negative scoped to the
  changed symbol via an **anti-rot predicate** (fixes CE-006); enforced at derivation + the
  `mergeImplementResults` verify gate.
- **IMPL-f1 — Prose-staleness projection.** Field-by-field narrowing, each exclusion tied to a
  byte-identical-prompt proof (CE-008 strengthens to *every* downstream consumer); dc4's
  per-unit scope **determination** stays in the projection (only cosmetic tag text excluded).
- **IMPL-dc2 — Shared provider-confirmation Gate-0.** Single-sourced
  `.audit-tools/provider-confirmation.json`, atomic temp-then-rename under `withFileLock`;
  accessor returns `null` on absent/malformed but a **distinct re-confirm signal** on
  roster-stale (CE-012 third state, resolves the INV-DC2-3 vs INV-DC1-6 contradiction).
- **IMPL-inv1 — Deterministic-analysis memo.** `docs/inv-1-deterministic-analysis-memo.md`
  **only** — per-lever build/defer/reject; no analyzer built, no dep added.

**Architecture / dispatch interlock (one subsystem — critique C-001 — build together):**
- **IMPL-a10 — Claim registry.** On-disk `ClaimRegistry` (claim/release/reclaimStale/
  listClaims) entirely inside `withFileLock`; reuses the 30s `STALE_LOCK_MS`; token-checked
  reclaim. CE-002 lifecycle gap closed at the accept/merge layer by a8.
- **IMPL-a8 — Hybrid spill coordinator.** Claim each node via a10 **before** any assignment
  (exactly-one-claimant); co-owns the shared `SettledExclusionSet` with dc4 (CE-001);
  proactive capacity split; folds inv2's raw signals to slots **only** through the shared
  `scheduleWave` (S4); emits the sole "all pools exhausted" pause signal.
- **IMPL-dc6 — Host-subagent rolling driver.** JIT-spawn next node per `accept-node` through
  the **same** a8 coordinator + a10 registry; identical `acceptNodeWorktree` lifecycle;
  partition dispatch.ts vs dc5 over the verify gate (CE-007); legacy wave = conversation-first
  fallback.

**Quality / validation / capstone:**
- **IMPL-a2 — Finding-quality oracle.** Deterministic `score-audit`; matches only by
  `findingIdentitySignature`; surfaces CE-010 signature collisions as unmatched; exit code
  wired solely to hallucination-rate.
- **IMPL-a7 — Multi-host validation gate.** `verify:hosts` deploys to a temp `$HOME`, re-runs
  each host's `verify()` from the **same** `INSTALL_HOST_DEFINITIONS` table; into
  `verify:release`; Codex live e2e (gated) + `docs/host-validation.md` checklist.
- **IMPL-a9 — Autonomy acceptance e2e (capstone).** Gated `RUN_AUTONOMY_E2E`; seeded fixture
  driven audit→remediate to `complete`, zero host steps, branch with commits, green gate,
  reconciled ledger (0/0 vacuous green **fails**). Last — exercises a8/a10/dc6/dc2 (CE-011).

## Externally-blocked — can't complete in a hermetic worker run

These need live credentials / a real model / human input. Their **unit/hermetic** parts are
worker-buildable; the live parts are gated e2e to run on demand:
- **A-8** live cross-provider run (`RUN_NIM_E2E=1`: Claude session + NIM key).
- **A-9** autonomy e2e (`RUN_AUTONOMY_E2E=1`: cheapest real provider).
- **INV-2** per-source validation against the 6 real provider endpoints.
- **A-7** Codex headless live-dispatch e2e.
- **A-2** corpus **labels** are human-applied (`true_positive`/`false_positive`/`hallucinated`).

## Design-risk register (13 residual-risk counterexamples)

Each is a real flaw whose fix is a build-time decision; all are folded into the module
designs above and recorded in
[`counterexample.json`](../.audit-tools/remediation/intake/contract/counterexample.json) +
[`judge_report.json`](../.audit-tools/remediation/intake/contract/judge_report.json).

| CE | Module | Flaw (now addressed in the design) |
|---|---|---|
| CE-001 | a8 | shared exclusion set is a `ReadonlySet` rebuilt each pass → co-derive, don't mutate |
| CE-002 | a10 | stale-steal at 30s window double-merges → token-checked accept/merge layer |
| CE-003 | dc2 | lockless read races the writer rename → atomic temp-then-rename under lock |
| CE-004 | dc1 | `checkpoint_question`-keyed dedup drops a clause → key on clause identity |
| CE-005 | dc1 | substring no-verbatim guard false pos/neg → guard on structured fields |
| CE-006 | dc5 | anti-rot negative-scope has no predicate → explicit scoped-to-changed-surface predicate |
| CE-007 | dc6 | dc5+dc6 both edit `mergeImplementResults` → declared file partition |
| CE-008 | f1 | field read transitively → prove unread by *every* downstream consumer |
| CE-009 | dc4 | folded ingestion shifts A9 ledger state → stale-set equivalence test |
| CE-010 | a2 | `findingIdentitySignature` non-injective → surface collisions as unmatched |
| CE-011 | a9 | capstone ran single-pool path → sequenced after a8/a10/dc6/dc2 |
| CE-012 | dc2 | single `null` meant both re-confirm and never-block → distinct third state |
| CE-013 | dc5 | render-only change misread as addition → deterministic+LLM classify |

## Resuming the build

The run is paused at the review-approval gate. To build:

```
remediate-code next-step          # re-presents the gate
# approve all (write empty disapproved list) or disapprove specific IMPL-* findings:
#   .audit-tools/remediation/review_resolution.json  → {"disapproved_findings":[],"disapproved_tiers":[]}
remediate-code next-step          # proceeds to documenting → implementing
```

Recommended (per the multi-session reality): build in **dependency-order slices**, not one
mega-run — e.g. the independent bounded fixes (dc1, dc3, f1+dc4, dc5, inv1) first as
clean ships, then the dispatch interlock (inv2→a10→a8→dc6/dc2 as one track), then a2/a7,
then the a9 capstone. The live-dep modules' hermetic parts build now; their gated e2e run
when creds are present.
