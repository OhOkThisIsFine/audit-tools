# HANDOFF — audit-tools

> Immediate state and next action only. Durable design lives in `CLAUDE.md` and `spec/`;
> open work lives in `docs/backlog/`.

## Current state

The first prompt-consistency and governance-simplification slice is implemented:

- Audit workers no longer author the tool-owned clean-result flag. Intent confirmation derives
  required fields and disposition choices from the schemas.
- The second-order adversary requires an independent context; an unavailable reviewer stops the
  step without a fabricated result or continuation.
- Release retries bind to the already-bumped version and commit. Missing or mismatched tags and
  incomplete publication creation stop explicitly; registry observation allows ten minutes.
- Gate enumeration is removed. The executable verification gate remains authoritative; the
  remaining checks retain their order.

## Immediate next

Continue Prompt Contract v1 primitives and P1 evidence/path corrections in
`docs/reviews/prompt-contract-standard-2026-09-19.md`, then the executable gate catalog and remaining
consolidations in `docs/reviews/audit-tools-governance-simplification-2026-09-19.md`.
The arbitrary-repository final-gate gap remains in `docs/backlog/open-bugs.md`; audit mutation
policy remains a separate owner decision before changing that default.

**Live owner decision for the completed slice:** none.

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
> `verify:checks` and at commit). 0 pinned item(s).

### ▶ Next up — pinned in the backlog

*(nothing pinned — no immediate next step is set. Every open item is in [`docs/backlog/`](backlog/).)*

<!-- END GENERATED ROADMAP -->
