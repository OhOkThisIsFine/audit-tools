# HANDOFF — audit-tools

> Immediate state and next action only. Durable design lives in `CLAUDE.md` and `spec/`;
> open work lives in `docs/backlog/`.

## Live state

- P25 (sol-9) is LANDED: every host submission rides a tool-computed sha256-bound path under
  `<artifactsDir>/submissions/` (the flat `incoming/` scheme is deleted), with an
  expected-submission-set record, per-member shortfall classification rendered by name into
  re-emitted steps, an append-only drift/repair ledger surfaced in the report's process section,
  one shared `submission_*` classifier vocabulary across both draws, and a recovery-only
  `recover-submission` verb on both bins. Built red-tests-first (7 contract tests), six-lens
  adversarially reviewed plus an independent free-lane pass; every confirmed finding fixed and
  independently re-verified.
- Published state: v0.41.1 at HEAD `c2c0424d`. The zero-adapter retirement is live; audit-tools
  emits complete provider-neutral host workloads and ingests bound results.
- 2026-08-12: the day's decision queue was answered in full; the executable items landed
  (P19–P22, the hooks probe carve-out, the docs-1..6 constitutional batch, the backlog batch,
  then P25). Three owner-approved BUILDS remain queued — see Immediate next.
- The dogfood audit lap is IN FLIGHT and deliberately PAUSED at the `dispatch_review` step:
  intake/scope/lenses confirmed (930 files; custom `host_contract_robustness` lens included),
  all 5 analyzers consented, critical-flow enrichment plus both design reviews (contract +
  conceptual) ingested. Per the owner's atomic-migration call the paused dispatch re-runs on the
  new arrival scheme: `next-step` re-emits it; deterministic artifacts survive, only
  dispatched-but-uningested work repeats.

## Resume the audit (fresh conversation)

1. `node audit-code.mjs next-step` re-renders the current step; follow its prompt — it is the
   `dispatch_review` host workload (dispatch items to workers, write each bound result, then
   `next-step` again). Free-lane caveat: the freellmapi `pool` lane is unusable for long tasks
   in THIS repo until P23 lands (the repo Stop gates fire inside the child and replace its
   deliverable); use the agy lanes, with verification-shaped prompts.

<!-- BEGIN GENERATED LIVE STATUS — scripts/shared/generate-handoff-roadmap.mjs — DO NOT EDIT BY HAND -->
<!-- END GENERATED LIVE STATUS -->

## Verification state

- P25 green at landing: build + typecheck (src and test tree) + full vitest (406 files / 5077
  passed) + loop-core-patterns byte-match + knip; six-lens adversarial review (every finding
  refuter-verified) plus an independent free-lane defect hunt; the review's three majors and all
  corroborated minors fixed and re-verified by a dedicated fix-delta lane. Loop-core and
  constitutional-doc attestations recorded against the final staged tree.

## Immediate next

1. Resume the dogfood audit lap (see *Resume the audit* above), then the remediate phase.
2. The remaining owner-approved builds:
   - **P23** (sol-7): probe whether child sessions fire SessionStart, then session tagging +
     unregistered-session commit/push refusal. Unblocks the freellmapi `pool` lane for this repo.
   - **sol-8**: SessionStart tree-dirt baseline + per-gate pathspec scoping (supersedes P24's shape).
   - **backlog-2 gate + sol-3 leg-1 scope ledger.**
3. Memory-index consolidation (owner decision 2026-08-09, recorded in the MEMORY.md header; there
   is no size gate — measure with `wc -c` after an index edit): merge the closed sagas properly — the citations gate
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
