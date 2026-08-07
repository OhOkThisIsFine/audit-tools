# Re-land review — the unlanded 2026-07-30 remediation stack

**Date:** 2026-08-07 · **Decision:** owner chose *full selective re-land review* (this session)
over keep-parked/discard. **Method:** 8 commits × (assess + adversarial verify) — 16 independent
subagents on `openrouter/deepseek/deepseek-v4-flash-0731`, each hunk mapped onto current main
(HEAD `1d203e89`, v0.38.1) with file:line evidence, verdicts re-derived by the adversary from
source. Driver: this session's conversation agent, which gates every landing commit.

**Headline:** every one of the 8 commits still carries applicable content — the 2026-08-06
remediation run (`3a17ca8c`) did NOT independently fix any of the defects this stack addresses.
Adversary disagreements were completeness corrections (a hunk missing from a list, a wrong test
count, coexisting backlog entries), not verdict overturns.

## Verdicts and landing decisions

Landing order below (dependency-driven); original stack order was oldest→newest
bc6f8ae6 → d2d164c0 → 380476eb → 8703ee55 → 7ea5c799 → 0b606957 → f8954913 → 2d2fb0b4.

| # | Commit | Content | Verdict | Landing decision |
|---|--------|---------|---------|------------------|
| 1 | `bc6f8ae6` CP-NODE-5 | Dedupe-core test coverage + precondition docs | reland_adapted | Land; add the `idDiscipline` policy field (7-field `CrossLensDedupePolicy` since `2ce641f7`). |
| 2 | `d2d164c0` CP-NODE-4 | `ProviderConstructionError` / `ProviderLaunchOutcomeEnvelope`; `projectTestAdmission` discovery-anchored gate; `allowlistedExec` spawn gate | reland_adapted | Land; rebase paths onto the `src/shared/analyzers/` relocation. Envelope is substrate for the pinned re-detection item. |
| 3 | `380476eb` backlog fold | Doc reorganization + meta-review record | partially_needed | **Selective:** add `docs/reviews/meta-review-remediation-run-2026-07-30.md` and the missing HIGH gate-hygiene entry; SKIP the open-bugs condensation reshuffle (main's backlog evolved past it; the detailed entries it condensed still exist on main and remain open). |
| 4 | `8703ee55` CP-NODE-3 | Explicit `clear_persisted_state` directive; `classifyProviderConstructionAttempt` (construction failures are terminal, not retryable) | reland_adapted | Land after #2 (needs its envelope types). Directive consumer arrives in #8, same shape as the original stack. |
| 5 | `0b606957` CP-NODE-2-f02 | `OwnershipRegistry._persist` stops swallowing write errors; zod validation on `intake-summary.json` | reland_as_is | Land (cleanest of the set; paths and idioms still match). |
| 6 | `7ea5c799` n-r22 test-infra | Guard-neutralization infra + `_persist` regression tests | partially_needed | Land AFTER #5 — **order swap vs the original stack, deliberate:** the `_persist` tests assert post-fix semantics (write failures surface), so they are the regression suite FOR #5, not obsolete. Assessor's "drop them" assumed #5 stayed unlanded. |
| 7 | `f8954913` CP-NODE-2-f01 | Two close-phase catch blocks log `kind:"outcome"` for run-level diagnostics → `kind:"error"` | reland_adapted | Land; merge the second hunk's comment with main's OBS-89a57cbd observation comment. |
| 8 | `2d2fb0b4` CP-NODE-6 | `UNMEASURED_LINE_COUNT` sentinel (read-failure ≠ empty file); `pausePersist` atomicity via the shared locked JSON store; `partial_completion_terminal` carry-forward + pause-clear on full-success pass | partially_needed (all 8 behavioral hunks still_applicable) | Land last; consumes #4's directive. Adapt `pausePersist` onto the locked-store infrastructure already exported from shared. |

Provider-envelope substrate (feeds pinned item ARC-e01faa3e): `d2d164c0` defines the envelope;
`8703ee55` consumes it in `classifyProviderConstructionAttempt`. Both flagged by the review and
verified.

## Ground rules for the landing pass

- Sequential, one commit at a time in the real tree; green (`npm run build && npm run check` +
  touched suites) at every commit; loop-core commits carry a fresh review attestation.
- Regression tests red-green validated by inverting the fix where the commit pairs test+fix.
- Subagent adaptations are drafts — the driver re-reads every diff against this table before
  committing.

Full per-hunk verdicts with evidence: workflow run `wf_e03627af-6cd` (session artifact,
16/16 agents, 0 errors). The branch `remediation/remediate-audit-2026-07-30` remains the
preservation ref until all eight land, then it is deleted and the open-bugs owner-decision
entry closes.

**EXECUTED, same day:** all eight landed on main (`b27f27d9`…`24d12f62`, order and
adaptations as tabled; full suite 7,640/0 after the final commit), the preservation branch
was deleted, and the open-bugs entry closed. One landing surprise worth its line: the
CP-NODE-6 drive tests strand-on-`context_cap` under a bare `sessionConfig` on current main
(no resolved context window) — fixed by using the suite's `TEST_SESSION_CONFIG`, diagnosed
from `dispatch-explains.jsonl`, after a subagent's quota-cooldown theory was refuted by a
loud-failing expiry helper (the persisted quota ledger is never written on that path).
