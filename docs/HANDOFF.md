# HANDOFF — audit-tools

> **Audience:** the next agent instantiation (no memory of the session that produced this).
> **The single rolling handoff** — keep using *this* file; trim it as state changes, don't spawn
> per-topic handoffs. **Immediate next steps only** — durable concepts live in `CLAUDE.md`, the
> program of record in `docs/backlog.md`, history in git/memory. Do NOT turn this back into a changelog.

---

## Where things stand

- **A6 — zod single-source migration: ✓ DONE + SHIPPED 2026-06-18.** `@audit-tools/shared 0.22.2` /
  `auditor-lambda 0.27.3` / `remediator-lambda 0.27.2` live on npm (publish CI all green: shared
  `27789310915`, audit `27789365786`, remediate `27789706009`); merged to `main` (HEAD release commits
  `edb527d9`/`b6a77690`/`c992e0a8`), global bins reinstalled + postinstall run (audit-code 0.27.3,
  remediate-code 0.27.2). Every artifact contract is single-sourced as a zod schema (`z.infer`red types);
  the parallel JSON-schema encoding + hand validators are gone, so drift is structurally impossible.
  - **Publish trap hit (logged):** the audit-code packaged-smoke gate (`smoke-packaged-audit-code.mjs`
    `requiredPackagedPaths`) asserted the tarball ships a now-deleted schema (`audit-code-v1alpha1.schema.json`)
    → first publish failed the gate (no partial publish — gate is pre-bump). Fixed to point at a worker-5
    schema (`fix` commit `2cb208bf`). Lesson: when deleting a shipped file, grep the smoke/verify scripts for
    a hardcoded required-paths list.
  - **audit-code:** all internal JSON schemas DELETED except the 5 worker-facing ones (lens/finding/
    audit_task/audit_result/audit_results — GENERATED from zod by `scripts/generate-schemas.mjs`, drift-
    guarded by `worker-schema-generation.test.mjs`). Hand validator `tests/helpers/jsonSchemaAssert.mjs` +
    `auditSchemaRegistry.mjs` + self-tests (`json-schema-assert.test.mjs`, `seam-schema-validation-single-
    source.test.mjs`) DELETED. `schema-contracts.test.mjs` rewritten to `Schema.parse`/`safeParse`. New
    single sources: `src/contracts/wrapperResponse.ts` (CLI response envelope, was JSON-only), shared
    `AgentReflectionSchema`. Converted: quota leaf types, `DispatchQuota`, `StepArtifact`/`StepProgress`.
    Recovered bounds the prior conversion had dropped (`AuditUnitSchema` strict + `risk_score` 0..10).
    Rewired the 5 other validator-consuming tests (task-affinity-graph, grounding-surfacing, synthesis-
    narrative, audit-code-wrapper, host-bootstrap-descriptors) to their zod schemas.
  - **remediate:** `PUBLIC_CONTRACT_SCHEMA_COMPANIONS` hack REMOVED (it pointed at the deleted audit-code
    `audit_findings.schema.json`). All 18 JSON schemas + the structural `schema-contracts.test.ts` DELETED
    (verified none were runtime-read / worker-fetched / validated — contracts are enforced by the hand-coded
    TS validators in `src/validation/`). INV-remediate-tests-06 retired. Artifact-contract types converted to
    zod (RemediationPlan/Block, ItemSpec, ClarificationRequest, ClosingPlan/Preview). Never-validated
    internal-state types (RemediationItemState, coverage ledgers, the outcome family) LEFT as interfaces by
    design — inert to convert, no consumer (decision: Ethan, 2026-06-18).
  - **Verified green (CLAUDECODE unset):** shared build + full build + `npm run check` zero errors; audit
    suite 2136 pass / 1 skip; shared 726 pass / 1 skip; remediate 1607 pass / 1 skip.
  - **GOTCHAS (durable):** (1) `z.record(z.enum(...), v)` infers a **Partial** record → only safe where the
    field is write-only on the artifact (e.g. `DispatchQuota.tier_budgets`), else use `z.record(z.string(),
    v)`. (2) Several hand JSON schemas had bounds the TS types had loosened — recover them as the zod single
    source (`risk_score` 0..10, surface `exposure`∈{network,local}, graph `confidence`≤1, runtime
    `target_paths`≥1). (3) `Read` before `Edit`. (4) worker schemas generated `$refStrategy:"none"` (self-
    contained); the drift test enforces committed==generated. (5) Bash `cd` persists across calls → use
    absolute paths for Edit/Read after a `cd`.

