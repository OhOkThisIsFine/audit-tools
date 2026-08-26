# HANDOFF — audit-tools

> Immediate state and next action only. Durable design lives in `CLAUDE.md` and `spec/`;
> open work lives in `docs/backlog/`.

## Live state

- Published state: **v0.48.0** is the last tag, is live on npm (CI run 32953603424 green,
  gate + 4 test shards + trusted publish), and is what the global bins run after the manual
  postinstall. `main` is in sync with the remote. v0.47.0 was burned and cleaned
  (`gh release delete --cleanup-tag`): its CI gate red was a dist-masked missing paths mapping in
  `tsconfig.scripts.json`, fixed in `5c4dcaa0`. No release is owed.
- The 2026-08-25 decision queue is fully executed and recorded (`answer.mjs --list` reports every
  tracked answer done): sol-2 `66df2416`, sol-1 `e624e7b3`, docs-4 `6eb71c06`, P41 `25036a5c`,
  the sidecar reader `0287e93d`, the scripts typecheck `2a1faa1f`.
- ⚠ `tests/audit/host-delegation-fold-carries-advisories.test.ts` timed out at 120s once under a
  full `npx vitest run tests/audit` and passed alone — the known load/hermeticity class, and it does
  NOT reach either item's changed code (its `runtime_validation_tasks` list is empty). The flake
  baseline correctly left it UNRECOGNIZED, which keeps it red. It matters because ingestion reruns
  that exact raw command with no retry, so a flaky red there refuses a good result.
  OWNER DECISION (2026-08-24): leave it RED — the baseline is deliberately NOT written. Both
  observations the record needs now exist (a parallel failure and a solo pass), so
  `npm run test:rebaseline-flakes` would be legitimate; recording it was declined because a
  known-flaky record is also what would launder a genuine regression, and a red that is re-checked
  costs less than a green that is trusted wrongly. Do not "fix" this by re-baselining.
- The detached host runner is NOT alive and must stay down.
- ⚠ **A second session has been committing to this checkout.** Three commits between `28912720`
  and `521d43b0` were not mine, and one of them (`cc73faa9`) fixed a real `check:lint` red I had
  left on main. Run `git log` before assuming the tree is only yours, and run `check:lint` — not
  just `check` + `check:tests` — after any deletion-heavy change.

## Immediate next

Nothing pending — the 2026-08-25 queue is fully landed, marked, and SHIPPED as v0.48.0 (per-item
refs in Live state). Every open item lives in `docs/backlog/`; nothing is pinned immediate-next.

Whenever a `next-step` is needed again, launch it DETACHED (`Start-Process`, redirected logs) —
never the default two-minute timeout, which kills it mid-gate and wedges `phase.lock` for every
later call.

## Deliberate state, not bugs

- `tests/audit/host-delegation-fold-carries-advisories.test.ts` stays deliberately UN-baselined
  (owner, 2026-08-24): a parallel-load timeout there is re-checked by a solo rerun, never
  re-baselined — a known-flaky record would launder a genuine regression. Do not "fix" it.
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
