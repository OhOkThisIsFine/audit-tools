# Meta-review — /remediate-code run 2026-07-30 (free-lane delegation + wide-view process walk)

**Run:** `remediate-audit-2026-07-30`, consuming the 2026-07-30 self-audit (2,100 findings, 121
high) under the operator directive *delegate every LLM step to free lanes; primary quota is low;
take a wide view of the process itself*. Companion to
[`meta-review-audit-run-2026-07-30.md`](meta-review-audit-run-2026-07-30.md). Per-event friction
authority: `.audit-tools/remediation/friction/*.json`; this document is the wide-view synthesis.
*(Status: written mid-run at the implement phase's false-abandonment recovery; finalized at close.)*

## Delegation outcome

Every LLM judgment step ran on a non-Anthropic lane; primary quota was spent on orchestration only:

| Step | Lane |
|---|---|
| intake synthesis (judgment half; stats pre-digested deterministically host-side) | agy-gemini flash-high |
| goal spec + context bundle | deterministic host-side (no LLM at all) |
| module decomposition (35-file verification) | tier-offload → pool/coding |
| 9-shard contract drafting wave | tier-offload (2× pool/reasoning, 7× pool/coding) |
| seam reconciliation | agy-gemini flash-high |
| conceptual critique + 4 diff re-reviews | tier-offload → pool/reasoning (fresh reviewer each round) |
| contract repair ×4 rounds | tier-offload → pool/reasoning (same agent resumed — authorship continuity) |
| 184-spec test-plan fill (×3 re-emits, carry-aware) | 9 + 1 + 1 agents → pool/coding |
| contract assessment ×3 | pool/reasoning (same assessor resumed) |
| adversarial critic ×3, adversarial judge ×3 | pool/reasoning (fresh each) |
| implementation DAG fill | pool/reasoning |
| implement workers (per-node worktrees) | pool/coding |

## The adversarial contract loop did real, escalating work

Convergence trajectory across five review rounds and four repairs: **9 blocking → 3 → 1 → 4
accepted counterexamples → 1 invalid counterexample → approved (193/193 obligations satisfied)**.
Highlights that argue the machinery is earning its cost:

- The first independent critique found two live tool defects and verified them at HEAD:
  `derive.ts` silently coerces a non-string `validation_boundary` to `""` (contract data loss past a
  validator whose invariant claims otherwise), and `phaseCut.ts`'s `computeTier` back-edge bug split
  cycle members one-per-tier (the run's own `phase_cut.json` was the falsifying artifact). Both
  became remediation obligations in the run's ledger.
- Round-2 critics falsified contract claims by re-deriving the CURRENT phase cut and diffing it
  against contract text; the judge independently re-verified each counterexample against source
  before accepting, and rejected one fabrication-shaped defense CE as invalid.
- The repair agent following directives LITERALLY left contradictory sibling clauses twice
  (seam fixed, `side_effects` missed) — caught both times by the diff re-reviewer. Lesson: a repair
  directive should mandate a module-wide sweep for sibling statements of a retracted mandate.

## The false abandonment (the run's biggest finding)

After the 2-node Phase-0 wave landed green, the phase-1 boundary gate (`npx vitest run --retry=2`)
went red twice and the no-human backstop **abandoned all 13 items and closed the run "complete"**.
The red was `backlog-budget-unit.test.ts` — tripped by the DRIVER's own uncommitted
`docs/backlog/open-bugs.md` edit sitting in the working tree, entirely unrelated to the
remediation's changes. Three properties failed at once (backlog entry, HIGH):

1. the gate ran on the live tree and attributed dirt it didn't cause to the run;
2. `final-gate.json` persisted only `{coarse_reblock_count, terminated}` — no failing output, so the
   abandonment was undiagnosable from the record;
3. an unattributable whole-run abandonment got a terminal close rather than a resumable pause
   (contrast: `no_capable_pool` pauses resumably).

Recovery: backlog condensed under its byte ceiling, suite green, falsely-abandoned items reopened by
recorded state surgery, run re-driven.

## Process-shape observations

- **Right-tool splits worked.** Deterministic pre-digestion (findings histograms, goal/context
  artifacts, skeleton extraction, merge/gate checks) kept every LLM packet small; the tool's own
  pre-filled skeletons (test plan: obligation ids/kinds/anchors; DAG: nodes + dependencies from
  artifact tokens) are exactly the right division — the host fills judgment slots only.
- **The test-plan carry mechanism** preserved 173/184 then 176/184 specs across contract re-emits;
  only changed obligations re-authored.
- **Worker-result plumbing is the weak link of host-driven fan-out.** Completion notifications can
  fire before writes flush (5 phantom-claimed shards → one redundant re-dispatch wave, killed);
  harness task output files were 0 bytes, so results round-tripped through agent-resume write-backs;
  large reviewer artifacts returned as text needed host transcription. A per-fan-out
  return-JSON+write-back convention held after that.
- **Validator/prompt drift bites hosts, not just workers:** the polarity-label convention appears
  only in validator error text; `inapplicable_claim` specs are prescribed by the skeleton and
  refused by the validator (filler assertions required).
- **Autonomous decisions taken** (recorded): approved all 13 review-gate findings (all Concrete
  tier, zero Strategic) on the run directive; chose `resume` at the in-progress gate; answered the
  intent gate from the operator's standing directives; state surgery after the proven-false
  abandonment.

## Where the follow-up work lives

- Fixable tool defects → `docs/backlog/open-bugs.md` (friction-walk block + the HIGH gate-hygiene
  entry); the run's own ledger carries the contract-pipeline defects as remediation obligations.
- The remediation deliverables → `.audit-tools/remediation-report.md` / `remediation-outcomes.json`
  on true close; changes land on branch `remediation/remediate-audit-2026-07-30`.
