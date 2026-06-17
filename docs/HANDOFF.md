# HANDOFF — audit-tools

> **Audience:** the next agent instantiation (no memory of the session that produced this).
> **The single rolling handoff** — keep using *this* file; trim it as state changes, don't spawn
> per-topic handoffs. **Immediate next steps only** — durable concepts live in `CLAUDE.md`, the
> program of record in `docs/backlog.md`, history in git/memory. Do NOT turn this back into a changelog.

---

## Where things stand

- **`main` (pushed, NOT published): the go-forward program keeps accumulating.** Latest =
  **A4 finish — status/disposition vocabulary single-sourced** `6fea584` (this session). Green at every
  commit; suites green on the committed tree (shared **712** / audit ~2200 / remediate **1667**, +1
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

**A3+A4 IN PROGRESS — A4 is now DONE; A3 (the keystone) remains.** Working plan:
**read [`docs/a3-a4-engine-unification-plan.md`](a3-a4-engine-unification-plan.md)** (ground-truth map of
both engines, the shared-engine contract, the green-at-every-commit decomposition; steps 1+2 marked done).

**A4 DONE this session** (`ed6ad2a` / `6283a34` / `6fea584`): dead `VerificationResult` deleted +
`TriageBatch` localized to `triage.ts`; new `src/state/itemStatus.ts` is the single authority for the
`RemediationItem` status enum and every classification of it — the `statusToDisposition` /
`dispositionToOutcomeStatus` maps (exhaustive `Record<RemediationItemStatus,…>`) and the
`isTerminal`/`isVerifiedComplete`/`isSkip`/`isInProgress` predicates — retiring `OUTCOME_BY_STATUS`, the 3×
`isSkip`, and the 7× `resolved||resolved_no_change` open-codings across close/dispatch/nextStep/stepUtils.
The extracted enum is the formalized hub; the `RemediationItemState`→`RemediationItem` rename stays skipped
(name accurate). Recon resolution (in the plan doc): the two disposition *unions* (`PerFindingDisposition` =
terminal outcome; `CoverageLedgerEntry.disposition` = planning fate) are disjoint domains and were NOT
merged — only the status→vocab *mapping* was single-sourced. (Prior: A3 step 1 `4a041d0` single-sourced the
obligation scan in `@audit-tools/shared`; `TestSpec` deleted `ee3431e`. See `git log`.)

**START-HERE next session — A3 bulk (multi-session):** rewire remediate's `decideNextStepLoop`
(`steps/nextStep.ts:3051-3329`) onto the shared engine — design + ADD the `advance` transition/emit loop in
`@audit-tools/shared/src/engine/` THERE (proven by its real consumer remediate, not built consumer-less),
then re-express the guard cascade as a declarative obligation list running on `advance`, in atomic green
chunks (linear pre-intake gates first, then the implementing/triage back-edge cluster). The handlers become
the executors. A4's `itemStatus.ts` already gives the rewire a clean status vocabulary to read.

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
