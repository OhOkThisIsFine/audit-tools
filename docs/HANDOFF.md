# HANDOFF — audit-tools

> Immediate state and next action only. Durable design lives in `CLAUDE.md` and `spec/`;
> open work lives in `docs/backlog/`.

## Live state

- Published state: **v0.46.0** is the last tag, is published to npm, and is what the global bins run
  (`audit-code --version` / `remediate-code --version` both report it). `main` is five commits
  AHEAD of that tag and in sync with the remote: the 2026-08-25 nightly run's doc corrections,
  proposal P43, and the run's own artifacts. None of it changes shipped behaviour, so no release
  is owed.
- The first-draw REMEDIATION RUN (`.audit-tools/remediation/`, 30 work items) has every work item
  terminal: 25 resolved, 5 resolved with no change. CP-NODE-26, CP-NODE-7 and CP-NODE-14 all landed
  and ingested on 2026-08-24. Its `closing_plan` is `{action: "none"}`, so closing runs no actions —
  `next-step` until `.audit-tools/remediation-report.md` and `remediation-outcomes.json` are promoted.
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
- The detached host runner is NOT alive and must stay down; the remaining items were done with
  native agents.
- **Both final items needed their write scope widened before they could be implemented**, with the
  owner's approval: each declared only source files while its obligations required tests, and
  CP-NODE-14's own contract text said the scope "spans the sole src file AND tests/audit". The
  sanctioned recipe is widen `state.plan.blocks[].touched_files`, delete `state.host_handoff`, then
  `next-step` to re-mint. This is the open high-severity entry *"The DAG-derived write scope omits
  the companion files a fix needs"* — P38 closed only the declared-outputs half.

## Immediate next

1. Execute the nine answered-but-unexecuted decisions the ledger lists — run `answer.mjs --list` to
   see them. Nothing is scope-blocked now that the run is closed; record each with
   `--done <KEY> "<ref>"` as it lands. They are: the per-run-consent code fix, P41, P42, P43, and
   the five 2026-08-24 answers (name the shared host-handoff barrel in `CLAUDE.md`; reword the
   lean-fast-path heading in `spec/remediation-workflow-design.md`; state the two consent roles;
   <!-- doc-citation-exempt: a runtime artifact the tool writes under .audit-tools/, never tracked -->
   give the `intent-interpretation.json` sidecar a real reader; bring `scripts/` under a tsconfig).
2. Whenever a `next-step` is needed again, launch it DETACHED (`Start-Process`, redirected logs) —
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

- **12 nightly decisions are waiting.** Answer in [`nightly-inbox.md`](nightly-inbox.md); settled items disappear from this generated block.
  - `docs-1` — The cleanup sentence says --force unblocks a missing-state run; it never does - restate the three-way rule, or trim the claim
  - `docs-2` — The HANDOFF still tells the next agent to advance a remediation run that closed and deleted its state - rewrite the bullet, or drop it
  - `docs-3` — The README promises every finding is adversarially verified before it is kept; ungrounded findings ARE kept - reword the promise, or narrow it
  - `docs-4` — The README sample report shows headings the renderer never emits - generate the sample, or hand-correct it
  - `docs-5` — The artifact contract stamps the charter layer charter-register/v2; the code says v3 - bump the literal, or stop stating the version in prose
  - `docs-6` — The release refusal message says origin/main in a checkout whose only remote is audit-tools - print the resolved remote, or keep the shorthand
  - `docs-7` — The design doc grants design review a graph-constrained file scope; the shipped prompt tells it to roam freely - pick which is authoritative
  - `docs-8` — The goals doc names lean_fast_path a second plan-building MECHANISM; the philosophy says one pipeline at two depths - pick the normative wording
  - `docs-9` — Core principle 1 admits the LLM only where no deterministic rule exists; the philosophy admits it wherever it strongly lifts quality - reword, or keep it stricter
  - `docs-10` — Phase 3 writes tests from an item spec the same doc calls optional - name the fallback, or make the spec mandatory
  - `sol-1` — P44: a leg-3 proposal ships a red-green test nobody ever runs - record the measured RED, or keep the prediction
  - `sol-2` — P42's premise is false: its seven cited sites are DRIVER-facing - withdraw the answer, or re-target it at audit-code

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
