# HANDOFF — audit-tools

> Immediate state and next action only. Durable design lives in `CLAUDE.md` and `spec/`;
> open work lives in `docs/backlog/`.

## Live state

- **v0.51.0 is live**, published from the release commit `e6329a44`; the release workflow
  passed and the registry artifact is installed globally. Both `audit-code --version` and
  `remediate-code --version` report `0.51.0`.
- **The 2026-09-03 lap landed the nine live-run defects** as three loop-core clusters —
  adjudication verification status, status-truth vocabulary with per-lane ledger rows, and
  packet provenance with citation validation — together with P50, the seek-index parser
  fix, and the design-gate record in
  [`live-run-defect-set-design-gate-2026-09-03.md`](reviews/live-run-defect-set-design-gate-2026-09-03.md).
- **Two red-on-main landings were repaired in-lap:** an invariant-test import and a
  platform-asymmetric file classifier.

## Immediate next

The owner confirms the nine in-force design assumptions listed in that design-gate record.
The owner decided on 2026-09-04 to improve llm-relay first (a fast dispatch path in the
llm-relay repository), after which the sweep routes through it; tracked in the machine-wide
backlog. The external 5-primary + 5-held-out paired benchmark run described in
[`forward-tracks.md`](backlog/forward-tracks.md) stays the pinned forward track.

## Deliberate state, not bugs

- The nine design assumptions are in force pending the owner's confirmation; the design-gate
  record states each one with the alternative it was chosen over.
- The judge-side naming refusal is unreachable on the production path by design of the parse
  order: the property it guards holds twice over, and only its claimed reach does not. Tracked
  in [`minor-bugs.md`](backlog/minor-bugs.md).
- The charter packet builder no longer caps packet size; its coverage manifest records only
  unreadable or empty omissions.

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
