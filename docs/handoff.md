# Handoff — next tasks

Living pointer for the next session. Durable detail lives in
[`backlog.md`](backlog.md); this is the thin "where we are + do these next" layer.
Cross-session state is also in the `audit-tools-2026-06-state` auto-memory.

_Last updated: 2026-06-09 (clarification-consume fix shipped as remediate 0.11.2)._

## Current state

- **`main` is pushed and clean at `fdacb96`; everything below is released and
  globally installed.** The evening commits (`41cccb2` meta-audit reflections /
  `4b2025c` FINDING-012 / `82c678f` synthesis stderr cleanup) shipped as the
  patch bump **shared 0.11.1 / audit-code 0.12.1 / remediate 0.11.1**, and the
  clarification-consume fix (`a3bafbf` + `ae25776`) shipped as **remediate
  0.11.2**. Both global bins are current (auditor-lambda 0.12.1, remediator-lambda
  0.11.2).
- **Published (morning):** `@audit-tools/shared@0.11.0` / `auditor-lambda@0.12.0` /
  `remediator-lambda@0.11.0` — the cross-orchestrator scope/intent checkpoint.
- **Repo hygiene (done 2026-06-09 evening):** all stale branches, the two leaked
  `remediate-B-*` test worktrees/branches, and the lone stash (a redundant
  `REFACTOR-HANDOFF.md` deletion — already deleted on main 2026-06-02) were
  removed. Only `main` remains, in sync with the `audit-tools` remote
  (`OhOkThisIsFine/audit-tools`; no `origin`).
- **Suites at `82c678f`:** shared 273 pass / audit-code 1610 pass + 1 pre-existing
  skip / remediate-code 725 pass (all with `CLAUDECODE` unset).
- **Self-audit (June 8–9):** 281 findings; the 24 highs were triaged (5 curated →
  4 fixed, `CFG-4996560e` deferred; 3 false-positives; rest low-value). The audit
  deliverables under `audit/` were deleted as stale; `CFG-4996560e`'s fix direction
  is in `backlog.md`.

## Next tasks, in priority order

1. **`CFG-4996560e`** (deferred fix) — scope postinstall's deployed OpenCode perms
   to the `auditor` agent vs the global top level. Needs real-OpenCode validation
   (agent/subtask inheritance is not unit-testable). Fix direction in `backlog.md`.

## What shipped this session (2026-06-09 evening, on `main`, publish-pending)

> **Meta-audit reflections completed** (`41cccb2`). The parse/aggregate/render
> module moved to `@audit-tools/shared` (`agentReflections.ts`,
> `AGENT_FEEDBACK_FILENAME`). audit-code disk-loads `agent-feedback.jsonl` into
> `bundle.agent_reflections` (read-only pseudo-artifact — never written/pruned
> by the orchestrator) with an `agent-feedback.jsonl → audit-report.md`
> staleness edge, always-rehashed each advance like `tooling_manifest.json` so
> a mid-run append re-synthesizes exactly once (convergence covered by
> `tests/agent-feedback-reflections.test.mjs`). remediate-code parity:
> document/implement dispatch prompts carry the opt-in invitation and the close
> phase aggregates reflections into a "Process Feedback" section of
> `remediation-report.md`.

> **FINDING-012 verified closed** (`4b2025c`). The "route remediate's structured
> fast path through `confirm_intent`" task was stale: the gate sits at the top
> of `decideNextStepInner`, before source-type branching, so a lone
> `audit-findings.json` already flows `synthesize_intake` → `confirm_intent` →
> filtered `runPlanPhase` (verified end-to-end). Added the no-checkpoint
> regression test to `tests/next-step.test.ts` — it is the ONLY test of that
> flow; the other structured-path tests pre-write a checkpoint.

> **Synthesis stderr debug diagnostics removed** (`82c678f`). The two
> `console.error` JSON lines (`synthesis_complete`, `audit_findings_report_built`)
> and their two lock-in tests were debug leftovers from `e84d9cb` with no
> consumers; authored by a parallel Claude session, verified and committed here.

> **Dead in-process document path deleted + clarification consume fixed.** Removed
> the CLI-unreachable `runDocumentPhase` (`phases/document.ts` + its test); the
> live path is `prepareDocumentDispatch`. That dead path was also the only code
> that consumed `clarification_resolution.json`, so the live
> `waiting_for_clarification` branch looped forever. Added the symmetric consume
> (`applyClarificationResolution` in `dispatch.ts`) mirroring `waiting_for_triage`:
> `deemed_inappropriate` findings go terminal; `clarified` findings re-open for
> re-documentation with the user's rationale threaded into the next dispatch
> prompt via the new `RemediationItemState.clarification_context`. Regression test
> in `tests/next-step.test.ts` ("clarification_resolution.json is applied…").

## Gotchas (also in auto-memory)

- **Parallel sessions:** Ethan sometimes runs concurrent Claude sessions in this
  same checkout. On unexplained working-tree changes mid-session: don't commit or
  revert them blind — partial-stage your own work around them and ask.
- **Release/publish:** run with `CLAUDECODE` unset (a provider test fails under it).
  The CI-wait loop logs every 5s — tail the task output, don't whole-read it.
  Local Windows-green ≠ Linux-CI-green; release CI is the real signal.
- **Global install:** npm's allow-scripts policy defers `postinstall` (host-integration
  deploy is skipped); finish with `npm approve-scripts auditor-lambda` or run
  `postinstall.mjs` manually.
- **Tests on Windows:** run suites solo — concurrent heavy runs hit transient EPERM
  flakiness in file-lock/rename ops, inflating failures.
