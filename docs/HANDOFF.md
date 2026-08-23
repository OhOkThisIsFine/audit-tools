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
  phase: 24 items are on `main`, 5 resolved with no change, and NODE-5 is implementing with
  26 → 7 → 14 queued behind it. NODE-5 is a RESUMED worker: two 160-turn attempts died on an
  under-scoped async-boundary ripple, so the host widened the block a second time (19 allowed
  files), re-queued it with `resume_from: "implement"` to keep the partial worktree, and dropped
  the stale `state.host_handoff` binding so the tool re-minted the workload (see the binding-wedge
  entry in `docs/backlog/open-bugs.md`). A DETACHED host runner drives the run (relaunched
  2026-08-23 22:58Z from the main checkout); it lands items serially on `main`, writes the bound
  result docs, re-runs `next-step` per round, and stops on any pause it cannot answer. The runner,
  its logs, watch/stop/resume, the pause recipes, and the relaunch traps (an auto-permission-mode
  session cannot spawn it) are in project memory `remediation-host-runner-2026-08-23`; the run's
  decisions are in `remediation-first-draw-2026-08-22`.
- The owner-answered queue items of 2026-08-23 are executed except one: the per-run-consent code
  fix (remove the durable recorded-`granted` route from `admitSpawn`; answer key
  `240e467dfd7a8ac9` in the decision ledger under `.claude/`) deliberately waits for NODE-5 to
  land, because it edits NODE-5's files.

## Immediate next

1. Finish the remediation run: read the runner log named in memory `remediation-host-runner-2026-08-23`.
   If the parent is alive, leave it; if it stopped, answer the pause per that memory's recipes and
   relaunch `node .audit-tools/remediation/host-runner/impl-runner.mjs --concurrency 10` from the
   main checkout — from a terminal or a bypass-permissions session; auto permission mode refuses
   the spawn. When every item is terminal the tool enters closing (final gate): run
   `node remediate-code.mjs next-step` until the report is promoted
   (`.audit-tools/remediation-report.md` / `remediation-outcomes.json`).
2. After NODE-5 lands: the per-run-consent code fix (answer key `240e467dfd7a8ac9`, see Live
   state), then record it done in the decision ledger.
3. Ask the owner the waiting decisions (generated list below).
4. Ship a release once the run closes (`/ship`): `main` carries the 24 remediation landings, P39,
   P40, three executed queue items and the follow-up fixes since v0.45.0.

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
