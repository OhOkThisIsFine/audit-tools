# HANDOFF — audit-tools

> Immediate state and next action only. Durable design lives in `CLAUDE.md` and `spec/`;
> open work lives in `docs/backlog/`.

## Live state

- The zero-adapter retirement is LANDED on `main` and published (v0.40.1); audit-tools emits
  complete provider-neutral host workloads and ingests bound results.
- 2026-08-12: all 19 nightly decisions were answered and recorded; the executable ones landed
  (P19–P22, the hooks probe carve-out, the docs-1..6 constitutional batch, the backlog batch).
  Four owner-approved BUILDS remain queued — see Immediate next.
- The dogfood audit lap is IN FLIGHT and deliberately PAUSED at the `dispatch_review` step:
  intake/scope/lenses confirmed (930 files; custom `host_contract_robustness` lens included),
  all 5 analyzers consented, critical-flow enrichment plus both design reviews (contract +
  conceptual) ingested — both reviews were produced by free offload lanes. The semantic review
  workload for run `20260812T192026635Z_audit_tasks_completed_001` is published and unstarted.

## Resume the audit (fresh conversation)

1. `node audit-code.mjs next-step` re-renders the current step; follow its prompt — it is the
   `dispatch_review` host workload (dispatch items to workers, write each bound result, then
   `next-step` again). Free-lane caveat: the freellmapi `pool` lane is unusable for long tasks
   in THIS repo until P23 lands (the repo Stop gates fire inside the child and replace its
   deliverable); use the agy lanes, with verification-shaped prompts.

<!-- BEGIN GENERATED LIVE STATUS — scripts/shared/generate-handoff-roadmap.mjs — DO NOT EDIT BY HAND -->
<!-- END GENERATED LIVE STATUS -->

## Verification state

- Green at landing: full `verify:release` (all checks + packaging smokes + full vitest + linked
  smokes), plus independent stale-surface sweeps (docs, host-integration surfaces, backlog) and an
  independent loop-core review whose one confirmed defect (stale `host_handoff` binding surviving an
  applied clarification answer) was fixed red-green in the landing commit.

## Immediate next

1. **Build P25 re-scoped FIRST** (sol-9; all three gating answers recorded 2026-08-12 in
   [`docs/reviews/p25-design-check-2026-08-12.md`](reviews/p25-design-check-2026-08-12.md) §6):
   re-pointed at the `incoming/` gates, submit verb recovery-only, ATOMIC migration — the owner
   chose atomic-and-re-run-the-lap, so this lands before the lap resumes and the paused dispatch
   re-runs on the new arrival scheme.
2. Resume the dogfood audit lap (see *Resume the audit* above), then the remediate phase.
3. The remaining owner-approved builds:
   - **P23** (sol-7): probe whether child sessions fire SessionStart, then session tagging +
     unregistered-session commit/push refusal. Unblocks the freellmapi `pool` lane for this repo.
   - **sol-8**: SessionStart tree-dirt baseline + per-gate pathspec scoping (supersedes P24's shape).
   - **backlog-2 gate + sol-3 leg-1 scope ledger.**
4. Memory-index consolidation (owner decision 2026-08-09, recorded in the MEMORY.md header; the
   size hook now fires on every index edit): merge the closed sagas properly — the citations gate
   and `[[name]]` cross-links make it a focused pass, not a side-task.

<!-- BEGIN GENERATED ROADMAP — scripts/shared/generate-handoff-roadmap.mjs — DO NOT EDIT BY HAND -->

> **This list is GENERATED from [`docs/backlog/`](backlog/) — do not hand-edit it.**
> It is the IMMEDIATE NEXT work only, never the full open set. Prefix an entry's bold title with
> `▶` in the backlog file that owns it and it appears here; empty means nothing is
> pinned, which is a statement rather than an omission.
> **Every open item lives in [`docs/backlog/`](backlog/)**, reachable by the seek index in
> [`backlog.md`](backlog.md) — this block is not a second index of it.
> Every line is a POINTER: the backlog entry's own title, verbatim, and a link to the file that
> holds its spec. Nothing here restates a spec, so this list and the backlog cannot drift.
> Regenerate: `node scripts/shared/generate-handoff-roadmap.mjs` (`--check` gates it in
> `verify:checks` and at commit). 0 pinned item(s).

### ▶ Next up — pinned in the backlog

*(nothing pinned — no immediate next step is set. Every open item is in [`docs/backlog/`](backlog/).)*

<!-- END GENERATED ROADMAP -->
