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
  record in the review doc. **Change 2 IMPLEMENTED 2026-08-05** (single atomic replace, this
  commit): shared lane materializer (`fanoutLanes.ts` + `renderFanoutExecutionLines` +
  lane-class-conditional `renderIndependentReviewMandate` in `src/shared/prompts.ts`), all
  emitters converted (charter per-kind blind lanes with multi-lane kind-purity ingest;
  charter-delta/systemic/critical-flow/synthesis/edge lanes; `single_task_fallback` + inline
  `edge_reasoning` step kinds deleted), handshake-less hosts degrade to one-task-per-packet with
  a loud `unknown_host_window` warning (never refused). Verified: full suite green, 17-agent
  adversarial review (9 confirmed findings fixed or comment-hardened, 2 refuted by mechanism).
  **Change 3 (scope-confirmation context) SHIPPED 2026-08-05** (`91f5f375` design-check gate,
  `52d9b25c` implementation): lens-tagged design-assessment evidence overlays the heuristic lens
  dispositions (widens exclude→include only; empty/auto-completed is no-signal), and the new
  deterministic `docs_digest` artifact renders the repo's stated purpose into the confirm-intent
  prompt (`docs_digest_current` before the checkpoint; `intent_checkpoint.json` stays a DAG leaf).
  Gate + implementation records in the review doc; 4-lens/8-agent post-implementation review, 2
  findings fixed+pinned, full suite 7,412/0. **Change 4 (charter layer) IMPLEMENTED 2026-08-06**
  (owner go in chat, with the telos-as-reactable-opinion gloss): channel-pure estimator kinds
  stated/structural/revealed (schema migration `charter-register/v2`, DISCARD read policy),
  scope-by-feeding evidence packets (`charterPackets.ts`; comment grammar single-sourced in
  `commentDecomposition.ts`), teleology-first lane submissions joined by file-set overlap
  (decomposition = hint), delta miner = triangulation engine (triangulated telos + tool-counted
  disagreement density, rendered beside the clarification questions; True nominations at deepest
  only), vestigial checkpoint charter embeds deleted, new `graph_bundle.json` register edge +
  member-scoped slice. Design-check + implementation records in the review doc; 4-lens pre-commit
  adversarial review (5 findings, all 5 refuted by mechanism); full suite 7,438/0. Shipped as
  **v0.36.0** (`3fb84823` + `c58cb065`; release CI green, npm live, global bins reinstalled).
  **All four critique-cluster changes are now SHIPPED** — nothing remains from the cluster.
- **Dogfood self-audit COMPLETED 2026-08-06** (run `20260806T054657426Z_audit_tasks_completed_001`
  on `2b6ba83e`, v0.36.0, offload ON): **1,925 findings / 133 work blocks** promoted to
  `.audit-tools/audit-report.md` + `audit-findings.json` (9 critical / 125 high). First live
  exercise of charter-layer v2 (worked end-to-end; one stated-lane quarantine repaired) and the
  designated live-run-watch re-test — 5 of the 2026-08-05 minor-friction items **confirmed still
  live**. Post-run same-day (shipped **v0.36.1**): all 9 criticals adversarially verified — 0
  survived as critical (3 refuted, 6 downgraded → `open-bugs.md`) — and the run's 3 tool-side
  defect leads were FIXED (malformed-lane quarantine at the shared consume chokepoint, submit/merge
  boundary parity, friction-record archival + stop-gate marker agreement). All 8 nightly-inbox
  items were answered by the owner and EXECUTED (P8/P9/P11/P12 + 4 doc decisions; ledger has the
  landing refs). Run story + verification record in
  [`reviews/dogfood-run-2026-08-06.md`](reviews/dogfood-run-2026-08-06.md). The 2026-08-05 run
  story remains in [`reviews/dogfood-run-2026-08-05.md`](reviews/dogfood-run-2026-08-05.md).
