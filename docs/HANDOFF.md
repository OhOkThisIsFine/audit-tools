# HANDOFF — audit-tools

> **Audience:** the next agent instantiation (no memory of the session that produced this).
> **The single rolling handoff** — keep using *this* file; trim it as state changes, don't spawn
> per-topic handoffs. **Immediate next steps only** — durable concepts live in `CLAUDE.md`, the
> program of record in `docs/backlog.md`, history in git/memory. Do NOT turn this back into a changelog.

---

## Where things stand

- **`main`: B2+B3 DONE (unpublished).** Contract-pipeline staleness is now content/semantics-aware and
  re-reviews are diff-based. Two commits on `main` after the published A3:
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
  - **Parity follow-up (NOT done):** audit-code's design-review passes re-run as full passes on staleness
    too — port B2's diff-based-re-review + a finalized-style structural projection to audit-code. Logged
    in backlog under the B-track item.
  - **Publish:** unpublished. Ship via `/ship` when Ethan asks or the next milestone lands.

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

**START-HERE next session — A3 + B2 + B3 are done. Pick the next program item.**
A3 is shipped (`auditor-lambda 0.27.2`); B2+B3 are landed on `main` (unpublished, see *Where things stand*).
Candidate next: the **B2 audit-code parity port** (diff-based re-review + finalized-style structural
projection for audit-code's design-review passes — small, closes the cross-orchestrator gap B2/B3 opened),
or jump to **A6**.

**Next program items (suggested order, yours to change):** **B2 audit-code parity port** (above) →
**A6** (kill schema dual-encoding; drop dead-imported `ajv`; also
fold the minor `OUTCOME_KEYS` re-list noted in the plan doc) → **A8(a)** (audit-code symmetric rolling wiring
— its dormant `runRollingDispatch`; audit dispatch is read-only review packets → AuditResult, NOT worktree
edits, so it needs a provider-backed packet dispatcher + routing) → **A12** (single-package collapse — LAST)
→ **A7** (host machinery across hosts). Deferred: A2, A9/A10. Full specs + recon: `docs/backlog.md` →
"Accepted go-forward program".

### A8 remaining loose ends
- **REMAINING — audit-code symmetric wiring (= A8(a) above)** — `runRollingDispatch` is still dormant (0 live
  callers), the mirror of remediate's. Wire it into the audit live path with the same flag-gated pattern.
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
