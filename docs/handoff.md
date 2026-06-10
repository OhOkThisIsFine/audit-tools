# Handoff — next tasks

Living pointer for the next session. Durable detail lives in
[`backlog.md`](backlog.md); this is the thin "where we are + do these next" layer.
Cross-session state is also in the `audit-tools-2026-06-state` auto-memory.

_Last updated: 2026-06-09 (evening)._

## Current state

- **Published:** `@audit-tools/shared@0.11.0` / `auditor-lambda@0.12.0` /
  `remediator-lambda@0.11.0` are live (released 2026-06-09) — the cross-orchestrator
  scope/intent checkpoint (Stages 0/A1/A2/R1/R2, both suites green). Check
  `npm view` / git tags for the latest.
- **Unreleased on `main`:** meta-audit reflections completion (see below) — not
  yet published; fold into the next release.
- **Branches:** work lands on `main` (default). Remote is `audit-tools`
  (`OhOkThisIsFine/audit-tools`); no `origin`.
- **Self-audit findings:** [`audit/2026-06-09/`](../audit/2026-06-09/) — 281 findings;
  the 24 highs are triaged in
  [`curated-remediation-set.README.md`](../audit/2026-06-09/curated-remediation-set.README.md)
  (5 curated → 4 fixed, `CFG-4996560e` deferred; 3 false-positives; rest backlog).

## Next tasks, in priority order

1. **`CFG-4996560e`** (deferred fix) — scope postinstall's deployed OpenCode perms
   to the `auditor` agent vs the global top level. Needs real-OpenCode validation
   (agent/subtask inheritance is not unit-testable). Fix direction in `backlog.md`.

2. **Remaining curated highs / triage** — the deferred (backlog) and
   scope-pollution highs are catalogued in `curated-remediation-set.README.md`;
   most are low-value.

> **Verified 2026-06-09 — structured fast path is already gated (FINDING-012
> closed).** The "route remediate's structured fast path through `confirm_intent`"
> task turned out to be stale: the gate shipped with the checkpoint feature sits
> at the top of `decideNextStepInner`, before source-type branching, so a lone
> `audit-findings.json` already flows `synthesize_intake` → `confirm_intent` →
> filtered `runPlanPhase` (verified end-to-end; severity filter pruned the
> fixture findings with `dropped_by_checkpoint` ledger entries). Added the
> missing no-checkpoint regression test to `tests/next-step.test.ts` and marked
> the backlog item resolved.

> **Shipped 2026-06-09 (unreleased) — meta-audit reflections completed.** The
> parse/aggregate/render module moved to `@audit-tools/shared`
> (`agentReflections.ts`, `AGENT_FEEDBACK_FILENAME`). audit-code now disk-loads
> `agent-feedback.jsonl` into `bundle.agent_reflections` (read-only pseudo-artifact
> — never written/pruned by the orchestrator) with an `agent-feedback.jsonl →
> audit-report.md` staleness edge, always-rehashed each advance like
> `tooling_manifest.json` so a mid-run append re-synthesizes exactly once
> (convergence covered by `tests/agent-feedback-reflections.test.mjs`).
> remediate-code gained parity: document/implement dispatch prompts carry the
> opt-in invitation and the close phase aggregates reflections into a "Process
> Feedback" section of `remediation-report.md`. All three suites green.

> **Shipped 2026-06-09 — cross-orchestrator scope/intent checkpoint.** Enriched
> shared `IntentCheckpoint` + schema; audit-code `confirm_intent` host step
> (reachable, `host_delegation`, deterministic pre-digest, headless auto-complete)
> that prunes planning by `excluded_scope`, threads `free_form_intent` into worker
> prompts, and reports excluded scope; remediate-code enriched confirm prompt +
> `runPlanPhase` filtering (filters/excluded/must_not_touch) with a coverage-ledger
> `dropped_by_checkpoint` disposition and a "Skipped by Intent Checkpoint" report
> section. Both suites green.

## Gotchas (also in auto-memory)

- **Release/publish:** run with `CLAUDECODE` unset (a provider test fails under it).
  The CI-wait loop logs every 5s — tail the task output, don't whole-read it.
- **Global install:** npm's allow-scripts policy defers `postinstall` (host-integration
  deploy is skipped); finish with `npm approve-scripts auditor-lambda` or run
  `postinstall.mjs` manually.
- **Tests on Windows:** run suites solo — concurrent heavy runs hit transient EPERM
  flakiness in file-lock/rename ops, inflating failures.
