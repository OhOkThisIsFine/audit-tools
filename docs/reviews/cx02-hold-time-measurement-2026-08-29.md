# CX-02 live fresh-audit hold measurement — 2026-08-29

The measurement the CX-02 record deferred: a live fresh audit, capturing per-fold artifact-tree
lock HOLD TIME and charged-execution count, to decide the cap value and whether the waiter
timeouts need widening.

## Setup

- **Target:** a disposable git worktree of audit-tools at `c4559ec0` (1,051 files in scope),
  `npm install` done, prior `.audit-tools` artifacts removed so the audit was genuinely fresh.
- **Driver:** the main checkout's `audit-code.mjs` with the new `fold_hold` telemetry
  (`run.log.jsonl` event: `duration_ms` = the in-hold span of the full `next-step` fold,
  `executions` = the engine's own charged-execution count, exposed on `AdvanceResult`).
- **Hermetic machine state:** `AUDIT_CODE_STATE_DIR` pointed at session scratch, so consent
  decisions died with the run.
- **Analyzer consent:** `eslint`/`knip`/`jscpd` granted (repo-local); `semgrep`/`osv-scanner`
  declined (network egress — an owner call, not a sandbox call).
- **Intent:** lens table per the deterministic proposal; shallow conceptual depth.
- Constants at HEAD: `MAX_DRAIN_STEPS` 64; `withFileLock` waiter timeout 10 s;
  `LOCKED_JSON_STORE_TIMEOUT_MS` 20 s; `STALE_LOCK_MS` 30 s.

## Fold table (one row per `next-step` invocation)

| # | hold ms | charged executions | fold content → emitted step |
|---|---------|--------------------|------------------------------|
| 1 | 44,405 | 4 | manifest, disposition, auto-fix, syntax resolution → `analyzer_consent` |
| 2 | 58,473 | 4 | consent ingest, analyzer spawns, graph build (1,074 nodes / 4,752 edges) → `critical_flow_fallback` |
| 3 | 22,017 | 7 | critical-flow ingest, downstream derivation → `confirm_intent` |
| 4 | 1,873 | 3 | intent ingest → `design_review_parallel` |
| 5 | 9,300 | 6 | design-review ingest, planning, charter, 739-item workload emission → `dispatch_review` |
| 6 | 7,485 | 2 | 1 host result ingested, workload re-emitted (738 pending) |
| 7 | 1,895 | 1 | 0 results visible (see the re-mint note), workload re-emitted |
| 8 | 6,278 | 2 | 2 host results ingested, workload re-emitted (736 pending) |

Wall clock per invocation ran 1.0–1.9 s above hold time (CLI startup + render, outside the lock).

## What the numbers decide

1. **The cap does not bind — keep `MAX_DRAIN_STEPS` at 64.** The worst fold charged 7
   executions; the eight folds together charged 29. No re-size is supported by this run: raising
   it buys nothing, and lowering it buys nothing either (the budget stop is graceful and
   resumable, so an unused cap costs zero). The `tolerance < MAX_DRAIN_STEPS` contract keeps 16
   as the floor if it is ever revisited.
2. **The waiter timeouts are the real exposure.** Three frontier folds (44.4 s, 58.5 s, 22.0 s)
   exceed BOTH waiter windows; even steady-state ingest folds (6–9 s) graze the 10 s lock
   timeout. Any concurrent CLI — a second `next-step`, `review-run`, an analyzer-policy write —
   during the frontier fails deterministically with `FileLockTimeoutError`. This confirms the
   CX-02 record's contention cost on a real run. Hold time scales with repo size and granted
   analyzers, so 58.5 s on a 1,051-file repo is a floor for larger targets, not a ceiling.
   **DECIDED (owner, 2026-08-29) and landed the same day:** the waiter window widens to
   `ARTIFACT_TREE_LOCK_TIMEOUT_MS` (120 s), WAITER-SIDE ONLY — the 30 s stale window and the
   heartbeat stay per the owner's 2026-08-28 decision. `withArtifactTreeHold` is now the single
   acquisition surface for this lock and carries the window; the contract test
   `tests/audit/artifact-tree-lock-single-surface.test.ts` pins both halves.
3. **Ingest folds charge per batch, not per result** (1 result → 2 executions; 2 results → 2
   executions), so host batch size cannot push a fold into the cap.
4. **Ingest-fold hold is O(pending), not O(ingested).** Every partial ingest re-materializes the
   ENTIRE remaining workload under a NEW run id with new bound result paths and prompt digests
   (~6–9 s per call at 736–739 pending). Two consequences: aggregate re-bind work across a run is
   O(N²) in task count, and a result written to a PREVIOUS run's bound path is silently invisible
   — observed live in fold 7 (see below).

## Observed live, routed to the backlog

- **Silent rejection + run re-mint swallows late results.** Two of three sample host results were
  rejected for one extra envelope key (`reviewed_clean` — ingestion computes it and the exact-key
  check refuses it) with ZERO diagnostic anywhere: no stderr, no step-JSON note, no ledger event.
  The next fold re-minted the run, and the step prompt then reported those items as
  `submission_missing` under the new run id, while the files sat intact at the old run's bound
  paths. Appended to the existing rejected-submission entry in `docs/backlog/open-bugs.md`.
- **`next-step --help` executes a real step** — logged in `docs/backlog/open-bugs.md`
  (2026-08-29).

## Unmeasured arms, stated

- Synthesis-scale folds (after all 739 results) and the charter-clarification / systemic-challenge
  policy loops were not driven — fulfilling 739 semantic tasks is outside one measurement lap.
  Both loops consume one host submission per call, so per-fold executions stay small by
  construction; their hold spans are ingest-shaped (bounded by the O(pending) re-bind above).
- Per-obligation attribution INSIDE a fold: the fold emits no `executor_start`/`executor_end`
  events (the `RunLogEventKind` vocabulary exists; the audit side never emits it), so the 58.5 s
  fold is attributable only coarsely (analyzer spawns + graph build dominate by elimination).

The raw `run.log.jsonl` fold events are reproduced in the fold table verbatim; the worktree and
its state dir were disposable and are removed.
