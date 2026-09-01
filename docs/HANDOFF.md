# HANDOFF — audit-tools

> Immediate state and next action only. Durable design lives in `CLAUDE.md` and `spec/`;
> open work lives in `docs/backlog/`.

## Live state

- **v0.50.20 is live**, published from `6e9259c4`; the release workflow passed and the
  registry artifact is installed globally. Both `audit-code --version` and
  `remediate-code --version` report `0.50.20`.
- **The P0 deep-review rewiring is implemented.** Broad/comprehensive audit intent now
  offers deep review without selecting it autonomously; synthesis preserves detailed
  contributor attribution and reports structural capability limitations. The pinned
  5+5 benchmark harness, evaluator packets, and scoring/adjudication contracts are in
  [`benchmarks/p0/`](../benchmarks/p0/) and the design gate is recorded in
  [`p0-deep-review-design-gate-2026-08-31.md`](reviews/p0-deep-review-design-gate-2026-08-31.md).
- **Acceptance is not yet claimed.** The harness and seeded controls are green, but the
  provider-backed paired run and blinded evaluation require external execution.

## Immediate next

Run the external 5-primary + 5-held-out paired benchmark and blinded evaluation described
in [`forward-tracks.md`](backlog/forward-tracks.md). Use the checked-in pinned runner and
evaluator protocol; do not substitute an inferred or self-scored acceptance result.

## Deliberate state, not bugs

- Deep review remains a user-selected option. Detection presents the choice; it does not
  autonomously choose the closing action.
- Final benchmark acceptance remains open until the external run is complete. This is the
  one explicit forward track, not an incomplete local implementation.

<!-- BEGIN GENERATED LIVE STATUS — scripts/shared/generate-handoff-roadmap.mjs — DO NOT EDIT BY HAND -->
<!-- END GENERATED LIVE STATUS -->

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
> `verify:checks` and at commit). 1 pinned item(s).

### ▶ Next up — pinned in the backlog

- ▶ Audit-tools deep-review acceptance benchmark still needs its external run. · [`forward-tracks.md`](backlog/forward-tracks.md)

<!-- END GENERATED ROADMAP -->
