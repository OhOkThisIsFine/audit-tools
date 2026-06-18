# HANDOFF — audit-tools

> **Audience:** the next agent instantiation (no memory of the session that produced this).
> **The single rolling handoff** — keep using *this* file; trim it as state changes, don't spawn
> per-topic handoffs. **Immediate next steps only** — durable concepts live in `CLAUDE.md`, the
> program of record in `docs/backlog.md`, history in git/memory. Do NOT turn this back into a changelog.

---

## Where things stand

- **`main` (pushed, NOT published): the go-forward program keeps accumulating.** Latest =
  **A3 slice 2b — phase handlers return transition/emit, zero recursion** `838a0ae` (this session).
  Green at every commit; suites green on the committed tree (shared **722** / audit ~2200 / remediate
  **1671**, +1 documented skip each). **Publish HELD per Ethan (2026-06-17)** — last published:
  `@audit-tools/shared 0.22.0` / `auditor-lambda 0.27.0` / `remediator-lambda 0.27.0` (global bins lag).
  - This session (`git log` for detail): **A3 slice 2b — DONE, 2 commits** — handler-recursion unwind
    `719e276` (every phase handler returns a `RemediateOutcome`; `advance` drives every fold with zero
    recursion; boundary-case-1 reload teeth) + dead-param cleanup `838a0ae`. **A3 step 3 (remediate rewire) is
    now fully DONE** across slices 1/2a/2b. Prior sessions: shared `advance` loop `8250aab`; slice 1 `79e2dcd`;
    slice 2a `ae0326c`; A4 finish `6fea584`; A1 `b47d189`; A5+A11 `e3561c6`.
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
- **Publish is HELD** (2026-06-17) — accumulate on main; do not `release:*`/publish until Ethan says.

## Immediate next: the go-forward program

**A3 (the keystone) — step 3 (remediate rewire) DONE across slices 1/2a/2b; only step-4 reconcile remains.**
Working plan: **read [`docs/a3-a4-engine-unification-plan.md`](a3-a4-engine-unification-plan.md)** (ground-truth
map of both engines, the shared-engine contract, the green-at-every-commit decomposition; the Status section
has the full slice-by-slice landing log, the 3 resolved slice-2b boundary cases, and the confirm_resume
faithfulness finding).

**Done this session (A3 slice 2b — the keystone bulk):** every phase handler (`handlePlanning` /
`handleImplementing` / `handleAllTerminalTransition` / `handleClosing` / `buildImplementDispatchStep`) now
returns a `RemediateOutcome` (`transition` | `emit`); the shared `advance` loop drives every fold with **zero
recursion** (`719e276` core + `838a0ae` cleanup). `decideNextStepLoop` is preamble → `advance(pre-intake)` →
`countStep` → `advance(main)` with no recursive re-entry anywhere. `skipCount` + dead handler params dropped.
Boundary case 1 (`handleClosing` → `complete`) resolved by **emit `handleComplete(…, await store.loadState())`**
— the reload reproduces the original recursion exactly (fully-green close → dir deleted → `null` → randomRunId;
not-green → preserved → complete state → plan_id), teeth-locked by run_id assertions. **Faithfulness finding
(a fix, not a regression):** removing the recursion stopped `confirm_resume` from spuriously re-firing against a
freshly-built `implementing` state — restoring slice-1 entry-gate-freeze semantics; `confirm_resume` still fires
for a genuinely pre-existing in-progress run. One test (`next-step-review-gate` Path-A coverage) relied on the
spurious halt and now folds to dispatch (asserted).

**START-HERE next session — A3 step 4 (final reconcile, small) then B2+B3.** skipCount + dead params are already
dropped. Left for step 4: (1) a quick **orphaned-helper sweep** of `steps/nextStep.ts`; (2) **parity-check audit
vs remediate obligation shapes**; (3) the optional-but-ideal **audit-code adopts `advance` emit-only** —
audit is already on the shared `findFirstActionableObligation` scan, and `advance` with only-emit obligations is
a strict generalization, so wiring `advanceAudit`/`decideNextStep` (audit-code `src/orchestrator/`) onto
`advance` unifies the *mechanism* fully and completes the A3 north star ("one declarative engine both tools run
on"). It is a bounded change to a *different package* (audit-code) with its own `node:test` suite — treat as its
own slice. After step 4, A3 is done.

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
