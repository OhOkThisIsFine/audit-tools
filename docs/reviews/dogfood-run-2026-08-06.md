# Dogfood self-audit — 2026-08-06 (v0.36.0)

Run `20260806T054657426Z_audit_tasks_completed_001` on HEAD `2b6ba83e` (v0.36.0), fresh state,
offload ON. First live exercise of charter-layer v2 and the designated re-test for the 2026-07-30
live-run-watch cluster. Wall clock ~5.8h (05:07Z–10:56Z), ~37M subagent tokens, all bulk dispatch
on tier-mapped offload pools (zero null agent results across every pass).

## Configuration

Scope 1,199 files; lenses = mandatory 4 + architecture, maintainability, tests, config_deployment,
performance (owner flipped performance in); operability/observability excluded per proposal. Deep
conceptual review (5 perspectives + judge).

## Outcome

**1,925 findings / 133 work blocks**, promoted to `.audit-tools/audit-report.md` +
`audit-findings.json`. Severity: 9 critical / 125 high / 1,144 medium / 641 low / 6 info.
Lens spread: maintainability 1,406, tests 337, architecture 60, data_integrity 46, correctness 36,
reliability 33, performance 3, security 3, config_deployment 1. Grounding S7: 682 grounded /
127 ungrounded (surfaced-not-confirmed). 585 files fully audited, 189 excluded non-auditable.

Pipeline shape (packets/tasks → accepted, findings): pass1 309/635 → 568, 662; pass2 44/231 → 175,
87; pass3 11/72 → 64, 18; pass4 2/14 → 5, 4; pass5 2/10 → 7, 0; pass6 1/3 → 2, 0; pass7 1/1 → 1,
0. Selective deepening added 187 tasks across passes. Pre-dispatch: charter v2 (3 blind lanes +
delta miner: 4 stated↔structural/revealed deltas over 7 subsystems, triangulated goal graph),
design review (contract 6 findings; conceptual 53 → 30 judge-merged), systemic challenge converged
in 4 rounds (13 accepted).

## Charter-layer v2 first exercise

Worked end-to-end: per-kind blind lanes submitted independently; the stated lane was quarantined
once (cited directory scopes not named in the evidence packet) and resubmitted clean — the
validator's message was sufficient to repair without seeing other lanes. Delta miner produced
genuine cross-channel disagreement (4 deltas), suggesting blindness held. No True nominations.

## Defect leads found this run (tool-side) — ALL THREE FIXED 2026-08-06 (same-day lap)

1. **Design-review multi-lane ingest not failure-atomic** — contract findings consumed, judge's
   malformed JSON hard-failed the call, consumed results lost, lane re-ran; host hand-repaired
   the JSON. FIXED at the class chokepoint: `readJsonFile` throws a typed `JsonParseError` and
   `tryConsumeIncoming` returns `ok|absent|malformed` — every incoming consumer (design-review
   lanes, charter lanes, omittable gates, intent-equivalence, edge-reasoning, object/array
   consumers) quarantines a malformed submission instead of hard-failing, so a sibling lane's
   validated results always persist.
2. **Submit-side validation weaker than merge-side** — root cause was the INVERSE of the lead's
   framing: submit passes the packet-wide `boundaryPaths` union (the pinned intended contract,
   F-6) and merge validated per-task only. Merge now reconstructs the identical packet boundary
   from `pending-audit-tasks.json` — exact parity, same validator, same error text.
3. **Terminal-cleanup friction wipe RECURRED** — fixed on both halves:
   `archiveFrictionRecords` (shared) copies `friction/*.json` beside the promoted deliverables
   (`audit-friction-*.json` / `remediation-friction-*.json`) before the terminal rm on both
   orchestrators, and `friction-stop-gate.mjs` no longer treats a bare `steps/` dir (exactly the
   post-terminal state) as an audit run-marker. The 2026-07-25 revert's three constraints all
   hold: fix targets `promoteFinalAuditReport`, remediate marker semantics unchanged, and no
   record is preserved in-place across runs (the run-id collision is moot — friction/ is deleted
   with the dir; the archive is what survives).

## Live-run-watch cluster re-test (2026-08-05 minor-friction items, on v0.36.0)

- Full auditor-handshake JSON re-echoed in every step payload/prompt — **still present**.
- Tier routing collapse: 301/309 packets → deep — **still present**.
- Silent long next-step derivation — **still present** (one call exceeded 300s with no progress
  output and was backgrounded by the host harness).
- Staleness event-line spam — **still present** (~29× identical lines one call, ~15× another).
- Observability lens rationale ("no logging/metrics surface detected") beside a JSONL ledger —
  **still present** in the confirm-intent table.
- Resumed-run scope-echo skip — n/a (fresh run). Charter blindness leak — not reproduced (deltas
  were genuine; single quarantine was path-shape, not leakage).

## Critical-findings verification (post-run, 2026-08-06)

All 9 critical findings adversarially verified by mechanism against HEAD (9 independent
verifier agents, several findings double-sampled; verdict directions stable across samples).
**None survived as critical**: 3 refuted, 6 real at high/medium.

- **Refuted (3):** ARC-03034c94 drain-memoization (fresh bundle object per iteration; WeakMap
  cache is per-call — the claimed reuse cannot occur); ARC-843a544c file-lock stale-reap clobber
  (token-checked 10s heartbeat + serialized steal; pinned by INV-SCC-08 in
  `tests/shared/fileLock.test.ts`); ARC-cd75f23a contradictory merge outcomes
  (`collapseItemResults` reconciles by status priority; pinned by
  `dispatch-merge-tolerance.test.ts`).
- **Confirmed, downgraded (6):** ARC-e01faa3e provider auto-selection is construction-time-only —
  no runtime re-detection/fallback when the resolved provider dies mid-run (HIGH; new backlog
  entry). ARC-426f9398 partial — input-side tokens-per-pct slope learning EXISTS and feeds wave
  sizing; the real defect is `recordOutputRatioObservation` is dead code, so output reservations
  never learn (new backlog entry). REL-80b59c13 partial — a task-file read/parse failure exits the
  worker without writing the failed WorkerResult that validation failures write ("stall" half
  refuted: runCli exits 1) (new backlog entry). REL-e362503b partial — remediate node-claim leak
  on a pre-release throw; folded into the existing open-bugs LEAD on remediate's claim lifecycle.
  REL-03034c94 — already tracked (the >2min no-progress-signal entry). ARC-c9869af2 partial —
  analyzer parse layers are defensive (malformed → `[]`); residual (corrupt-but-parseable output
  persisting) is what leads-not-verdicts + lens confirmation already bound; no entry.
- **Meta-lead:** 0/9 auditor criticals justified on verification — top-tier severity assignment is
  inflated (logged in `open-bugs.md`; calibration data for the A2 finding-quality oracle track).

## Friction close-out

Walk completed on `friction/run.json` (7 observations, 0 attestations: 1 ambiguous_direction on
the partial-ingest exit-code contract, 4 tool_should_decide incl. the three leads above and the
tier-collapse re-observation, 2 inefficient_feeding). Record survives only because it was restored
by hand post-cleanup — see lead 3.
