# HANDOFF — audit-tools

> Immediate state and next action only. Durable design lives in `CLAUDE.md` and `spec/`;
> open work lives in `docs/backlog/`.

## Live state

- The zero-adapter retirement is LANDED on `main` and published: audit-tools emits complete
  provider-neutral host workloads and ingests bound results; provider adapters, routing, quota
  accounting, backend sizing, and internal worker execution are retired.
- Old audit/remediation run artifacts are cleared; the artifact dir holds only the tracked
  deliverable pairs and the open decision queue. The tree is ready for a fresh dogfood run.

<!-- BEGIN GENERATED LIVE STATUS — scripts/shared/generate-handoff-roadmap.mjs — DO NOT EDIT BY HAND -->
<!-- END GENERATED LIVE STATUS -->

## Verification state

- Green at landing: full `verify:release` (all checks + packaging smokes + full vitest + linked
  smokes), plus independent stale-surface sweeps (docs, host-integration surfaces, backlog) and an
  independent loop-core review whose one confirmed defect (stale `host_handoff` binding surviving an
  applied clarification answer) was fixed red-green in the landing commit.

## Immediate next

1. Run the next dogfood lap (audit → remediate) on the zero-adapter architecture — old run
   artifacts are already cleared.

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
