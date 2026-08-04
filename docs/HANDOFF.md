# HANDOFF — audit-tools

> Immediate state and next action only. Durable design lives in `CLAUDE.md` and `spec/`;
> open work lives in `docs/backlog/`.

## Live state

- **Plan-only remediation handoff (2026-08-03):** the repository-local run is intentionally paused at
  `CP-NODE-4`. The backend state still says `implementing`, but all worker processes were stopped and
  the unmerged worktree was retained at
  `.audit-tools/worktrees/remediate-CP-BLOCK-CP-NODE-4-audit-tools-approved-audit-remediation`.
  The durable rationale and continuation plan live in
  [`graph-derived-findings-remediation-process-review-2026-08-03.md`](reviews/graph-derived-findings-remediation-process-review-2026-08-03.md).
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
- The over-swept `.audit-tools/nightly/` deletions were restored: five nightly items are still
  OPEN and unanswered in `docs/nightly-inbox.md` (P5 triage-lane-429 and P7 probe-absence among
  them); their proposals and `open-items.json` are back so the SessionStart surface works.
- Whole-codebase simplification sweep landed (2026-08-04, three commits `0796a359`/`0dbd3e61`/
  `46f8081e`, shipped as v0.35.1): per-item outcomes and the verified-decline list live in
  [`codebase-simplification-review-2026-08-04.md`](reviews/codebase-simplification-review-2026-08-04.md).
  Includes the executed 2026-07-18 gemini sunset and the new `OrchestratorDescriptor` (one declared
  per-orchestrator delta object; provider shims + hostLimits twins collapsed). New defect logged:
  a dedup survivor can belong to multiple blocks (`blockIdsByFinding` now pins first-wins;
  root question in `open-bugs.md`).

## Verification state

- Full `npm test` is green post-sweep (7,386 tests passed, 10 skipped, 0 failed). `npm run check`,
  `check:tests`, `check:deadcode`, `check:guard-reach`, doc-manifest, and both packaged smokes pass.
- CP-NODE-4 is not accepted: its retained worktree has six modified files, a 776-line diff, and a
  failing duplicate-ID dedupe test. No CP-NODE-4 change was merged into the primary checkout.
- The pause/terminal persisted-state XOR inconsistency is recorded in `docs/backlog/open-bugs.md`.

## Immediate next

1. Recover the intentionally paused CP-NODE-4 worktree using the linked review record; reconcile
   primary-checkout WIP before accepting or redispatching anything.
2. Owner: answer the five open nightly items in `docs/nightly-inbox.md` (check a box per item).

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
> `verify:checks` and at commit). 2 pinned item(s).

### ▶ Next up — pinned in the backlog

- ▶ Meta-review run 2026-07-30b — root causes + two new loop defects. · [`open-bugs.md`](backlog/open-bugs.md)
- ▶ Dogfood 2026-07-30 defect cluster — seven live dispatch/loop defects. · [`open-bugs.md`](backlog/open-bugs.md)

<!-- END GENERATED ROADMAP -->
