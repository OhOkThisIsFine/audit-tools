# What a low-tier run actually costs, and why the collapse cannot deepen much

Written to settle one number before the lean fold is implemented: how many gated host/LLM
round-trips a clean low-tier remediation run pays, with and without the lean bypass.

Tree anchor: HEAD `28912720` (2026-08-25).

Method: four independent readers, each with a different lens (gate ownership, determinism,
collapse safety, empirical), each refuted by a second lane. **All four returned 8. All four
refutations confirmed 8.** The empirical lens drove `buildNextContractPipelineStep` in a loop
against a git-backed temp repo with a low-tier signal and observed exactly 8 steps; its refuter
independently reproduced that run.

## The count

A clean low-tier run (tier stays `low`, single module, no cycles, no judge repair) pays **8**
gated turns before implementation:

| # | Phase | Why it costs a turn |
|---|---|---|
| 1 | collapsed framing | `collapsedFramingGate` folds goal_normalization + context_collection + decomposition into one |
| 2 | `module_contract_drafting` | `parallelModuleWaveGate` short-circuits to one ordinary step at a single module |
| 3 | `critique` | `phaseCutCritiqueGate` declines at a single-module cut; falls through to `ordinaryPhaseStep` |
| 4 | `test_validator_plan` | `scaffoldedPhaseGate` — a host step carrying a tool-derived scaffold |
| 5 | `assessment` | no gate claims it |
| 6 | `critic` | `preCriticStructuralGate` declines when clean |
| 7 | `judge` | no gate claims it |
| 8 | `implementation_planning` | `judgeRepairGate` declines on an approved verdict; `scaffoldedPhaseGate` claims it |

Six of the fifteen phases already cost **nothing**. `seam_reconciliation` (single module),
`contract_finalization` (always), `obligation_ledger` (always) and `cyclic_seam_resolution`
(no cycles) each return `{via: "rederive"}`, which re-enters the walk in-process at
`contractPipeline.ts:2111-2114`. `context_collection` and `decomposition` ride the framing
collapse. `closing` is filtered out of the frontier at `contractPipeline.ts:167-169`.

## Only one further collapse is safe

**`{test_validator_plan, assessment}` — 8 → 7.** Adjacent in phase order, both author-side,
neither carries `isIndependentCritic`, and the gate that reads the pair
(`paired_obligations` in `PRE_CRITIC_REQUIRED_GATES`) fires at the critic boundary *after* both,
so the check does not move. `contract_assessment_report` already depends on `test_validator_plan`
in `DEPENDENCY_MAP` — the same later-reads-earlier shape the framing group relies on.

Every other adjacency is blocked by a property worth more than the turn it would save:

- **decomposition → drafting.** `resolveAdversarialDepth` re-reads the freshly written
  decomposition on the next invocation so `escalateRiskSignal` can raise the tier *before* any
  contract is drafted. Folding drafting in freezes the dial. This is why the existing group stops
  where it does.
- **drafting → critique.** `critique` is an `isIndependentCritic` phase. One turn would have the
  author critique its own contracts.
- **assessment → critic.** `counterexample` depends on `contract_assessment_report`; one turn
  would author the coverage claim and attack it simultaneously.
- **critic → judge.** The sharpest one. Today the counterexample artifact must be written,
  ingested and content-hashed before the judge prompt exists. Merged, a single worker can emit
  zero counterexamples plus verdict `approved` and reach implementation planning in one hop —
  and since that verdict is the **sole** admission to implementation planning
  (`judgeRepairGate`), the loop would be certifying its own exit. `MAX_CONTRACT_REPAIR_ITERATIONS`
  and the repair ledger become unreachable. Note the low tier has *already* relaxed the
  independent-sub-agent mandate to a light inline self-check; the separate round-trip is what
  still forces a fresh read of the counterexample. Collapsing removes the last separation, not a
  redundant one.
- **judge → implementation_planning.** `judgeRepairGate` exists precisely to make planning
  reachable only through an approved verdict. A merged turn authors the DAG against a design the
  same turn is still adjudicating, and the DAG scaffold is built from
  `acceptedCounterexampleIds(judge)`, which does not exist at judge-render time.

## The consequence for the fold

Deepening the collapse buys **one** turn. A folded low-tier run costs **7** gated turns against
the bypass's **1**.

One further fact changes the shape of the decision: **the 8-turn walk is what a Path-B
(conversation / document) low-tier run already pays today.** The bypass only ever applied to
Path A (structured audit input), where a clean low-tier run takes one `lean_light_review` turn
and goes straight to `dispatch_implement`. So the fold's cost falls entirely on Path A.

## Correction to the record

An earlier estimate in this session put a deepened collapse at "8 → about 4". That was wrong,
and it was quoted to the owner as an estimate before this map existed. The verified ceiling is
8 → 7. The earlier figure of "about 12" for the un-collapsed walk was also wrong; an independent
lane corrected it to 8 and this map confirms 8.
