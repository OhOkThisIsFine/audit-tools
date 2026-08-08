# HANDOFF — audit-tools

> Immediate state and next action only. Durable design lives in `CLAUDE.md` and `spec/`;
> open work lives in `docs/backlog/`.

## Live state

- **v0.39.4 SHIPPED 2026-08-07 (dedup cluster + type-only cycle gate + T4 completion split).** Six
  commits: `3a5d352c` score primitives; `c38f4511` (attested) `compareGraphEdges` +
  `reviewPacketShared` + acceptNode `rollbackFailureOutcome`; `4082c237` (attested) all three
  type-only cycles broken **and the `no-circular` rule tightened** — the `viaOnly` type-only
  exemption is gone, so a type-only cycle is now a red build; `e5eda582` one backlog-entry grammar
  for the scripts tree; `6734b25d` the T4 split of `audit-code-completion.test.ts`; `9407db81` the
  record + regenerated baseline.
- **Five of the sweep's ten dedup findings are done.** The four that remain each carry a verified,
  diff-ready spec in [`reviews/dedup-cluster-2026-08-07b.md`](reviews/dedup-cluster-2026-08-07b.md),
  which also records three cases where the analysis lane's proposal was wrong and what the
  verification pass found instead — read it before re-deriving any of them.
- **T4 floor moved.** `audit-code-completion.test.ts` (~335s) is split five ways over
  `tests/audit/helpers/completion-harness.ts` with exact test-count parity. The regenerated baseline
  puts the new single-file ceiling at `audit-code-wrapper-packets.test.ts` (**198.5s**), which is the
  brief's named next target.
- **Dogfood/meta-review cluster still NOT run** (owner call, 2026-08-07) — it stays the pinned item.

## Verification state

- Full suite green on this tree 2026-08-07: **589 files / 7681 tests passed**, 4 files + 15 tests
  skipped. `verify:checks` green. A strict all-cycles `depcruise` (tsPreCompilationDeps on) reports
  zero cycles of any kind across 542 modules; the tightened `no-circular` rule was red-green
  validated (reintroduced cycle → exit 1) and restored by inverting the edit.
- The shard-duration baseline is regenerated from that green full run (593 files).
- Loop-core commits `c38f4511` and `4082c237` attested (staged-tree-bound, agent class).
- Release CI green for v0.39.4 (run 31234888604): gate 130s, test shards **137/131/165/182s**,
  publish 73s. The T4 split shows up as a tighter spread and a lower ceiling — v0.39.3's shards were
  205/198/151/132, so the slowest shard fell 205s → 182s. npm live at 0.39.4; global bins reinstalled
  + postinstall run manually (npm defers it on `-g`), both report 0.39.4.

## Immediate next

> **Owner call 2026-08-07, superseding the earlier deferral:** the dogfood deferral is **obsolete** —
> dogfooding can run whenever, the quiet tree is no longer the gate. But **known refactoring goals
> come first, before another audit run.** That is why the pinned dogfood cluster is last here while
> still being the backlog's pinned item.

1. **Remediate sidecar filenames — unsanitized, and built in TWO places** (open-bugs). The sharpest
   remaining defect: `marshal.ts` independently rebuilds the names `providerNodeDispatch` writes, so
   sanitizing only the writer makes marshal report "never dispatched" for every node. Fix both
   through one helper, and move `artifactNameForId` down into shared on the way.
2. **Analyzer-sweep dedup cluster — remaining three** (open-bugs) — specs written and verified in
   [`reviews/dedup-cluster-2026-08-07b.md`](reviews/dedup-cluster-2026-08-07b.md). The
   rolling-dispatch prep head is the one with real design content (one-core-two-draws) and wants its
   own attested commit.
3. **T4 remainder** — next target `audit-code-wrapper-packets.test.ts` (198.5s), same
   one-file-at-a-time protocol; queue in the brief's status block.
4. **Dogfood/meta-review 2026-07-30 cluster** (open-bugs, pinned) — live-run-watch properties. Run
   it once the refactors above are done, per the owner call.
5. Host-memory chore (not repo work): `/consolidate-memory` — the index is ~20KB against a 17.1KB
   target across 227 files. A further mechanical trim is NOT the fix; the note at the top of
   `MEMORY.md` records the constraint that blocks a naive merge (several memory files are cited by
   repo docs, and `check:memory-citations` fails on a dangling citation).

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
> `verify:checks` and at commit). 1 pinned item(s).

### ▶ Next up — pinned in the backlog

- ▶ Dogfood/meta-review 2026-07-30 cluster — remaining live-run-watch properties. · [`open-bugs.md`](backlog/open-bugs.md)

<!-- END GENERATED ROADMAP -->
