# HANDOFF — audit-tools

> Immediate state and next action only. Durable design lives in `CLAUDE.md` and `spec/`;
> open work lives in `docs/backlog/`.

## Live state

- Published state: v0.45.0 is the last tag, is published to npm, and is what the global bins run.
  `main` is ahead of it, pushed, and CI-green; that work is not yet released.
- The dogfood self-audit's deliverables are `.audit-tools/audit-report.md` and
  `.audit-tools/audit-findings.json`. The tool defects it and the remediation run exposed are the
  2026-08-21 through 2026-08-23 entries in `docs/backlog/open-bugs.md`.
- The first-draw REMEDIATION RUN (`.audit-tools/remediation/`, 30 work items) is in its implement
  phase: 22 items are resolved on `main`, 5 resolved with no change, and THREE remain pending —
  CP-NODE-7, CP-NODE-14 and CP-NODE-26. NODE-5 landed as `2f518770`. The detached host runner is
  NOT currently alive; relaunch it per project memory `remediation-host-runner-2026-08-23`, which
  holds its logs, watch/stop/resume, the pause recipes, and the relaunch traps (an
  auto-permission-mode session cannot spawn it). The run's decisions are in
  `remediation-first-draw-2026-08-22`.
- Every queue decision of 2026-08-23 is answered and recorded. ONE of the four answered-not-done
  items landed on 2026-08-24 as `7e34fe14`: the F-label retirement from source comments
  (`5acf2e262ebd7ab0`), which touched no file any pending block claims. THREE still wait, because
  their write targets DO collide with the three pending items' declared scope: the per-run-consent
  code fix (remove the durable recorded-`granted` route from `admitSpawn`; `240e467dfd7a8ac9`),
  P41 (prompt-contract registry, `db629de141ee6414`), and P42 (advance command out of worker
  prompts, `26e2d10e4569b448`). That collision is re-derived by hand each session; the queue below
  carries a proposal to print the run's write scope in `answer.mjs --list` instead.

## Immediate next

1. Finish the remediation run: read the runner log named in memory `remediation-host-runner-2026-08-23`.
   If the parent is alive, leave it; if it stopped, answer the pause per that memory's recipes and
   relaunch `node .audit-tools/remediation/host-runner/impl-runner.mjs --concurrency 10` from the
   main checkout — from a terminal or a bypass-permissions session; auto permission mode refuses
   the spawn. When every item is terminal the tool enters closing (final gate): run
   `node remediate-code.mjs next-step` until the report is promoted
   (`.audit-tools/remediation-report.md` / `remediation-outcomes.json`).
2. After the run closes: the three remaining run-close-gated answers named in Live state
   (per-run-consent code fix first — it edits the files the final work items touch), each
   recorded done in the decision ledger as it lands.
3. Ask the owner the waiting decisions (generated list below).
4. Ship a release once the run closes (`/ship`): `main` carries the remediation landings, P39,
   P40, the executed queue items and the follow-up fixes since v0.45.0.

<!-- BEGIN GENERATED LIVE STATUS — scripts/shared/generate-handoff-roadmap.mjs — DO NOT EDIT BY HAND -->

- **5 nightly decisions are waiting.** Answer in [`nightly-inbox.md`](nightly-inbox.md); settled items disappear from this generated block.
  - `docs-1` — instruction-file edit: name the shared host-handoff core in CLAUDE.md, or leave the two twins as the documented owners
  - `docs-2` — the 'lean fast-path exception' heading advertises an exception the same section then denies — reword it, or keep it as history
  - `backlog-1` — intent-interpretation.json is a write-only sidecar — give it a reader, or delete it
  - `backlog-2` — declare the tracked trees no typechecker reaches — pick the mechanism, or accept the absence
  - `sol-1` — P43: print an open remediation run's write scope in answer.mjs --list, so answered work is not hand-checked against it every session

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
