# HANDOFF — audit-tools

> Immediate state and next action only. Durable design lives in `CLAUDE.md` and `spec/`;
> open work lives in `docs/backlog/`.

## Live state

- Published state: **v0.49.0** is the last tag, is live on npm (`latest`), and is what the global
  bins run after the manual postinstall. The canonical release run is **32990705280** (gate + 4
  test shards + trusted publish, all green). Its `release` event arrived ~13 minutes late, the
  release script timed out at 10 and exited 1 AFTER tagging — the recovery story and the property
  to build live in the new `docs/backlog/open-bugs.md` entry on the await-run timeout. `main` is
  in sync with the remote.
- v0.49.0 is the **shared-helper consolidation lap** (10 commits, `6403e766..61b9aed9`): one home
  each for `compareCodeUnits`, `isRecord`, `hashContent`, the root-containment predicate, and the
  two path normalizers; `localeCompare` eliminated from `src/` entirely (one-time deliberate
  persisted-order churn — artifacts re-derive); JSONC comments through the vetted
  `strip-json-comments`; and the data-driven `check:shared-primitives` gate (verify:checks,
  pre-commit reach on src, guard-reach registered, contract-tested — measured red at 231
  violations before the lap, zero after). Backlog entries for the containment forks, re-rolled
  primitives, ICU ordering, the JSONC scanner, and the lockfile mismatch are DELETED as enforced
  or fixed.
- ⚠ `tests/audit/host-delegation-fold-carries-advisories.test.ts` stays deliberately
  UN-baselined (owner, 2026-08-24): a parallel-load timeout there is re-checked by a solo rerun,
  never re-baselined — a known-flaky record would launder a genuine regression. Do not "fix" it.
- The detached host runner is NOT alive and must stay down.

## Immediate next

Nothing pending — the consolidation lap is fully landed, reviewed (two adversary lanes + full
verify:release), and SHIPPED as v0.49.0. Every open item lives in `docs/backlog/`; nothing is
pinned immediate-next.

Whenever a `next-step` is needed again, launch it DETACHED (`Start-Process`, redirected logs) —
never the default two-minute timeout, which kills it mid-gate and wedges `phase.lock` for every
later call.

## Deliberate state, not bugs

- The item-6 checkJs sweep is TYPE-ONLY by contract: JSDoc casts/typedefs and safe narrowing, plus
  one unreachable narrowing throw in `scripts/release-and-publish.mjs` placed to keep the pinned
  `resolveReleasePushRefspec(releaseGate)` source contract intact. A behavioral diff there is a
  bug, not a refactor.

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
