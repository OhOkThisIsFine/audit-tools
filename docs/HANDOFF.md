# HANDOFF — audit-tools

> Immediate state and next action only. Durable design lives in `CLAUDE.md` and `spec/`;
> open work lives in `docs/backlog/`.

## Live state

- Published state: v0.42.1 (the tag, not a sha — a sha here restales on every commit). Everything
  below `main`'s tip is pushed and CI is green on both workflows; there are many unreleased
  commits, so a publish is available whenever the owner wants one (`/ship` runs the whole flow).
- **The remediation run `remediate-2026-08-18-…` is COMPLETE**: 27 of 27 findings settled
  (25 resolved, 2 verified-already-correct with full evidence), the close phase ran the repository
  gate to an executed PASS, and the promoted deliverables sit at
  [`remediation-report.md`](../.audit-tools/remediation-report.md) /
  `.audit-tools/remediation-outcomes.json` — including the report's first live Repository Gate
  section. Friction triage is written (7 observations, 3 categories) in the run's friction record.
- The coarse final-gate backstop is RETIRED: a red tool-owned gate now records to
  `final-gate.json` and emits a resumable `final_gate_red` pause with zero state mutation. The
  retirement was validated live twice this session — once against the wipe it was built to
  prevent, once against an ordinary red it paused through cleanly.

## Immediate next

1. **The consolidated pass** — the entries at the top of
   [`open-bugs.md`](backlog/open-bugs.md): the wave's deferred durable tests, the owner-decided
   registry deletion, the dead `validateDispatchArtifacts` family, the targeted-command
   shape-gate non-adopters, the duplicated dispatch-barrel baseline, and the
   scratch-root-guard / INV-shared-tests-08 overlap fold decision.
2. **Build the approved write-scope resolver fix** (P38, owner-approved: union the module
   contract's declared write targets into the node scope). This run paid nine manual
   delete-binding-and-re-prepare widening cycles; the fix retires the class. The built patch is
   in the nightly routine's proposals directory.
3. **Publish decision** — the owner's call; everything is landed and green.
4. **A fresh dogfood lap** on the new architecture (the standing next step from the zero-adapter
   retirement, now unblocked by the completed run).

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