- **Remediation run `dogfood-20260806-v0361` LANDED on main (2026-08-06, merge `3a17ca8c`):**
  211 items terminal (202 `verified_no_change` + 9 `resolved`), deliverables promoted. Pre-merge
  6-lane adversarial review + dedicated regression-hunt: 6 confirmed findings fixed (`ecec16bc`),
  including a `check:tests`-only type-RED across 4 test files — a FOURTH CP-NODE-26 accept
  regression, the type-level sibling of the three `860185ba` repaired (invisible to vitest and the
  commit gate; fatal in CI's `verify:checks`); 0 further accept-class regressions found. The run's
  5 new tool defects are the accept/reverify cluster in `open-bugs.md` (Immediate next §1);
  friction record: `.audit-tools/remediation/friction/run.json`.
- **CP-NODE-4 is RECOVERED (2026-08-04):** the retained worktree's 776-line diff landed on main as
  three attested cuts — checked graph arithmetic (`9ba747f2`), dedupe id-discipline/provenance +
  single-block ownership (`2ce641f7`), findings-report membership authority (`e3098789`) — with the
  duplicate-id refusal resolved as a declared `idDiscipline` policy axis (audit's packet-local draw
  vs remediate's global draw) and the routing predicate split from strict validity
  (`claimsAuditFindingsContract`). The worktree is removed. **The remediation backend state was
  DELETED 2026-08-06 on owner instruction** (fresh slate for the next dogfood) — the CP-NODE
  continuation is closed as a run; the unlanded node diffs still exist on the
  `remediate-CP-BLOCK-*` branches (1–8 commits each, deliberately NOT deleted), and the
  continuation order remains recorded in
  [`graph-derived-findings-remediation-process-review-2026-08-03.md`](reviews/graph-derived-findings-remediation-process-review-2026-08-03.md)
  if that work is ever resumed.
- **2026-07-30 defect clusters worked (2026-08-04, `b284bc7a`/`d57480b0`):** JIT/deepening
  partitioning under the planner's soft target (mega-packet head-of-line block gone, shrink trigger
  exists), graceful resumable pause on `maxTransitions`, stderr causes in error packet_results,
  refusals name `sources-declared.json`, host-path dead-worker result salvage, promotion identity
  check. The rest of the cluster is live-run watch — see the merged ▶ entry in `open-bugs.md`.
- Dispatch inversion is implemented and its cross-suite fallout is repaired (2026-08-04): provider
  confirmation/Gate-0, confirmed ordering, dispatch bias, and proxy catalog/populate discovery are
  retired; `llm-relay` owns concrete provider/model routing at `http://127.0.0.1:8791/v1` (its
  pool roster is llm-relay's to publish — never named here).
- The Codex handshake identifies `self.provider: codex`; an unidentified host falls back to
  `worker-command`, never Claude. Two defects from that neutral identity were found and fixed:
  pool CLASS (host vs engine-drivable source) is now construction-time data out of
  `buildConfirmedPools` (never re-derived from the provider name, which the worker-command host
  identity collides with), and a bare worker-command primary no longer folds into a source pool
  (no launch contract ⇒ dead capacity the engine drove into silent per-node failures).
- Local enforcement remains: packet/context fit (unknown context cap now refuses rather than
  fits), capability floors, quota/headroom, concurrency, result validation, and mechanical
  self-spawn exclusion.
- Nightly answers and their landing refs live in `.claude/nightly-decisions.json`; the open queue
  is `docs/nightly-inbox.md`. Item ids like `sol-1` are per-run and are reused across nights — the
  ledger's subject keys, not the ids, are what identify a decision.
- Whole-codebase simplification sweep landed (2026-08-04, three commits `0796a359`/`0dbd3e61`/
  `46f8081e`, shipped as v0.35.1): per-item outcomes and the verified-decline list live in
  [`codebase-simplification-review-2026-08-04.md`](reviews/codebase-simplification-review-2026-08-04.md).
  Includes the executed 2026-07-18 gemini sunset and the new `OrchestratorDescriptor` (one declared
  per-orchestrator delta object; provider shims + hostLimits twins collapsed). New defect logged:
  a dedup survivor can belong to multiple blocks (`blockIdsByFinding` now pins first-wins;
  root question in `open-bugs.md`).

## Verification state

- Full `npm test` green at the merge (7,492 passed / 0 failed on `ecec16bc`, the merged tree —
  byte-identical to `main` after `3a17ca8c`); `check` + `check:tests` both 0. **CI fully green on
  main at `1511f6b2`** (`ci` + `audit-code-test-suite`, 2026-08-07): the merge commit's `ci` run
  passed directly; the interim budget-ratchet red on `44ad9fdb` (docs-only) was condensed away in
  `1511f6b2`.
- The pause/terminal persisted-state XOR inconsistency is recorded in `docs/backlog/open-bugs.md`.

## Immediate next

1. **Ship the loop-core source fixes** for the accept/reverify cluster (TWELVE defects incl.
   the commit-before-cwd-check MAIN-dirt commit, the sticky merged:true outcome, the accept_failed
   re-report ledger, the accept guard leg skipping `check:tests`) + the zero-frontier null-guard
   (`src/remediate/steps/nextStep.ts:2372`) with
   regression tests and attestation — entry in `open-bugs.md` §Implement-dispatch accept/reverify
   defect cluster; run forensics in memory `remediation-run-2026-08-06-paused-midflight`.
   ⚠ Standing hazards until this ships: `session-config.json` at repo root (untracked,
   `block_quota: {context_tokens: 200000, reserved_output_tokens: 32000, host_model: claude-opus-5}`)
   is load-bearing — recreate if absent; the installed global dist carries a ONE-LINE HOTFIX
   (`nextStep.js` zero-frontier null-guard) — a global reinstall reverts it until the source fix
   ships.
2. Work the 2026-08-05 minor-friction cluster (still live, re-confirmed; now joined by the
   2026-08-06 handshake concurrency-cap collapse and block-sizing blindness entries) — specs in
   `open-bugs.md`.

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
