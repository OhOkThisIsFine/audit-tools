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

## Defect leads found this run (tool-side)

1. **Design-review multi-lane ingest not failure-atomic** — logged in `open-bugs.md` (2026-08-06)
   and on the friction record: contract findings consumed, judge's malformed JSON hard-failed the
   call, consumed results lost, lane re-ran; host hand-repaired the JSON.
2. **Submit-side validation weaker than merge-side** — a steward worker's submit reported
   `valid`, merge later blocked it as `contract_mismatch` (followup file_paths outside
   file_coverage); the submit chokepoint should enforce the ingest contract.
3. **Terminal-cleanup friction wipe RECURRED** — at `present_report` the cleanup again deleted
   `friction/` (the just-enforced walk + the session-backstop record) while leaving `steps/`;
   record restored by hand from host context, same as 2026-08-05. Existing `open-bugs.md` entry's
   property confirmed still unheld on v0.36.0.

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

## Friction close-out

Walk completed on `friction/run.json` (7 observations, 0 attestations: 1 ambiguous_direction on
the partial-ingest exit-code contract, 4 tool_should_decide incl. the three leads above and the
tier-collapse re-observation, 2 inefficient_feeding). Record survives only because it was restored
by hand post-cleanup — see lead 3.
