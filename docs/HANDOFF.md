# HANDOFF — audit-tools

> Immediate state and next action only. Durable design lives in `CLAUDE.md` and `spec/`;
> open work lives in `docs/backlog/`.

## Live state

- Published state: v0.45.0 is the last tag, is published to npm, and is what the global bins run.
  `main` is ahead of it, pushed, and green; that work is not yet released.
- The first-draw REMEDIATION RUN (`.audit-tools/remediation/`, 30 work items) has every work item
  terminal: 25 resolved, 5 resolved with no change. CP-NODE-26, CP-NODE-7 and CP-NODE-14 all landed
  and ingested on 2026-08-24. Its `closing_plan` is `{action: "none"}`, so closing runs no actions —
  `next-step` until `.audit-tools/remediation-report.md` and `remediation-outcomes.json` are promoted.
- ⚠ `tests/audit/host-delegation-fold-carries-advisories.test.ts` timed out at 120s once under a
  full `npx vitest run tests/audit` and passed alone — the known load/hermeticity class, and it does
  NOT reach either item's changed code (its `runtime_validation_tasks` list is empty). The flake
  baseline correctly left it UNRECOGNIZED, which keeps it red. It matters because ingestion reruns
  that exact raw command with no retry, so a flaky red there refuses a good result.
  DELIBERATE, not an oversight: the baseline was NOT written. Both observations the record needs
  now exist (a parallel failure and a solo pass), so `npm run test:rebaseline-flakes` would be
  legitimate — but writing it is a deliberate act on a tree already decided green, and doing it
  mid-item is how a genuine regression gets laundered into "known flaky". Decide it at a settled
  point, or leave it red.
- The detached host runner is NOT alive and must stay down; the remaining items were done with
  native agents.
- **Both final items needed their write scope widened before they could be implemented**, with the
  owner's approval: each declared only source files while its obligations required tests, and
  CP-NODE-14's own contract text said the scope "spans the sole src file AND tests/audit". The
  sanctioned recipe is widen `state.plan.blocks[].touched_files`, delete `state.host_handoff`, then
  `next-step` to re-mint. This is the open high-severity entry *"The DAG-derived write scope omits
  the companion files a fix needs"* — P38 closed only the declared-outputs half.

## Immediate next

1. Drive the run to close: `node remediate-code.mjs next-step` until the report is promoted. Launch
   it DETACHED (`Start-Process`, redirected logs) — never the default two-minute timeout, which
   kills `next-step` mid-gate and wedges `phase.lock` for every later call.
2. Execute the nine answered-not-done decisions — `node scripts/nightly/answer.mjs --list`. With the
   run closed nothing is scope-blocked; record each with `--done <KEY> "<ref>"` as it lands. They
   are: the per-run-consent code fix, P41, P42, P43, and the five 2026-08-24 answers (docs-1,
   docs-2, docs-3, backlog-1 give the sidecar a reader, backlog-2 typecheck `scripts/`).
3. Ship a release (`/ship`): `main` carries the three remediation landings plus everything since
   v0.45.0.

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
