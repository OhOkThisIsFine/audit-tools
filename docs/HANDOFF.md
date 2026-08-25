# HANDOFF — audit-tools

> Immediate state and next action only. Durable design lives in `CLAUDE.md` and `spec/`;
> open work lives in `docs/backlog/`.

## Live state

- Published state: **v0.46.0** is the last tag, is published to npm, and is what the global bins run
  (`audit-code --version` / `remediate-code --version` both report it). `main` is ahead of that tag
  and in sync with the remote. Nothing ahead of the tag changes shipped behaviour, so no release
  is owed; `git log v0.46.0..main` is the record of what is ahead.
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

The nightly queue is EMPTY — all twelve propositions were answered on 2026-08-25 and nine are
landed. Six answered decisions remain unexecuted. Run `answer.mjs --list` for the authoritative
set with its keys; record each with `--done <KEY> "<ref>"` as it lands.

1. **sol-2 — re-target the P42 investigation at audit-code.** P42's original premise is verified
   FALSE (all seven cited sites in `src/remediate/steps/prompts.ts` are driver-facing; the worker
   packet carries no advance command), and its answer is already closed as superseded. What the
   owner kept is the intent: find where the `charter_extraction` / `systemic_challenge` incidents
   actually happened, in audit-code, before proposing any edit.
2. **sol-1 — the RED-AT record plus its reconciliation check.** A leg-3 proposal must RUN its test
   <!-- doc-citation-exempt: the record file this item exists to CREATE; it does not exist yet -->
   at HEAD, write the verbatim failure and sha to `RED-AT.txt`, and a check in `verify:checks`
   must refuse a proposal test with no sibling record. Also correct P44's own evidence table: it
   claims a hit rate of "2 of 2" when P37 and P40 both recorded genuine measured RED/GREEN runs.
3. **docs-4 — generate the README sample report from the renderer**, the way the Philosophy block
   is generated, so it cannot drift again.
4. **P41 — the prompt-contract registry** with its reconciliation leg (a prompt builder under
   `src/` that no row claims is a red build) and both escapes: projection rows and declared-gap rows.
   <!-- doc-citation-exempt: a runtime artifact the tool writes under .audit-tools/, never tracked -->
5. **Give `intent-interpretation.json` a reader** — wire a real consumer for `unencodable_clauses`
   so the persisted data is load-bearing and its correctness is tested.
6. **Bring `scripts/` under a tsconfig.** Measured this session: 1348 errors under full `strict`
   with `checkJs`, but **161** with `noImplicitAny` relaxed — the 1187 difference is pure
   annotation noise in plain `.mjs`. The 161 are real (a `Property 'code' does not exist on type
   'Error'`, several `possibly null`, an unguarded optional dynamic import). Note the owner's
   answer says "so the unchecked set is EMPTY": `wrapper/` (13 files), `.claude/hooks/` (12),
   `dispatch/` (4) and the repo-root bins are unreached too, not just `scripts/`.

Whenever a `next-step` is needed again, launch it DETACHED (`Start-Process`, redirected logs) —
never the default two-minute timeout, which kills it mid-gate and wedges `phase.lock` for every
later call.

## Deliberate state, not bugs

- `docs/backlog/open-bugs.md`'s repo-root-file entry was rewritten to say the SUITE is exonerated —
  6,496 instrumented spawns, none carrying a redirect. The producer is an agent session's own
  `cmd.exe`. Do not re-open it as a suite defect.
<!-- doc-citation-exempt: the external per-project host-memory index, not a tracked repo file -->
- The project memory index `MEMORY.md` sits AT its 24.4KB read limit, so trailing entries can load
  invisibly. It needs a real merge-and-cut pass (the sanctioned remedy), not another mechanical trim.

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