- **`main`: B2 audit-code parity port DONE (unpublished, 2026-06-18).** Audit-code's design-review
  passes now do diff-based re-review on a semantic-projection staleness key — the cross-orchestrator
  gap B2/B3 opened is closed. Three commits on `main`:
  - **Shared refactor:** factored the generic B2/B3 machinery into `@audit-tools/shared/reReview/
    projectionDiff.ts` (`stableStringifyProjection`, `diffProjections`, `renderDiffReReviewSection`).
    Each orchestrator keeps its own *projection table*; the diff algorithm + prompt shape are
    single-sourced so the two halves stay in lockstep. remediate's `semanticProjection.ts` /
    `reviewSnapshot.ts` re-export the shared primitives (behavior-preserving).
  - **audit-code port:** `orchestrator/designReviewProjection.ts` (B3 — projects repo_manifest /
    unit_manifest / graph_bundle / surface_manifest / critical_flows / risk_register /
    design_assessment.findings to load-bearing fields, provenance+metrics stripped, collections
    canonically ordered) + `orchestrator/designReviewSnapshot.ts` (B2 — capture verdict+projections
    on pass completion; `isDesignReviewStale` / `computeDesignReReviewDelta` /
    `buildDesignReReviewSection`). `state.ts` keys `design_review_*_completed` on snapshot
    freshness (replacing the old unconditional flag carry-forward that *never* re-fired on real
    change → that was the actual gap). Snapshots load into the bundle (special-loaded like
    `active_dispatch`) so the sync `deriveAuditState` can check staleness. `handleDesignReviewBranch`
    captures snapshots on consume + treats a stale pass as needing re-run; `nextStepCommand` /
    `conceptualDispatch` append the re-review section (contract + shallow-conceptual prompts; the
    **deep-conceptual JUDGE** prompt — perspectives stay independent, the merge becomes diff-aware).
    Import-cycle avoided via a narrow local `DesignReviewBundle` interface (madge zero cycles).
  - **Tests:** `tests/design-review-diff-rereview.test.mjs` (13). **Verified green (CLAUDECODE unset):**
    shared build + `npm run check` zero errors; audit suite **2207** pass / 0 fail / 1 skip;
    remediate **1687** pass (shared refactor behavior-preserving).
  - **Publish:** unpublished. Ship via `/ship` when Ethan asks or the next milestone lands.

- **`main`: B2+B3 (remediate) DONE (unpublished).** Contract-pipeline staleness is content/semantics-
  aware and re-reviews are diff-based. Two earlier commits on `main` after the published A3:
  - **B3 (`f5cea40`):** `semanticProjection.ts` — staleness records/compares each dependency by the hash
    of its SEMANTIC projection (provenance fields stripped universally; finalized module-contract entries
    narrowed to the derivable fields `deriveObligationLedger` consumes), not raw payload bytes. Envelope
    gained `semantic_hash`; `dependency_hashes` + `detectStaleArtifacts` use it; `content_hash` stays
    raw-payload for judge/ledger repair-state identity. Cosmetic upstream edits (reworded rationale, fresh
    `created_at`, re-derived ledger) no longer re-stale the obligation-bearing chain.
  - **B2 (`f126be4`):** `reviewSnapshot.ts` — the four verdict-bearing review phases (critique /
    assessment / critic / judge) snapshot their verdict + the upstream semantic projections they reviewed
    (captured at ingest). A staleness re-emit appends the prior verdict + the changed-since-last-review
    delta and instructs re-affirm-or-revise-only-affected, so a re-review is diff-scoped, not a blind full
    re-run. Diff rides the same projection as B3 (cosmetic change → no delta → "re-affirm verbatim").
  - **Verified green (CLAUDECODE unset):** shared build + `npm run check` zero errors; remediate suite
    **1687** pass / 0 fail / 1 skip. New tests: `contract-pipeline-semantic-staleness.test.ts` (B3),
    `contract-pipeline-diff-review.test.ts` (B2). One obsolete `n-r07` assertion (perturbed only
    `created_at` to force a re-stale — the old raw-hash behavior) updated to perturb a load-bearing field.
  - **Parity follow-up:** DONE — see the B2 audit-code parity port above.

