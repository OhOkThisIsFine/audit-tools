# HANDOFF — audit-tools

> Immediate state and next action only. Durable design lives in `CLAUDE.md` and `spec/`;
> open work lives in `docs/backlog/`.

## Live state

- **Package:** the repository version remains `0.49.0` and both global command shims resolve.
  This sprint changes documentation only, so it requires no tag, package publish, or global-bin
  reinstall.
- **Audits:** the structural and philosophy simplification reports are complete in
  `docs/reviews/complexity-reduction-audit-2026-08-26.md` and
  `docs/reviews/philosophy-simplification-audit-2026-08-26.md`. Production code is unchanged.
- **Repository:** at hand-back, `main` and `origin/main` are synchronized and the required checks
  are green.
- **Closeout:** repaired in two layers. *Repo* — five defects in the rendered hand-back; the
  record is now `version: 2` and binds to a worktree tree id, so committing what the report described
  no longer invalidates it. *Machine-wide* — the closeout SCHEMA is canonical in
  `~/.claude/portable-engineering-principles.md` (eight steps, in order), this repo's step list now
  matches it, and the multi-host generator at ~/.agent-config/sync.mjs mirrors that document, so its
  --check catches drift. Measurement and the one residual stated rather than closed:
  `docs/reviews/closeout-generation-failure-2026-08-26.md`.

## Immediate next

Nothing pending. The reports contain recommendations, not an implementation commitment. Every
accepted open item belongs in `docs/backlog/`; none is pinned as immediate next.

## Deliberate state, not bugs

- `tests/audit/host-delegation-fold-carries-advisories.test.ts` remains deliberately unbaselined:
  its parallel-load timeout passes alone and is tracked as a known flake, so rebaselining it would
  hide a real regression.
- The detached host runner is intentionally not running.
- The item-6 checkJs sweep remains type-only by contract; behavioral changes are bugs, not part of
  that refactor.

<!-- BEGIN GENERATED LIVE STATUS — scripts/shared/generate-handoff-roadmap.mjs — DO NOT EDIT BY HAND -->

- **12 nightly decisions are waiting.** Answer in [`nightly-inbox.md`](nightly-inbox.md); settled items disappear from this generated block.
  - `docs-1` — Stop hard-coding the git remote name in the skills, or keep spelling it out?
  - `docs-2` — instruction-file edit: replace CLAUDE.md's hand-listed pre-commit legs with a pointer to the registry
  - `docs-3` — instruction-file edit: the CLAUDE.md Commands block omits the check:scripts typecheck gate
  - `docs-4` — constitutional doc: the goals doc names one review gate where the code has two, on different paths
  - `docs-5` — The closeout template claims a single-sourced friction vocabulary that is actually a hand-copy
  - `docs-6` — instruction-file edit: CLAUDE.md re-lists the eleven lenses that LensSchema already single-sources
  - `docs-7` — Three spec/audit docs hand-mirror registries whose sibling view is already generated
  - `docs-8` — The audit loader mandates --root on every command; CLAUDE.md calls a needed manual flag a bug signal
  - `docs-9` — The philosophy map points the universal-host-prompts conviction at a home that does not state it
  - `docs-10` — The audit workflow design states provider cache accounting the tool gave up owning
  - `sol-1` — P45: extend check:memory-citations to the [[name]] form memories actually cite each other in
  - `sol-2` — P46: one provider with a known-broken key took 43 of tonight's 45 leg-2 errors

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
