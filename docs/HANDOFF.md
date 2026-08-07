# HANDOFF — audit-tools

> Immediate state and next action only. Durable design lives in `CLAUDE.md` and `spec/`;
> open work lives in `docs/backlog/`.

## Live state

- **Analyzer item C SHIPPED (2026-08-06 lap, on top of v0.37.0)** — the mechanical-analyzer
  program (A/B/C/D) is COMPLETE. Three commits: atomic substrate relocation to
  `src/shared/analyzers/` (candidate registry moved too — recorded deviation), content-anchored
  `AnalyzerLeadProvenance` join (packet lead → finding → remediation via the finding id-join),
  and the close-gate `verifyAnalyzerLeads` leg (per-item `mechanical_verification` in the
  outcomes contract; a persisting lead re-blocks only ITS item → triage). `/design-check` ran
  first: no retirement collisions; both deviations recorded in the condensed
  [`spec/mechanical-analyzer-layer-design.md`](../spec/mechanical-analyzer-layer-design.md);
  red-green validated at both the unit and integration seams.
- **Branch/worktree cleanout DONE (owner-authorized)** — 243 local branches → 2, remote →
  `main` only, 179 orphan worktree dirs discarded; method + per-branch verdicts in
  [`reviews/branch-cleanout-2026-08-06.md`](reviews/branch-cleanout-2026-08-06.md). The
  2026-07-30 remediation stack was found NEVER LANDED and is preserved on
  `remediation/remediate-audit-2026-07-30` — owner decision filed in `open-bugs.md` (re-land
  selectively vs discard; its provider-envelope content feeds the pinned re-detection item).
- **Provider mid-run re-detection: mechanism claims VERIFIED against source** — Option B holds
  on the pause substrate (`waiting_for_provider` exists; `buildConfirmedPools` re-resolves),
  with 4 named gaps the implementation must add (no provider-death outcome in
  `classifyFailureChannels`; the pause artifact lacks provider identity; no per-pool
  spawn-failure counter; the pool-id→provider join is undefined). Annotated draft in
  [`reviews/backlog-sprint-2026-08-06.md`](reviews/backlog-sprint-2026-08-06.md).
- v0.37.0 sprint record (analyzer A/B/D, friction + gate clusters, weak-model dispatch
  caveats): [`reviews/backlog-sprint-2026-08-06.md`](reviews/backlog-sprint-2026-08-06.md).

## Verification state

- **Shipped as v0.38.1 — release CI fully green** (gate + 4 test shards + publish; npm live;
  global bins reinstalled with postinstall). The v0.38.0 tag was burned and withdrawn: shard 3
  caught a hand-edited GENERATED schema (`worker-schema-generation.test.ts`); fixed by carrying
  `analyzer_provenance` through `scripts/audit/generate-schemas.mjs` from the zod source
  (`49eb1fee`). Local at ship: audit area 2,818/0, remediate+shared 4,746/0, all gates 0. Known
  noise: the tracked RPC-timeout "1 error" line still prints (open false-RED/false-GREEN entry
  in `open-bugs.md`).

## Immediate next

1. **Provider mid-run re-detection** (open-bugs, HIGH, pinned) — design verified with 4 named
   implementation gaps (see Live state); implement Option B per the annotated draft in
   [`reviews/backlog-sprint-2026-08-06.md`](reviews/backlog-sprint-2026-08-06.md). The unlanded
   2026-07-30 `ProviderConstructionError` envelope is candidate substrate.
2. **Unlanded 2026-07-30 stack** (open-bugs, owner decision) — re-land selectively or discard;
   the branch is the preservation ref.

   ⚠ Standing hazard: `session-config.json` at repo root (untracked,
   `block_quota: {context_tokens: 200000, reserved_output_tokens: 32000, host_model: claude-opus-5}`)
   is load-bearing — recreate if absent.

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
> `verify:checks` and at commit). 2 pinned item(s).

### ▶ Next up — pinned in the backlog

- ▶ Dogfood/meta-review 2026-07-30 cluster — remaining live-run-watch properties. · [`open-bugs.md`](backlog/open-bugs.md)
- ▶ Provider auto-selection is construction-time-only — a mid-run provider death has no re-detection or fallback (2026-08-06 self-audit ARC-e01faa3e, verified, high). · [`open-bugs.md`](backlog/open-bugs.md)

<!-- END GENERATED ROADMAP -->
