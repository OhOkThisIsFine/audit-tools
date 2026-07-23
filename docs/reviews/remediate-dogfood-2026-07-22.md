# /remediate-code dogfood — first full contract-pipeline run on real audit findings (2026-07-22)

Input: the HIGH-severity slice (78 of 1480 findings, 1 work block) of the completed 2026-07-22
self-audit, as the structured machine contract. Bins: global `audit-tools@0.34.10` (current at
launch). Launch surface: primary checkout, `main`, clean tree, driven from a Claude Code
conversation via the global CLI. Run id `high-severity-self-audit-2026-07-22`.

## How far it got

Intake → confirm_intent (host-confirmed; `closing_action: merge-to-base`, `must_not_touch:
['.claude/**']`) → review-approval gate (22 strategic / 56 concrete / 0 mechanical; 21 strategic
declined as plan-only, ARC-c66ed30f kept — tiered strategic but concretely fixable) → full
contract pipeline to CONVERGENCE: goal spec, 48-entry context bundle, 8-module decomposition,
8/8 contract shards (one subagent each), seam reconciliation (28 seams, 14 reconciled), THREE
conceptual-critique rounds, TWO judge-directed contract repairs (5 accepted counterexamples
total across CE-001..CE-104; round 3's single CE-201 dispositioned residual_risk), obligation
ledger at 147/147 assessed satisfied, 139-spec test plan (POSITIVE/NEGATIVE per spec), and a
validated 8-node / 19-edge implementation DAG with full obligation/counterexample traceability.

The run then hit a hard wall at the FIRST implement wave and is left PAUSED at `collect_triage`
(resumable). No source file was modified by the run.

## The wall (diagnosed same-day; backlog carries the SPEC)

One node (CP-NODE-7, all 13 test-lens files grouped into one block) was in the dispatch plan but
no worker was ever launched; INV-RS-01 then terminal-blocked the other seven nodes. The clean
repro the "never-dispatched anti-cascade retry" backlog entry was gated on. Component defects,
each with mechanism evidence in
`.audit-tools/remediation/runs/high-severity-self-audit-2026-07-22/implement/dispatch-quota.json`:
packet cost 92,700 tokens vs a resolved 32,000-token capability floor (`model: null`) →
`no_capable_pool`, zero granted, deterministic across two triage-retry cycles; the node
DISPOSITION misreported this as "worker did not produce a result file" while the true reason sat
in `explains[]`; the host-capability handshake flags (`--host-context-tokens 200000` …) did NOT
thread into the implement-wave capability resolution (G4-residue parallel-channel class, remediate
draw); and the oversized node was never split at plan time despite the split machinery existing.

## What worked notably well

- The determinism split: skeletons/ids/anchors/dependencies derived by the tool; agents filled
  only judgment slots. Zero structural rework across ~15 delegated agents.
- The convergence loop was REAL: critics found genuine defects each round (a live contradiction
  about the just-shipped v0.34.8 fix; three orphaned findings; status-quo-blessing boundaries; a
  two-lock crash-window gap; an asymmetric write-path guard), judges refuted over-claims against
  clause text, and the loop tightened monotonically (3 accepted → 2 → 0).
- HEAD premise verification threaded through: shard agents and the plan independently flagged the
  v0.34.8–v0.34.10 shipped clusters as pin-with-regression-only, never re-implement.
- The freshly-shipped dispatch-legibility explain records made the wall diagnosable in minutes.

## Friction highlights (full walk on the run's friction record; per-item entries in backlog)

Crash-not-pause on a stale legacy `.remediation-artifacts/session-config.json`; `.input.json`
prompt-vs-disk artifact naming tripping four separate agents; the test-plan polarity heuristic
requiring undocumented `POSITIVE:`/`NEGATIVE:` prefixes (misread 115 unlabeled assertions);
free-form-intent clause splitter fragmenting prose; full back-half re-verification per contract
mutation (carry-forward worked only because each agent was hand-instructed to reuse
byte-identical entries — the tool should pre-carry); module-wave concurrency cap of 2 for 8
modules; a plain `next-step` on the run's own in-progress state demanding a resume ack.

## Resume protocol

Fix the implement-dispatch defect cluster (backlog: "never-dispatched" entry, now
mechanism-complete), then RESUME this run (state is `waiting_for_triage`; triage answer = retry
all 8) rather than re-launching — the converged contract set and DAG are on disk and current.
