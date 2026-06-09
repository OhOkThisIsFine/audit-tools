# Self-audit — 2026-06-09 (June 8–9 run)

A second `/audit-code` self-audit of this repository, **compiled on 2026-06-09
from an interrupted run** that was executed across several IDE sessions (June 8–9)
with usage-limit and error interruptions. Treat it as **raw, untriaged, and
advisory** — verify each finding against current source before acting.

## Deliverables

- **`audit-report.md`** — human-facing report: **281 findings**
  (24 high / 127 medium / 120 low / 10 info) across 5 work blocks.
- **`audit-findings.json`** — canonical machine contract for the same findings
  (feed to `/remediate-code`; it consumes the JSON, not the Markdown).

## How it was produced

The run stalled before synthesis, with most auditor results stranded un-ingested
in `.audit-tools/audit/runs/*/task-results/`. They were recovered by:
`merge-and-ingest` per run → quarantining 3 orphaned `deepening:steward:*`
results that aborted the batch → forcing `synthesize`. 337 results were ingested;
synthesis excluded 385 non-source files. (Both the orphaned-batch-abort and the
scope pollution that produced the junk files have since been fixed — see below.)

## Important caveats

- **Partial coverage.** The run was interrupted; not every planned packet ran.
  Absence of a finding here is *not* evidence of correctness.
- **Scope was polluted.** The run audited prior `.audit-artifacts/` outputs,
  `.tgz` tarballs, npm cache, and the `audit/` folder itself. Synthesis filtered
  most of it, but some low-value "this is JSON data" findings remain — and several
  findings are themselves *about* the pollution (`COR-281a9b14`, `MNT-68f7a179`,
  `COR-6464fa65`). The deterministic exclusions that prevent this shipped
  2026-06-09 (`packages/audit-code/src/extractors/disposition.ts`); a future
  re-run will be cleaner.
- **Untriaged.** Unlike the [2026-06-01 set](../README.md), these findings have
  not been hand-verified. Expect duplicates (the same issue fanned across files)
  and some false positives.

## Relationship to the 2026-06-01 self-audit

The [parent `audit/`](../README.md) (June-1) deliverable is the **curated,
triaged** baseline (392 findings, hand-annotated for what was fixed). This June-9
set is **newer but raw**. Many issues overlap. When they disagree, prefer current
source plus the reconciled plan in [`docs/backlog.md`](../../docs/backlog.md).

## What's next (continuation)

1. **Triage the 24 high-severity findings first** — they head `audit-report.md`
   (e.g. command injection `SEC-4747c5bf`, state-store lost-update race
   `COR-53c7a3ee`, TOCTOU lock race `REL-3c247ea1`, schema `$id` divergence in the
   `DAT-*` cluster). Verify each against current source; some may already be fixed
   or be false positives.
2. **Curate before remediating.** Do not feed all 281 findings to
   `/remediate-code` — many are advisory/low/duplicate. Filter to a high-value
   subset first.
3. **Open process work** is tracked in [`docs/backlog.md`](../../docs/backlog.md);
   the highest-signal items are the LLM scope/intent checkpoint, honoring
   `.gitignore` in file disposition, and making agent meta-audit feedback a
   canonical artifact.