- **A3 IS DONE + PUBLISHED.** **A3 step 4 slice 2c DONE** (`819dda7`) — the final reconcile; both
  orchestrators now run the **same** shared `advance` fold engine. **Shipped 2026-06-18:** `auditor-lambda
  0.27.2` (slice 2b+2c, release commit `1067b27`, publish CI run `27774138156` green, live on npm latest);
  global bins reinstalled + postinstall host-assets redeployed (7/7). `@audit-tools/shared 0.22.1` /
  `remediator-lambda 0.27.1` correctly UNCHANGED (no src changes since their tags). `main` in sync with origin.
  - **Publish trap hit (logged to backlog):** the release script's `waitForRunCompletion` matched a STALE
    failed `audit-code-v0.27.2` publish run from the reverted ATTEMPT-1 era (0.27.2 was burned then reverted,
    so the version was reused) and reported a false failure — the NEW run actually succeeded. Verify the publish
    run's `databaseId`/start-time, not just the tag display name, when a version is reused after a revert.
  - **Slice 2c (this session, `819dda7`):** deleted the read-nowhere `description` field off
    `ExecutorDefinition` + all `EXECUTOR_REGISTRY` entries (`kind`/`obligation_ids` stay — they ARE read;
    `description` reached no user interaction: not the step prompt/contract, handoff, stderr, or report).
    Kept terse `//` notes on the non-obvious entries (legacy `agent`, the two empty-`obligation_ids`
    preferredExecutor-only runners). Stripped dead `maxRuns` params from the guard tests. Reconciled the plan
    doc (slices 2b/2c + cycle-guard section now describe landed approach B) + backlog. **Verified green
    (CLAUDECODE unset):** build + check zero errors; audit suite **2194** pass / 0 fail / 1 skip; orphan
    `dist/cli/runToCompletion.*` cleared by a local clean rebuild (gitignored, CI-clean regardless).
  - **Slice 2b (`0f3f203`, Linux-CI-green):** `runDeterministicForNextStep`'s hand `for`-loop → shared
    `advance` over audit `ObligationDef`s in `PRIORITY` order. **Approach B:** the two cycle guards
    (`checkNoProgressBeforeDispatch` + `checkFinalizationCycle`, tolerance `FINALIZATION_CYCLE_TOLERANCE`) stay
    in audit's `Ctx`; `advance` runs with NO `stateSignature` (its `maxTransitions` = pure runaway backstop); a
    per-transition counter feeds the guards as the old `index`. Retired `maxRuns`/`--max-runs`/`getMaxRuns`.
    ATTEMPT 1 (approach A: collapse both guards onto `advance.stateSignature`) broke Linux-CI-only and was
    reverted (`0903a000`, preserved on `slice-2b-wip`); `tests/linux-cycle-regression.test.mjs` reproduces it
    on any OS.
  - Prior session commits — slice 2a `0886d06`; slice 1 `68d2c17b`; orphan sweep `33f568f`; parity doc `6bfae53`.
    A3 step 3 (remediate rewire, DONE): `719e276`/`838a0ae`/`ae0326c`/`79e2dcd`/`8250aab`; A4 `6fea584`; A1
    `b47d189`; A5+A11 `e3561c6`.
  - True-green caveats: CLAUDECODE must be unset for gates. Known flake: audit-code's `phase-plan.test.ts`
    intermittent hermeticity (backlog). audit-code's third-party runtime deps (`smol-toml`, `yaml`) — a
    fresh clone needs `npm install`.

