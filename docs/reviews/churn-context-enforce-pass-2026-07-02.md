# Codebase-wide review — churn / context / enforce-in-tooling (T5 forward-tracks)

> Re-run of the append-only-ledger + granular-staleness + enforce-in-tooling lens over the
> **post-merge** tree (nodes 1-4 of `t5-forward-tracks-2026-07-02` merged). Discovery-only:
> **no source edits from this pass** — sole writes are this record + backlog follow-on lines.
> Grounded against [`churn-context-enforce-pass-2026-06-27.md`](churn-context-enforce-pass-2026-06-27.md)
> and the backlog "Codebase-wide churn / context / enforce-in-tooling pass — remainder" entry.
> Already-closed items (C3/C5/C6/E4/E5, X-cluster state-projection) are NOT re-surfaced.

Date: 2026-07-02 · against post-merge worktree HEAD (`remediate-CP-BLOCK-CP-NODE-5-t5-forward-tracks-2026-07-02`).

## Verification tiers

- **VERIFIED** — claim confirmed against the current on-disk source (file + symbol/line anchor below).
- **PLAUSIBLE** — shape is real but value/consumer-graph not fully pinned; lead for a follow-on lap.
- **LOW-VALUE** — real but cheap/cumulative-only; not worth a dedicated lap.

## Findings

| # | Category | Finding | Tier | Anchor |
|---|----------|---------|------|--------|
| N1 | churn | `analyzerSignalAnchorsForPath` re-flattens + filters the **entire** `externalAnalyzerResults` set on every call. It is called once per file path (`renderTaskAnalyzerSignals`), which `buildTaskSections` runs for **every task in the packet** → O(tasks × files × total-analyzer-results) per dispatch. CP-NODE-2 widened the caller from isolated-large-file-only to every task section, so the quadratic now runs on the common path. Fix: build a per-dispatch `Map<normalizedPath, FileAnchor[]>` once in `buildTaskSections` (or its caller) and have `renderTaskAnalyzerSignals` read the index instead of re-scanning. | **VERIFIED** | `src/audit/orchestrator/fileAnchors.ts:150-169` (flatMap+filter over full set); consumed per-path at `src/audit/cli/dispatch/packetPrompt.ts:176-178`, per-task at `packetPrompt.ts:207,220-224` |
| N4 | context | `renderTaskAnalyzerSignals` emits **all** analyzer-signal lines for a task uncapped and full-detail (`signals.map(...)`, `packetPrompt.ts:184-193`), unlike the sibling anchor preview which caps at `.slice(0, 24)` (`packetPrompt.ts:28`). A task over a hot file with many analyzer hits ships an unbounded lead block into the prompt. Fix: apply a per-task cap (mirror the 24-anchor preview) + an omitted-count footer (`… N more analyzer signals; see packet.json`). | **VERIFIED** | uncapped map: `src/audit/cli/dispatch/packetPrompt.ts:182-194`; sibling cap for contrast: `packetPrompt.ts:28` |

Note: N4 was PLAUSIBLE in the 2026-06-27 record; on the post-merge tree the uncapped map and the sibling `.slice(0, 24)` cap are both concretely on disk with no cap between them, so it is upgraded to **VERIFIED**.

## Not re-surfaced (already dispositioned)

Per the backlog remainder entry, the following remain low-value / need-design-intent and are intentionally NOT
re-raised: C3 (design-assessment detector re-run), C5 (`buildPathLookup`/`buildDispositionMap` rebuild), C6
(`computeStaleArtifacts` full DAG walk), E4 (obligation-DAG cycle warning-severity), E5 (`collapseItemResults`
alias tolerance), and the entire X-cluster state-projection trim (falsified — workers consume the full Finding
verbatim). C2 (incremental graph-build extraction) and X1 (prompt-render trim) shipped in the 2026-06-27 lap.

## Outcome

Two genuinely-actionable items (N1, N4), both VERIFIED, both localized to packet-prompt rendering — appended as
separately-scoped follow-ons to `docs/backlog.md`. No source edits applied (discovery-only node). No other new
actionable churn / context / enforce-in-tooling items found on the post-merge tree.
