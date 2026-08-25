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
  CP-NODE-7, CP-NODE-14 and CP-NODE-26. CP-NODE-26's CODE is fully landed on `main` (`da531169`,
  implemented by the free lane, finished and reviewed across three native review rounds after the
  free-lane outage) with the bound result doc already at the workload's `result_path` — but the
  tool refuses the ingestion: its mechanical required-test rerun keys on the EXIT CODE, and the
  full `npx vitest run tests/remediate tests/shared` sweep exits 1 on a vitest worker-RPC flake
  ("Timeout calling onTaskUpdate" as an unhandled error) while reporting zero failed tests. So
  `state.json` still holds CP-NODE-26 `pending` and `next-step` re-emits its workload. NODE-7 and
  NODE-14 are not started. The detached host runner is NOT alive and must stay down: the owner
  chose native workflow agents for the three remaining items (Ox-Alpha still refuses real-size
  requests; nemotron cannot close a pass). Runner recipes and relaunch traps: project memory
  `remediation-host-runner-2026-08-23`; run decisions: `remediation-first-draw-2026-08-22`.
- THREE answered decisions wait on the run, because their write targets collide with the three
  pending items' declared scope: the per-run-consent code fix (remove the durable
  recorded-`granted` route from `admitSpawn`; `240e467dfd7a8ac9`), P41 (prompt-contract registry,
  `db629de141ee6414`), and P42 (advance command out of worker prompts, `26e2d10e4569b448`). Check
  each answer's own write set against the PENDING blocks — the set is not uniformly blocked, and
  treating it as one unit has already parked ready work.
- DELIBERATE, not a bug: `src/audit/orchestrator/localCommands.ts` is inside CP-NODE-7's declared
  write scope and was edited on `main` anyway, to clear a CI red that had stood since the run's
  own CP-NODE-5 landing. That was safe because CP-NODE-7 has no worktree and no `host_handoff`
  binding — the run had not started it — so a worker branches from `main` and inherits the fix.

## Immediate next

1. Fix the vitest worker-RPC flake FIRST — it blocks EVERY remaining ingestion: either a vitest
   pool/reporter config fix, or the tool's required-test rerun counts test failures instead of the
   bare exit code when zero tests failed. Then run `node remediate-code.mjs next-step` (a timeout of
   eight minutes or more; NEVER the default two — a killed `next-step` wedges `phase.lock` for every
   later call, see the backlog entry) so CP-NODE-26's existing result doc ingests.
2. Finish NODE-7 then NODE-14 with the native workflow pattern this run used for CP-NODE-26
   (worktree → implement → adversarial review rounds → land with attestation → result doc via the
   <!-- doc-citation-exempt: session-scratchpad helper, deliberately outside the tree -->
   scratchpad `write-result-doc.mjs` → `next-step` ingests). When every item is terminal the tool
   enters closing (final gate): run `node remediate-code.mjs next-step` until the report is promoted
   (`.audit-tools/remediation-report.md` / `remediation-outcomes.json`).
3. After the run closes: the three remaining run-close-gated answers named in Live state
   (per-run-consent code fix first — it edits the files the final work items touch), each
   recorded done in the decision ledger as it lands.
4. Ask the owner the waiting decisions (generated list below).
5. Ship a release once the run closes (`/ship`): `main` carries the remediation landings, P39,
   P40, the executed queue items and the follow-up fixes since v0.45.0.

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
