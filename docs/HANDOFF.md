# HANDOFF — audit-tools

> **Audience:** the next agent instantiation (no memory of the session that produced this).
> **The single rolling handoff** — keep using *this* file; trim it as state changes, don't spawn
> per-topic handoffs. **Immediate next steps only** — durable concepts live in `CLAUDE.md`, the
> program of record in `docs/backlog.md`, history in git/memory. Do NOT turn this back into a changelog.

---

## Where things stand

- **`main` (PUBLISHED): the go-forward program keeps accumulating.** **A3 step 4 slice 2b is DONE (approach
  B)** on branch `a3-step4-slice2b-retry` (commit `0f3f203`, off `main`) — about to merge to `main` + push so
  Linux CI (`ci.yml` + `audit-code-test-suite.yml`, push-to-main only) validates the exact failure mode that
  reverted ATTEMPT 1. Effective published code tip = slice 2a `0886d06`; main local is 2 ahead of origin
  (`6a036ce` repro test + `a964976` handoff). Earlier **shipped 2026-06-18** (`dd0e296`/`06ed90e`/`8224c8e`):
  `@audit-tools/shared 0.22.1` / `auditor-lambda 0.27.1` / `remediator-lambda 0.27.1`, all CI-green on npm.
  - **Slice 2b (this session, `0f3f203`):** replaced `runDeterministicForNextStep`'s hand `for`-loop with the
    shared `advance` engine. Audit obligations → `ObligationDef`s in `PRIORITY` order (deterministic executors
    `transition`, host-delegation/dispatch/terminal `emit`). **Approach B:** the two cycle guards
    (`checkNoProgressBeforeDispatch` + `checkFinalizationCycle`, tolerance = named `FINALIZATION_CYCLE_TOLERANCE`)
    stay in audit's `Ctx`, invoked from inside the deterministic-executor obligation; `advance` runs with NO
    `stateSignature` (its `maxTransitions` = pure runaway backstop). A per-transition counter feeds the guards as
    the old `index`. Retired `maxRuns` / `--max-runs` / `getMaxRuns`. Disabled-narrative now RUNS the
    deterministic `status:omitted` omit (new `run_omit` branch action) instead of spinning. The three guard test
    files stay GREEN UNCHANGED (approach B keeps the guards — only the deleted-guard approach A had to rewrite
    them). **Verified:** `linux-cycle-regression` guard green; full audit suite **2194** pass / 0 fail / 1 skip;
    build + check green.
  - Prior session commits — slice 2a `0886d06`; slice 1 `68d2c17b`; orphan sweep `33f568f`; parity doc `6bfae53`.
    A3 step 3 (remediate rewire, DONE): `719e276`/`838a0ae`/`ae0326c`/`79e2dcd`/`8250aab`; A4 `6fea584`; A1
    `b47d189`; A5+A11 `e3561c6`. ATTEMPT-1 work preserved on branch `slice-2b-wip` (reverted `0903a000`).
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

**A3 (the keystone) — step 3 (remediate rewire) DONE; step 4 slices 1+2a+2b DONE; slice 2c is the immediate next.**
Working plan: **read [`docs/a3-a4-engine-unification-plan.md`](a3-a4-engine-unification-plan.md)** — the "C
decomposition", "Cycle-guard resolution", and "decisive finding" sections are the ground truth for step 4.

**Why step 4 is the real keystone:** audit **already folds** its deterministic executor chain into one host
round-trip — slice 2b just swapped that hand-rolled fold onto shared `advance`, erasing the parallel fold
mechanism that was the genuine non-parity A3 targets. Slice 2b is **landed + green** (see "Where things stand";
commit `0f3f203`, approach B). ATTEMPT 1 (approach A: collapse both guards onto `advance.stateSignature`) broke on
Linux-only and was reverted (`0903a000`, preserved on `slice-2b-wip`); approach B keeps the guards in audit's
`Ctx` and is locally Linux-repro-green via `tests/linux-cycle-regression.test.mjs`.

**START-HERE next session — push slice 2b for CI, then slice 2c.**
1. **Merge `a3-step4-slice2b-retry` → `main` + push** (if not already done) so `ci.yml` +
   `audit-code-test-suite.yml` run the suite on **Linux** — the signal that caught ATTEMPT 1. Watch both runs
   green before building 2c on top. The `linux-cycle-regression` guard reproduces the exact failure mode locally,
   so high confidence, but Linux CI is the real signal.
2. **Slice 2c — reconcile.** Sweep for anything left referring to the old hand `for`-loop / `maxRuns` framing
   (docs, comments, the plan doc). Confirm `runDeterministicForNextStep` is now purely the `advance`-driven
   coordinator. Then resolve the dead-`description` decision below. After 2c, A3 is done → B2+B3.

**OPEN Q for Ethan (slice 2c):** the `description` field on `EXECUTOR_REGISTRY`
([executors.ts](../packages/audit-code/src/orchestrator/executors.ts)) is read nowhere (dead as *behaviour*) but
is human-readable per-executor documentation. Keep as inline docs, or delete? Retained for now; decide in 2c.

**After A3 (suggested order, yours to change):** **B2+B3** (diff re-reviews + obligation-set staleness —
build on the unified engine) → **A6** (kill schema dual-encoding; drop dead-imported `ajv`; also fold the
minor `OUTCOME_KEYS` re-list noted in the plan doc) → **A8(a)** (audit-code symmetric rolling wiring — its
dormant `runRollingDispatch`; audit dispatch is read-only review packets → AuditResult, NOT worktree edits,
so it needs a provider-backed packet dispatcher + routing) → **A12** (single-package collapse — LAST) →
**A7** (host machinery across hosts). Deferred: A2, A9/A10. Full specs + recon: `docs/backlog.md` →
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
