# Remediation Report — audit-full-sweep-20260630

Source: `.audit-tools/audit-report.md` (186 verified-real findings). Scope: **full sweep** (Ethan, 2026-06-30).

## Outcome

All 15 module work-nodes **resolved** and landed on `main`. Combined post-remediation tree is green:

- `npm run build` ✓ · `npm run check` ✓
- remediate (vitest): **2093 passed / 0 failed** (2 skipped)
- audit (node:test): **2487 passed / 0 failed**
- (true-green, `CLAUDECODE` unset)

## High-severity fixes (all 7)

- **Citation-grounding marker leak** (contractPipeline) — an ungrounded promoted `extracted-plan.json` is removed on grounding failure, so a later `next-step` can't complete the pipeline on hallucinated citations.
- **Stale INFRA_FILE_PATHS** (dispatch) — `isInfraModifyingBlock` matches the current `src/remediate/` layout again (was dead-false on every real edit).
- **Roster scalar-model dispatch** (shared quota) — every CapacityPool carries the model its quota key was derived from, fixed at the single pool-construction seam.
- **Skipped merge-to-base treated green** (close) — a skipped non-none close no longer deletes the (unrecoverable) artifact dir.
- **Destructive cleanup before flag validation** (audit CLI) — `--results`/`--batch-results` conflict throws before any stale-artifact deletion.
- **Stale `packages/remediate-code/` test fixtures** (tests) — re-pinned to `src/remediate/`.
- **Fragile `npx madge` circular-import test** (tests) — replaced with a deterministic in-process cycle detector.

## Behavioral + maintainability fixes

~33 behavioral bugs across correctness/security/data-integrity/reliability/config/observability (write-scope formatter scoping, cwd-vs-root grounding, reversed line-range schema, run-id path collision, dropped root route, canonical batch filter, self-spawn-blocked provider exclusion, …) plus the maintainability/test backlog (single-sourcing of fixtures/constants/contracts, god-module decompositions of `nextStep.ts` and `buildNextContractPipelineStep`, drift-sentinel replacement).

## Verify-before-fix (recorded, not acted on)

Workers adversarially verified each finding; several were false and correctly **not** "fixed": the document-vs-implement validator (no separate validator exists), an already-single-sourced `moduleSlug`, the opencode MCP-removal claim (calls are still live), and a cluster of ungrounded `audit-contracts-validation` sub-claims.

## Process note — why "combined reconciliation"

The contract pipeline decomposed source and its pinning tests into **separate** isolated-worktree nodes, and each node's verify ran the whole suite. That deadlocks: a source fix breaks a stale test owned by a different node, and neither passes in isolation. Per operator decision, the run was finalized by committing every node, cherry-picking all onto one integration branch (disjoint file partition → zero conflicts), and running the full suite once on the union. Two `tests/audit` tests needed updating to the new behavior during reconciliation. The underlying tooling gaps (quota-aware dispatch didn't prevent a 5-hour wall; per-node verify too broad; decomposition should co-locate a fix with its boundary test) are logged in `docs/backlog.md`.
