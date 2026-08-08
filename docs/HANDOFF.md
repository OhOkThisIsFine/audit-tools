# HANDOFF — audit-tools

> Immediate state and next action only. Durable design lives in `CLAUDE.md` and `spec/`;
> open work lives in `docs/backlog/`.

## Live state

- **v0.39.5 SHIPPED 2026-08-07.** npm live at 0.39.5, global bins reinstalled + postinstall run
  manually (npm defers it on `-g`), both report 0.39.5.
- **The analyzer sweep's dedup cluster is 6 of 10 done.** The remaining three, plus a defect found
  en route, are the immediate-next list below. Each carries a verified, diff-ready spec in
  [`reviews/dedup-cluster-2026-08-07b.md`](reviews/dedup-cluster-2026-08-07b.md) — which also
  records four cases where the offload lane's proposal was WRONG and what verification found
  instead. Read it before re-deriving any of them.
- **A type-only import cycle is now a red build.** All three that existed were broken and
  `no-circular` lost its `viaOnly` exemption, so the cleanup is enforced rather than tracked.
- **The T4 single-file floor is now `audit-code-wrapper-packets.test.ts` (198.5s)**, after
  `audit-code-completion.test.ts` (~335s) was split five ways over
  `tests/audit/helpers/completion-harness.ts`.

## Verification state

- Full suite green 2026-08-07: **589 files / 7681 tests passed** (4 files + 15 tests skipped);
  `verify:checks` green on the clean pushed tree. The shard-duration baseline is regenerated from
  that green full run.
- Release CI green for v0.39.4 (run 31234888604) and v0.39.5. The T4 split shows as a tighter shard
  spread: v0.39.3 was 205/198/151/132, v0.39.5 is 180/140/150/191 — slowest shard down from 205s,
  critical path ~255s.
- A strict all-cycles `depcruise` (`tsPreCompilationDeps` on) reports zero cycles of any kind across
  542 modules; the tightened `no-circular` rule was red-green validated (reintroduced cycle → exit 1)
  and restored by inverting the edit, never by checkout.
- Loop-core commits attested (staged-tree-bound, agent class): `c38f4511`, `4082c237`, `426c2ba6`.

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
