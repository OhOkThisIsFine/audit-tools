# HANDOFF — audit-tools

> **Audience:** the next agent instantiation (no memory of the session that produced this).
> **The single rolling handoff** — keep using *this* file; trim it as state changes, don't spawn
> per-topic handoffs. **Immediate next steps only** — durable concepts live in `CLAUDE.md`, the
> program of record in `docs/backlog.md`, history in git/memory. Do NOT turn this back into a changelog.

---

## Where things stand

- **`main` (pushed, NOT published): the go-forward program keeps accumulating.** Latest =
  **A3 step 1 (shared obligation scan) + A4 dead-type cleanup** `ee3431e` (this session). Green at every
  commit; suites green on the committed tree (shared **712** / audit ~2200 / remediate **1640**, +1
  documented skip each). **Publish HELD per Ethan (2026-06-17)** — last published:
  `@audit-tools/shared 0.22.0` / `auditor-lambda 0.27.0` / `remediator-lambda 0.27.0` (global bins lag).
  - Prior runs (`git log` for detail): A1 lean fast path `b47d189`; A5+A11 vetted TOML/YAML parsers
    `e3561c6`; B1 anchor-timeout config; B4 quarantine-exclude refuted findings; B8 (fileless collapse
    correct-by-design); A8 loose ends ×3.
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

**A3+A4 IN PROGRESS this session** — the obligation-engine unification. Recon + design landed first:
**read [`docs/a3-a4-engine-unification-plan.md`](a3-a4-engine-unification-plan.md)** — it is the working
plan (ground-truth map of both engines, the shared-engine contract, the honest A4 re-scoping, and the
green-at-every-commit decomposition). Two commits landed: **(1)** `4a041d0` extracted audit-code's
obligation-selection scan into `@audit-tools/shared` (`findFirstActionableObligation` + the
`Obligation`/`ObligationState` vocabulary); audit binds `PRIORITY` to it, `AuditObligation`/`ObligationState`
alias/re-export it (atomic replace, surface unchanged; +7 shared unit tests). **(2)** `ee3431e` deleted the
dead `TestSpec` type (first A4 cleanup).

**Recon corrected two backlog framings (durable — in the plan doc):** (a) the two engines are structurally
divergent — audit = stateless staleness-scan / emit-only / one-unit-per-call; remediate = persisted state
machine with back-edges + internal recursion — so the shared engine needs a transition/emit `advance` loop,
**deferred to the remediate rewire so it's proven by its real consumer** (not built consumer-less). (b)
**A4's "8 types + 2 ledgers → 1" is over-specced:** `RemediationItemState` already IS the canonical hub,
`TestSpec` was dead (deleted), `VerificationResult`/`TriageBatch` are thin transients, and
`CoverageLedgerEntry`/`RemediationOutcomeItem` are genuinely distinct domains. Real A4 = formalize the hub +
fold the transients + single-source the disposition vocab; the `RemediationItemState`→`RemediationItem`
rename is likely NOT worth the ~10-file churn (the name is already accurate) — skip unless a concrete reason.

**START-HERE next session — two clean entry points (decomposition in the plan doc):**
- **A4 finish (self-contained):** fold `VerificationResult`/`TriageBatch` into derived views (read
  `phases/triage.ts`); single-source the disposition vocab (`coverage/findingLedger.ts` `statusToDisposition`
  ↔ `CoverageLedgerEntry.disposition` / `PerFindingDisposition`).
- **A3 bulk (multi-session):** rewire remediate's `decideNextStepLoop` (`steps/nextStep.ts:3051-3329`) onto
  the shared engine — design + add the `advance` transition/emit loop there (proven by remediate), then
  re-express the guard cascade as a declarative obligation list, in atomic green chunks (linear pre-intake
  gates first, then the implementing/triage back-edge cluster). The handlers become the executors.

**After A3+A4 (suggested order, yours to change):** **B2+B3** (diff re-reviews + obligation-set staleness —
build on the unified engine) → **A6** (kill schema dual-encoding; drop dead-imported `ajv`) → **A8(a)**
(audit-code symmetric rolling wiring — its dormant `runRollingDispatch`; audit dispatch is read-only review
packets → AuditResult, NOT worktree edits, so it needs a provider-backed packet dispatcher + routing) →
**A12** (single-package collapse — LAST) → **A7** (host machinery across hosts). Deferred: A2, A9/A10. Full
specs + recon: `docs/backlog.md` → "Accepted go-forward program".

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
