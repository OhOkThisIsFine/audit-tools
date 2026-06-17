# HANDOFF — audit-tools

> **Audience:** the next agent instantiation (no memory of the session that produced this).
> **The single rolling handoff** — keep using *this* file; trim it as state changes, don't spawn
> per-topic handoffs. **Immediate next steps only** — durable concepts live in `CLAUDE.md`, the
> program of record in `docs/backlog.md`, history in git/memory. Do NOT turn this back into a changelog.

---

## Where things stand

- **`main`: go-forward-program run landed 9 items (`git log` for HEAD; latest = A5+A11 `e3561c6`).**
  Green at every commit; all three suites verified green on the committed tree (shared 704 / audit ~2200 /
  remediate 1628, +1 documented skip each). This run, in order: worktree walk-up guard `9484e60`;
  **openai-compatible surfaced as a real 2nd pool** + per-slot dispatcher routing `f92ed1b`; rate_limited
  re-queue worktree+branch reset `8ba3722`; **B4 quarantine-exclude tool-REFUTED findings** `56e80bf`;
  shared auto-resolve flake guard `953bb51`; **B8 resolved** (fileless same-category collapse is
  correct-by-design — doc + guard) `0a8cf35`; **B1 anchor-timeout config + magic-numbers audit** `c81d4a3`;
  HANDOFF checkpoint `649fc8f`; **A5+A11 vetted TOML/YAML manifest parsers** (smol-toml + yaml; recovers
  dropped dependency-graph edges) `e3561c6`. **NOT published — publish HELD per Ethan (2026-06-17).** Last
  published: `@audit-tools/shared 0.22.0` / `auditor-lambda 0.27.0` / `remediator-lambda 0.27.0` (global bins
  lag this run's work).
  - **Verify true-green:** the shared `codex-antigravity-providers.test.mjs` auto-resolve flake is FIXED
    (`953bb51` — skips for ANY agent CLI on PATH). Remaining known flake: audit-code's `phase-plan.test.ts`
    intermittent hermeticity (backlog). CLAUDECODE must still be unset for gates. Note: A5+A11 added
    audit-code's first third-party runtime deps (`smol-toml`, `yaml`) — a fresh clone needs `npm install`.

- **A8 — the rolling cutover is effectively DONE for remediate.** Both rolling drivers on the shared
  `acceptNodeWorktree` core are validated end-to-end + are the DEFAULT now:
  - *host-subagent driver* (`dispatch_implement_rolling`): real-subagent smoke + false-resolve fix `f18138fe`.
  - *in-process provider driver* (`driveRollingImplementDispatch`): now WIRED into `decideNextStep` (routes
    here when `rolling_engine` ON + an EXPLICIT backend provider is set; precedence over host-subagent) and
    validated through the REAL next-step path over live NIM (`tests/nim-rolling-e2e.test.ts`, gated
    `RUN_NIM_E2E=1`): 2 nodes land via worktree→verify→merge, a verify-fail auto-retries (capped) then routes
    to triage (`blocked`) — never false-resolved.
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

## Immediate next: the go-forward program (DONE this run: A8 loose ends ×3, B1, B4, B8, A5+A11)

Order is yours. **Remaining, suggested order:** **A1** fast path → **A3+A4** unify the two obligation
engines + canonical `RemediationItem` (the big foundational refactor) → **B2+B3** diff re-reviews +
obligation-set staleness (do AFTER A3+A4 so they build on the unified engine) → **A6** kill schema
dual-encoding → **A8(a)** audit-code symmetric rolling wiring → **A12** single-package collapse (do LAST —
it reorganizes packaging) → **A7** validate host machinery across hosts. Deferred: A2, A9/A10. Full specs +
recon: `docs/backlog.md` → "Accepted go-forward program".

**Done this run (committed, green):** B1 (anchor-timeout config + full magic-numbers audit), B4
(quarantine-exclude refuted findings), B8 (resolved — collapse correct-by-design), A5+A11 (vetted TOML/YAML
parsers). A8 loose ends 3/4 done (below).

**START-HERE for the next session — A1 is the cheapest remaining win, but it's bigger than a gate tweak.**
`shouldEnterContractPipeline` always enters the pipeline and `handlePendingIntake` (`nextStep.ts:2097`)
routes BOTH ready-intake paths through it — there is NO lean fallback. A1 = a CONSERVATIVE gate (fast-path
only when ALL simplicity signals hold; default to the full pipeline on doubt) PLUS a real lean
plan→document→implement path the gate routes to (must still emit `extracted-plan.json` + run implement-phase
verify; only drops the adversarial critic→judge→repair). Full recon in `docs/backlog.md` → A1. A3+A4, A6,
A12, A7 are each large (multi-session); B2+B3 are coupled to A3+A4 (do after).

### A8 remaining loose ends
- **DONE:** worktree walk-up guard (`9484e60`); `openai-compatible` surfaced as a confirmed 2nd pool +
  per-slot dispatcher routing (`f92ed1b`); rate_limited re-queue worktree+branch reset (`8ba3722`).
- **REMAINING — audit-code symmetric wiring** — audit-code's `runRollingDispatch` is still dormant (0 live
  callers), the mirror of remediate's. Wire it into the audit live path with the same flag-gated pattern.
  (Cutover plan step 5. Note: audit dispatch is read-only review packets → AuditResult, NOT worktree edits,
  so it does NOT need the worktree engine — just a provider-backed packet dispatcher + routing.)
- **REMAINING — INV-QD-14 b-residual:** the {host-subagent (Claude) + NIM} HYBRID topology (host-subagent
  driver offloading spilled nodes to the in-process NIM pool) + a live cross-provider spill run. The
  in-process-driver spill path is now mechanically wired (see `f92ed1b`); the host-subagent hybrid is the
  larger FINDING-020 capstone.

## Pointers
- A8 working docs: [`docs/a8-rolling-cutover-plan.md`](a8-rolling-cutover-plan.md) (remaining = steps 5–6 +
  the walk-up bug; trim/delete once audit-code symmetric lands). The transient NIM-validation doc was folded
  here + into backlog and deleted.
- Review gate (orientation): Path A gates original findings at intake; Path B gates deduped/grounded node
  findings at planning (`runPlanningReviewGate`, fires when `review_decision.json` absent → plan_id
  `path-b-review`). Declined items → recorded terminal disposition, never silent close. Triage auto-retry is
  unconditional (capped 2/2). memory `review-gate-execution-status`.
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
  skipped in the normal suite. Re-validate the provider path anytime with
  `RUN_NIM_E2E=1 npx vitest run tests/nim-rolling-e2e.test.ts` from `packages/remediate-code`.
- Ship via the `/ship` skill when Ethan lifts the publish hold.
