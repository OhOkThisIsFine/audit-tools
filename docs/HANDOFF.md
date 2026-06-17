# HANDOFF — audit-tools

> **Audience:** the next agent instantiation (no memory of the session that produced this).
> **The single rolling handoff** — keep using *this* file; trim it as state changes, don't spawn
> per-topic handoffs. **Immediate next steps only** — durable concepts live in `CLAUDE.md`, the
> program of record in `docs/backlog.md`, history in git/memory. Do NOT turn this back into a changelog.

---

## Where things stand

- **`main`: latest = rolling_engine default-ON flip `8819713` (+ docs on top; `git log` for HEAD).**
  This sprint landed, green at every commit: the **`openai-compatible` provider** `f74c53c` (+ control-plane
  guard `2613c7c`), the **in-process provider engine wired into `decideNextStep`** `d108e90`, and the
  **`rolling_engine` default-ON flip + fixture sweep** `8819713`. Clean tree, build+check green, all three
  suites green (shared 702 / audit 2192·1skip / remediate 1622·1skip). **NOT published — publish HELD per
  Ethan (2026-06-17).** Last published: `@audit-tools/shared 0.22.0` / `auditor-lambda 0.27.0` /
  `remediator-lambda 0.27.0` (global bins current to that — they DON'T yet have this sprint's work).

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

## Immediate next: the go-forward program (A8 remediate side is done)

Order is yours. Suggested: **A1** fast path → **A3+A4** unify the two obligation engines + canonical
`RemediationItem` (the big foundational refactor) → **B1** magic numbers → **B2+B3** diff re-reviews +
obligation-set staleness → **B4** hard-exclude tool-refuted findings → **B8** finding-merge discriminator →
**A5+A11** dependency policy + vetted manifest parsers → **A6** kill schema dual-encoding → **A12**
single-package collapse (do LAST — it reorganizes packaging) → **A7** validate host machinery across hosts.
Deferred: A2, A9/A10. Full specs + recon: `docs/backlog.md` → "Accepted go-forward program".

### A8 remaining loose ends (smaller; fold in opportunistically)
- **audit-code symmetric wiring** — audit-code's `runRollingDispatch` is still dormant (0 live callers),
  the mirror of what was just done for remediate. Wire it into the audit live path with the same flag-gated
  pattern. (Cutover plan step 5.)
- **NIM as the real 2nd pool for INV-QD-14 cross-pool spill (a-residual).** The provider now EXISTS, so a
  real second pool is finally buildable. Remaining: surface `openai-compatible` as a *confirmed pool* in
  `buildConfirmedPools` / provider-confirmation (it's config-gated, NOT PATH-probed, so `discoverProviders`
  doesn't surface it today) so the proactive spill (`selectProvider`) can fire end-to-end alongside the
  Claude pool. Ties to FINDING-020 / "dispatch to CLI/API agents as additional pools".
- **Worktree walks up to the parent repo when run in a non-git dir (latent bug).** Surfaced in the flip's
  test sweep: the host-subagent rolling path runs `git worktree add` and, with no git repo at the target
  root, git walks UP and pollutes the parent repo (`C:\Code\audit-tools`) with leaked `remediate-*`
  branches/worktrees. Real targets are always git repos, but the rolling path should assert the worktree's
  git root == the intended repo root (or refuse) rather than escape. Logged in backlog.
- **Harden worktree-branch reuse across a `rate_limited` re-queue** in the in-process driver (cutover plan
  step 6).

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
