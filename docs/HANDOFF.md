# HANDOFF — audit-tools

> Immediate state and next action only. Durable design lives in `CLAUDE.md` and `spec/`;
> open work lives in `docs/backlog/`.

## Live state

- **Prompt/process critique: design SETTLED 2026-08-05, ready to implement.** Four green-lit
  atomic changes — uniform id-join contract (hard-fail everywhere), always-materialized fan-out
  (no capability branch), scope-confirmation context (both halves), charter scope-by-feeding with
  stated/structural/revealed estimators + downstream triangulated telos. Settled spec:
  §"Design resolutions" in
  [`reviews/prompt-process-critique-2026-08-05.md`](reviews/prompt-process-critique-2026-08-05.md);
  hook in `backlog/forward-tracks.md`. **Change 1 (uniform id-join contract) SHIPPED 2026-08-05**
  after `/design-check` + owner carve-out ruling (merge keeps OBL-INV-RSD-01; hard-fail lives at
  the resolution/ingest gates): review/ambiguity/clarification/triage/intake gates refuse unknown
  ids whole (archive + re-halt with the valid set), fuzzy alias remap deleted with a bounded
  re-dispatch cap (`implement-redispatch-attempts.json` sidecar), synthesis narrative refuses
  unknown `finding_ids`. Independent loop-core review: approve (agy Sonnet 4.6).
  **Change 2 (always-materialized fan-out): `/design-check` DONE 2026-08-05** — implementable,
  retirement-clean, red test pinned (`it.fails` in `tests/audit/semantic-review-step.test.ts`);
  record in the review doc. The mandate-wording tension (capability-neutral text vs
  `CP-BLOCK-IMPL-mandatory-independent-critic`) is gate-resolved to the lane-class-conditional
  form by standing conviction — owner may override before implementation. **Immediate next:**
  implement change 2 under the record's 8 binding constraints.
- **Dogfood self-audit COMPLETED 2026-08-05** (run `20260805T031732854Z_audit_tasks_completed_001`
  on `fa06d358`): 2,179 findings / 169 work blocks promoted to `.audit-tools/audit-report.md` +
  `audit-findings.json`; full lens set + deep conceptual review; bulk dispatch rode free lanes
  (relay pools + codex; agy unusable for write-tasks). Friction close-out: 19 observations on
  `.audit-tools/audit/friction/run.json`; run story + defect leads in
  [`reviews/dogfood-run-2026-08-05.md`](reviews/dogfood-run-2026-08-05.md) and 8 new
  `open-bugs.md` entries. **Immediate next:** consume the report — `/remediate-code` against
  `.audit-tools/audit-findings.json` (mind the open CP-NODE remediation state below before
  starting a second remediation stream).
- **CP-NODE-4 is RECOVERED (2026-08-04):** the retained worktree's 776-line diff landed on main as
  three attested cuts — checked graph arithmetic (`9ba747f2`), dedupe id-discipline/provenance +
  single-block ownership (`2ce641f7`), findings-report membership authority (`e3098789`) — with the
  duplicate-id refusal resolved as a declared `idDiscipline` policy axis (audit's packet-local draw
  vs remediate's global draw) and the routing predicate split from strict validity
  (`claimsAuditFindingsContract`). The worktree is removed. The remediation backend still says
  `implementing` with CP-NODE-1/2/3/5–10 pending; continuation order (CP-NODE-7+1, then 2+3, then
  the graph-lead boundary) lives in
  [`graph-derived-findings-remediation-process-review-2026-08-03.md`](reviews/graph-derived-findings-remediation-process-review-2026-08-03.md).
- **2026-07-30 defect clusters worked (2026-08-04, `b284bc7a`/`d57480b0`):** JIT/deepening
  partitioning under the planner's soft target (mega-packet head-of-line block gone, shrink trigger
  exists), graceful resumable pause on `maxTransitions`, stderr causes in error packet_results,
  refusals name `sources-declared.json`, host-path dead-worker result salvage, promotion identity
  check. The rest of the cluster is live-run watch — see the merged ▶ entry in `open-bugs.md`.
- Dispatch inversion is implemented and its cross-suite fallout is repaired (2026-08-04): provider
  confirmation/Gate-0, confirmed ordering, dispatch bias, and proxy catalog/populate discovery are
  retired; `llm-relay` owns concrete provider/model routing through `pool/fast` / `pool/coding` /
  `pool/reasoning` at `http://127.0.0.1:8791/v1`.
- The Codex handshake identifies `self.provider: codex`; an unidentified host falls back to
  `worker-command`, never Claude. Two defects from that neutral identity were found and fixed:
  pool CLASS (host vs engine-drivable source) is now construction-time data out of
  `buildConfirmedPools` (never re-derived from the provider name, which the worker-command host
  identity collides with), and a bare worker-command primary no longer folds into a source pool
  (no launch contract ⇒ dead capacity the engine drove into silent per-node failures).
- Local enforcement remains: packet/context fit (unknown context cap now refuses rather than
  fits), capability floors, quota/headroom, concurrency, result validation, and mechanical
  self-spawn exclusion.
- The nightly inbox is EMPTY: sol-1 (triage-lane fixes, `391c743d`) and sol-3 (git-evidenced
  premise probes, `3750a943`) were approved in chat 2026-08-04, executed, and recorded
  answered+completed in the decisions ledger. One relay-side defect remains OUTSIDE this repo:
  `pool/coding` does not fail over past a rate-limited first candidate — file against llm-relay.
- Whole-codebase simplification sweep landed (2026-08-04, three commits `0796a359`/`0dbd3e61`/
  `46f8081e`, shipped as v0.35.1): per-item outcomes and the verified-decline list live in
  [`codebase-simplification-review-2026-08-04.md`](reviews/codebase-simplification-review-2026-08-04.md).
  Includes the executed 2026-07-18 gemini sunset and the new `OrchestratorDescriptor` (one declared
  per-orchestrator delta object; provider shims + hostLimits twins collapsed). New defect logged:
  a dedup survivor can belong to multiple blocks (`blockIdsByFinding` now pins first-wins;
  root question in `open-bugs.md`).

## Verification state

- Full `npm test` green at the closeout run (7,410 passed, 10 skipped, 0 failed — see the final
  sprint verify). Two tests were deliberately inverted this sprint, both to retire pinned defect
  behaviour: the N5b context-only packing assertion and the multi-block remap fixup test.
- The pause/terminal persisted-state XOR inconsistency is recorded in `docs/backlog/open-bugs.md`.

## Immediate next

1. Run the next dogfood audit under the inverted dispatch — it is the designated re-test for every
   remaining live-run-watch property in the merged ▶ cluster entry (`open-bugs.md`).
2. Continue the remediation plan from the backend (CP-NODE-7 + CP-NODE-1 next, per the 2026-08-03
   review record's continuation order); the run state is still `implementing` with 9 nodes pending.

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

- ▶ Dogfood/meta-review 2026-07-30 cluster — remaining live-run-watch properties. · [`open-bugs.md`](backlog/open-bugs.md)

<!-- END GENERATED ROADMAP -->