- **A8 — the rolling cutover is effectively DONE for remediate.** Both rolling drivers on the shared
  `acceptNodeWorktree` core are validated end-to-end + are the DEFAULT now:
  - *host-subagent driver* (`dispatch_implement_rolling`): real-subagent smoke + false-resolve fix `f18138fe`.
  - *in-process provider driver* (`driveRollingImplementDispatch`): WIRED into `decideNextStep` (routes here
    when `rolling_engine` ON + an EXPLICIT backend provider is set; precedence over host-subagent) and
    validated through the REAL next-step path over live NIM (`tests/nim-rolling-e2e.test.ts`, gated
    `RUN_NIM_E2E=1`): 2 nodes land via worktree→verify→merge, a verify-fail auto-retries (capped) then routes
    to triage (`blocked`), never false-resolved.
  - The legacy host-fanned wave (`dispatch_implement`) is RETAINED as an explicit opt-OUT
    (`rolling_engine:false`), not deleted.

- **NIM as a real provider/pool.** `OpenAiCompatibleProvider` (`packages/shared/src/providers/`) is the
  `llm write` pattern as a provider: POST node prompt → OpenAI-compatible `/chat/completions` → apply
  `{files,result}` into the worktree → write result. Config-only, no hardcoded model; NIM is one instance
  (`openai_compatible:{base_url:"https://integrate.api.nvidia.com/v1", model:"openai/gpt-oss-120b",
  api_key_env:"NVIDIA_API_KEY"}`). `NVIDIA_API_KEY` is set in Ethan's env. codex+NIM is a DEAD END (codex
  0.140 dropped `wire_api=chat`; NIM's Responses API rejects codex's `namespace` tools) — don't retry it.

## Standing directives (Ethan) — read before deciding anything

- **Effort/complexity/refactor-size is NOT a cost.** Only the cleanest/most-robust *endpoint* matters; never
  defer or half-measure because something is big. The ONLY gate on pace is **correctness** — green at every
  commit, no broken/lossy intermediate states. (memory `prefer-ideal-code-no-backcompat`.)
- **Ask on genuine ambiguity; never defer merely because something is big.** Genuine Ethan-call + unclear
  preference → ASK (batch). (memory `ask-on-ambiguity-dont-defer-silently`.)
