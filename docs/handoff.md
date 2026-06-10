# Handoff — next tasks

Living pointer for the next session. Durable detail lives in
[`backlog.md`](backlog.md); this is the thin "where we are + do these next" layer.
Cross-session state is also in the `audit-tools-2026-06-state` auto-memory.

_Last updated: 2026-06-09 (end of evening session)._

## Current state

- **`main` is pushed and clean at `82c678f`.** Three commits landed after the
  morning releases and are **publish-pending — Ethan is running the publish
  workflow himself**. Before assuming versions, check `npm view` / git tags:
  if no `*-v*` tags exist after `82c678f`, the publish hasn't happened yet.
  - `41cccb2` — meta-audit reflections completed (touches **all three packages**;
    shared changed, so shared must publish before the dependents).
  - `4b2025c` — FINDING-012 regression test + docs (remediate-code only).
  - `82c678f` — synthesis stderr debug-diagnostics removal (audit-code only).
- **Published (morning):** `@audit-tools/shared@0.11.0` / `auditor-lambda@0.12.0` /
  `remediator-lambda@0.11.0` — the cross-orchestrator scope/intent checkpoint.
- **Repo hygiene (done 2026-06-09 evening):** all stale branches, the two leaked
  `remediate-B-*` test worktrees/branches, and the lone stash (a redundant
  `REFACTOR-HANDOFF.md` deletion — already deleted on main 2026-06-02) were
  removed. Only `main` remains, in sync with the `audit-tools` remote
  (`OhOkThisIsFine/audit-tools`; no `origin`).
- **Suites at `82c678f`:** shared 273 pass / audit-code 1610 pass + 1 pre-existing
  skip / remediate-code 725 pass (all with `CLAUDECODE` unset).
- **Self-audit findings:** [`audit/2026-06-09/`](../audit/2026-06-09/) — 281 findings;
  the 24 highs are triaged in
  [`curated-remediation-set.README.md`](../audit/2026-06-09/curated-remediation-set.README.md)
  (5 curated → 4 fixed, `CFG-4996560e` deferred; 3 false-positives; rest backlog).

## Next tasks, in priority order

1. **Confirm the publish landed** (Ethan runs it) — then global-install freshness:
   the global bins still run the last published versions until then (see the
   allow-scripts gotcha below).

2. **`CFG-4996560e`** (deferred fix) — scope postinstall's deployed OpenCode perms
   to the `auditor` agent vs the global top level. Needs real-OpenCode validation
   (agent/subtask inheritance is not unit-testable). Fix direction in `backlog.md`.

3. **Remaining curated highs / triage** — the deferred (backlog) and
   scope-pollution highs are catalogued in `curated-remediation-set.README.md`;
   most are low-value.

4. **Small cleanup (backlogged, also offered as a task chip):** delete the
   CLI-unreachable in-process document path in remediate-code
   (`phases/document.ts` `runDocumentPhase`/`buildDocumentPrompt` — only its own
   test references it; the live path is `steps/dispatch.ts`). See `backlog.md`.

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
