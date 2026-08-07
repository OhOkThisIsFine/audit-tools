# HANDOFF — audit-tools

> Immediate state and next action only. Durable design lives in `CLAUDE.md` and `spec/`;
> open work lives in `docs/backlog/`.

## Live state

- **v0.39.3 in flight 2026-08-07 (analyzer sweep + T4 splits).** One attested commit carries:
  the external-analyzer sweep verified/fixed/adopted (record:
  [`reviews/analysis-tools-plan-2026-08-07.md`](reviews/analysis-tools-plan-2026-08-07.md) — three
  new dev gates `check:lint` / `check:dup` / `check:depgraph` in `verify:checks`, ts-prune + madge
  removed, ~330 verified lint findings fixed incl. a `src/shared`→`src/audit` layering violation
  dissolved by moving `artifactFreshness` into shared); and the CI wall-clock brief's **T4 top
  three** — wrapper, next-step and pre-commit-gate suites each split over a shared harness with
  exact test-count parity, `verify:guards` excludes + guard-reach rows updated, shard-duration
  baseline regenerated from a green full run (status block in
  [`reviews/ci-wallclock-plan-critique-2026-08-07.md`](reviews/ci-wallclock-plan-critique-2026-08-07.md)).
- **Dogfood/meta-review cluster deliberately NOT run this session** (owner call, 2026-08-07) — it
  stays the pinned item below.
- `analysis-results-*/` is now gitignored (raw sweep output is disposable; conclusions live in the
  review doc). The owner's Codex-lane droppings at repo root became tracked, real configs
  (`.dependency-cruiser.cjs`, `eslint.config.js`, `.jscpd.json`).

## Verification state

- Full suite green on the pre-release tree 2026-08-07 (584 files + 5 split families; the one red on
  the first full run was the gate-enumeration parity test catching the three unglossed new gates —
  fixed, re-run green). All gates green: lint/dup/depgraph (new), guard-reach, knip (project now
  includes `tests/**`), both typechecks, doc/backlog gates. Loop-core diff attested
  (staged-tree-bound, agent class).

## Immediate next

1. **Dogfood/meta-review 2026-07-30 cluster** (open-bugs, pinned) — live-run-watch properties;
   needs a quiet tree.
2. **Analyzer-sweep dedup cluster** (open-bugs) — ten verified extractions, evidence in the sweep
   review doc §4; the loop-core pairs (reviewPacket helpers, acceptNode outcome twins) deserve their
   own attested commit.
3. **T4 remainder** (the CI wall-clock brief) — the true single-file floor turned out to be
   `audit-code-completion.test.ts` (~335s; it sat outside the shard-1 ledger the brief measured),
   so the floor moves only when IT is split; queue + protocol in the brief's status block.
4. Host-memory chore (not repo work): `/consolidate-memory` — the memory index still needs its
   consolidation pass (pointer note at the top of `MEMORY.md`).

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
