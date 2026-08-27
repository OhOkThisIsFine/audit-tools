# HANDOFF — audit-tools

> Immediate state and next action only. Durable design lives in `CLAUDE.md` and `spec/`;
> open work lives in `docs/backlog/`.

## Live state

- **Complexity review implemented:** six of the seven candidates in
  `docs/reviews/complexity-reduction-audit-2026-08-26.md` are landed as atomic commits (CX-01
  SCC cycle core — a real correctness fix; CX-03 dead-API deletion; CX-04 single cross-gate
  evaluator; CX-05 shared survivor fold; CX-06 shared submission scan; CX-07 table-driven field
  checks). Each was premise-verified by independent lanes and adversarially refuted before
  implementation. CX-02 is the pinned next item (see the roadmap block below); its verified design
  inputs live in `docs/reviews/cx02-drain-unification-design-2026-08-26.md`.
- **Both nightly queues are fully answered and landed** (2026-08-26 twelve items; 2026-08-27 six
  items), including: the P45 memory-crosslink gate, the remote-name removal from the skills, the
  CLAUDE.md single-source edits, the generated spec/audit registry mirrors (`check:spec-mirrors`),
  and `--root` absorbed into canonical root resolution on BOTH bins (an absent `--root` is now
  discovered from the caller's cwd; explicit roots are honored verbatim).
- **Off-repo:** the FreeLLMAPI Cloudflare key is repaired and verified live; the pool launcher no
  longer hand-types a model alias.
- **Repository:** `main` and `origin/main` are synchronized; every commit passed its gates.
  The release pipeline run for this lap's code changes is the ship step of the current session.

## Immediate next

CX-02 (pinned below) is the one open implementation item. It is a multi-session atomic loop-core
replace — start from its design record, not from the review section.

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