- **Order of program items is yours** — sequence so one refactor doesn't undo another.
- **Publish hold LIFTED + shipped 2026-06-18** (0.22.1 / 0.27.1 / 0.27.1, for Ethan's cross-machine usage).
  Resume accumulating on main; ship again via the `/ship` skill when the next milestone lands (e.g. slice 2b)
  or when Ethan asks.

## Immediate next: the go-forward program

**A3 (the keystone) is DONE** — step 3 (remediate rewire) + step 4 slices 1/2a/2b/2c all landed. Both
orchestrators run the same shared `advance` fold engine; the parallel hand-rolled fold that was the genuine
non-parity is erased. Working plan (now history-of-decision, still ground truth for *why*):
[`docs/a3-a4-engine-unification-plan.md`](a3-a4-engine-unification-plan.md).

**START-HERE next session — A3, B2/B3, the B2 audit-code parity port, and A6 are all DONE + SHIPPED.**
Pick the next program item. Tree is clean, `main` synced + published (shared 0.22.2 / audit 0.27.3 /
remediate 0.27.2).

**Next program items (suggested order, yours to change):**
~~**A6**~~ **DONE+SHIPPED** (zod single-source migration) → ~~**A8(a)**~~ **DONE** (audit-code symmetric
rolling wiring — see *A8 remaining loose ends* below) → **A12** (single-package collapse — LAST) →
**A7** (host machinery across hosts). Deferred: A2, A9/A10. Full specs + recon: `docs/backlog.md` →
"Accepted go-forward program".

### A8 remaining loose ends
- **A8(a) audit-code symmetric wiring — ✓ DONE (branch `a8a-audit-rolling-wiring`, merged with A6/A3 `main`).**
  `driveRollingAuditDispatch` + `makeAuditProviderPacketDispatcher` (`src/cli/rollingAuditDispatch.ts`) wire the
  in-process provider driver into the host-delegation obligation (`runHostDelegationObligation` in the
  A3-`advance` fold) with the SAME flag-gated pattern as remediate (`rolling_engine` ON + explicit in-process
  provider → drive in-process and `transition` so the fold re-derives; else `emit` the host-subagent dispatch
  step). **KEY DIFFERENCE from remediate:** audit dispatch is READ-ONLY review (packet → `AuditResult[]`), so
  there is NO per-node worktree / commit / cherry-pick — every worker launches against the real repo root and
  writes only its result file; the "merge" is the deterministic `mergeAndIngest` (extracted as a callable from
  `cmdMergeAndIngest`). Full strand → records the partial-completion terminal + skips ingestion; an all-error
  pass → `emit`s `blocked` via a no-progress guard. The in-process provider set is NARROWER than remediate's —
  `{openai-compatible, codex, opencode}` only (`local-subprocess` is audit's host-dispatch default → including it
  would hijack `dispatch_review`). Tests `tests/rolling-audit-dispatch.test.mjs` (7). **STILL TODO:** an audit
  NIM e2e (mirror of remediate's `nim-rolling-e2e`) for live-provider validation through next-step.
- **REMAINING — INV-QD-14 b-residual:** the {host-subagent (Claude) + NIM} HYBRID topology (host-subagent
  driver offloading spilled nodes to the in-process NIM pool) + a live cross-provider spill run. The
  in-process-driver spill path is mechanically wired (`f92ed1b`); the host-subagent hybrid is the larger
  FINDING-020 capstone.

## Pointers
- A8 working docs: [`docs/a8-rolling-cutover-plan.md`](a8-rolling-cutover-plan.md) (remaining = steps 5–6;
  trim/delete once audit-code symmetric lands).
- Review gate (orientation): Path A gates original findings at intake; Path B gates deduped/grounded node
  findings at planning (`runPlanningReviewGate`, fires when `review_decision.json` absent → plan_id
  `path-b-review`). Declined items → recorded terminal disposition, never silent close. Triage auto-retry is
  unconditional (capped 2/2). memory `review-gate-execution-status`. **A1 note:** the lean fast path slots in
  on Path A *after* `gate.approved` resolves, so it inherits the same approval + coverage semantics.
- Provider-hang trap (backlog "Deferred fixes"): provider-less env (CLAUDECODE unset, e.g. release gate)
  auto-resolves a CLI backend whose subprocess can hang; OpenCode uninstalled is the prime suspect. Pinning
  an explicit provider avoids the auto-resolve hang.

## Working constraints
- **Green at every commit:** `npm run build -w @audit-tools/shared && npm run build && npm run check` → zero
  errors (shared first). Commit hook enforces it.
- **Run remediate vitest FROM `packages/remediate-code`** (`Push-Location` there). From the repo root vitest
  globs shared's `node:test` `.mjs` files → a wall of false failures.
- **CLAUDECODE** is set in-session; UNSET it for true-green test runs (`$env:CLAUDECODE=$null`) — one shared
  provider test + audit-code's auto-resolve test fail with it set (documented env flakes, not regressions).
- **The NIM e2e is gated** behind `RUN_NIM_E2E=1` (+ `NVIDIA_API_KEY`); it hits the live endpoint, so it's
  skipped in the normal suite. Re-validate anytime with
  `RUN_NIM_E2E=1 npx vitest run tests/nim-rolling-e2e.test.ts` from `packages/remediate-code`.
- Ship via the `/ship` skill when Ethan lifts the publish hold.
