# HANDOFF — audit-tools

> Immediate state and next action only. Durable design lives in `CLAUDE.md` and `spec/`;
> open work lives in `docs/backlog/`.

## Live state

- **PH-01 is DECIDED: rejected (owner, 2026-08-27).** *One core, two draws* stands — auditing and
  remediating remain ONE logical core and a difference between them is a policy axis of that core.
  Its central premise was false: mutation is not remediate-exclusive (`auto_fixes_applied` is third
  in audit's own `PRIORITY`). PH-01's objection to the one-core lap falls with it; the structural
  audit's separate *measurement* survives. Do not re-propose without new evidence.
- **The one-core dissolution lap is RE-BASELINED, and two of its defects are fixed** (`4986b201`).
  Both original premises were false when routed: remediate has driven the shared engine since
  2026-06-17, and `hostHandoffCore.ts` already owns three of the four named duplications. Fixed
  here: `PRE_INTAKE_PRIORITY` lost a dangling id the engine had been skipping in silence for two
  months, and both remediate `advance` sites now handle `outcome.stopped` through the new shared
  `describeStoppedFold` rather than reporting a wedged fold as a finished run. Two residues remain,
  both stated in the backlog entry.
- **Seven of ten recent `docs/reviews/` records reach no work queue.** Four are simplification
  analyses carrying identified work — the philosophy audit (PH/DC), the workflow-gap analysis
  (8 gaps and a P0/P1/P2 sequence), the shared-helper adoption sweep (F1–F8), and the
  closeout-generation failure record. Over 1,500 lines. No gate reconciles `docs/reviews/` against
  `docs/backlog/`, so every gate stays green while it happens. Full accounting:
  `docs/reviews/state-of-play-2026-08-27.md`.
- **Repository:** `main` and `origin/main` are synchronized at `4986b201`; every commit passed its
  gates. No release is pending — `v0.50.1` is live on npm and matches the local version.

## Immediate next

Route the seven orphaned `docs/reviews/` records into `docs/backlog/`. It is purely mechanical, it
needs no design decision, and it is what unblocks judgment on everything else — including whether
CX-02 (pinned below) should still be the next implementation item.

## Deliberate state, not bugs

- `tests/audit/host-delegation-fold-carries-advisories.test.ts` remains deliberately unbaselined:
  its parallel-load timeout passes alone and is tracked as a known flake, so rebaselining it would
  hide a real regression.
- The detached host runner is intentionally not running.
- The item-6 checkJs sweep remains type-only by contract; behavioral changes are bugs, not part of
  that refactor.

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

- ▶ CX-02 — one audit obligation registry, one drain. · [`forward-tracks.md`](backlog/forward-tracks.md)

<!-- END GENERATED ROADMAP -->
