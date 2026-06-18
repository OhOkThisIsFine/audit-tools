# HANDOFF — audit-tools

> **Audience:** the next agent instantiation (no memory of the session that produced this).
> **The single rolling handoff** — keep using *this* file; trim it as state changes, don't spawn
> per-topic handoffs. **Immediate next steps only** — durable concepts live in `CLAUDE.md`, the
> program of record in `docs/backlog.md`, history in git/memory. Do NOT turn this back into a changelog.

---

## Where things stand

- **`main` (pushed + PUBLISHED): the go-forward program keeps accumulating.** Effective code tip =
  **A3 step 4 slice 2a — fold the dispatch switch into an executor-runner map** `0886d06` (the tree of the
  revert commit `0903a000` is byte-identical to it). **A full slice 2b+2c attempt landed then was REVERTED**
  (`0903a000`) — it broke on Linux CI only; see the ⚠️ block in "Immediate next" and branch `slice-2b-wip`.
  Earlier this was **shipped 2026-06-18** (release-bump commits `dd0e296`/`06ed90e`/`8224c8e`). Green at every
  commit; suites green on the committed tree (shared **726** / audit **2193** / remediate **1671**, +1 skip each).
  **PUBLISHED 2026-06-18 — publish hold lifted for Ethan's cross-machine usage:** `@audit-tools/shared 0.22.1`
  / `auditor-lambda 0.27.1` / `remediator-lambda 0.27.1` — all three CI-green on npm (runs 27731143814 /
  27731177158 / 27731386835); global bins reinstalled + postinstall run + `--version` smoke green.
  - This session (`git log` for detail) — **A3 step 4, RESCOPED mid-session to "C"** (unify audit's fold onto
    shared `advance` — see Immediate next): (1) remediate orphaned-helper + dead-import/param sweep `33f568f`;
    (2) parity-check doc `6bfae53`; (3) **slice 1** — visited-state-signature cycle detection in shared `advance`
    `68d2c17b`; (4) **slice 2a** — audit `switch` → `EXECUTOR_RUNNERS` map `0886d06`. Prior sessions (A3 step 3
    remediate rewire, DONE): `719e276`/`838a0ae`/`ae0326c`/`79e2dcd`/`8250aab`; A4 `6fea584`; A1 `b47d189`;
    A5+A11 `e3561c6`.
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

**A3 (the keystone) — step 3 (remediate rewire) DONE; step 4 RESCOPED to "C" and IN PROGRESS (slices 1+2a done).**
Working plan: **read [`docs/a3-a4-engine-unification-plan.md`](a3-a4-engine-unification-plan.md)** — the "C
decomposition", "Cycle-guard resolution", and "decisive finding" sections are the ground truth for step 4.

**The rescope (why step 4 grew from "small reconcile" to the real keystone):** recon this session found audit
**already folds** its deterministic executor chain into one host round-trip via `runDeterministicForNextStep`
(`src/cli/nextStepHelpers.ts:590`) — a *hand-rolled `advance`* (`continue`≡transition, `return`≡emit,
`maxRuns`≡maxTransitions, + bespoke no-progress / finalization-cycle guards). That parallel fold mechanism IS the
genuine non-parity A3 must erase (Ethan steered here: "isn't roundtrip-avoidance a concern for the auditor too?").
So audit adopts shared `advance` — NOT the earlier-considered "emit-only ceremony" framing, which was premised on
the false belief that audit doesn't fold.

**Done this session:** orphaned-helper sweep `33f568f`; parity-check doc `6bfae53`; **slice 1** `68d2c17b`
(shared `advance` gains opt-in `opts.stateSignature` → visited-state-signature cycle detection returning a
graceful `AdvanceResult.stopped:"cycle"`, subsuming audit's two hand guards; non-monotonic-deepening safe;
remediate untouched — return type is a superset); **slice 2a** `0886d06` (audit dispatch `switch` →
`EXECUTOR_RUNNERS` map in new `executorRunners.ts`; **absence of a runner** = the no-progress handoff for
`agent`/`rolling_dispatch_executor`; `AdvanceAuditOptions/Result` → leaf `advanceTypes.ts` for the madge acyclic
guard; switch⇄registry invariant test → runner-map coverage invariant).

> **⚠️ ATTEMPT 1 FAILED + WAS REVERTED (read before retrying).** A full slice 2b+2c landed on `main`, then was
> reverted (`0903a000`) because it broke on **Linux CI only**. The work is preserved on branch
> **`slice-2b-wip`** (`5df1c6e`…`87f5d76e`). main is back to the CI-green published-0.27.1 tree.
> - **Symptom:** on a fresh Linux env the FIRST next-step folds straight to `blocked` instead of `confirm_intent`
>   (`audit-code-completion` + `audit-code-wrapper`: "unexpected step kind 'blocked' (iteration 1)").
> - **Root cause:** the rewrite collapsed the hand loop's **TWO** cycle guards into ONE 0-tolerance visited-set
>   (`nextStepStateSignature` = `artifact-sig|obligation|executor`). The old guards were *looser*:
>   `checkNoProgressBeforeDispatch` only stops on a recurring **real** signature and **explicitly skips
>   `no-metadata`** states; `checkFinalizationCycle` tolerates **16** content-signature revisits before declaring
>   a cycle. The 0-tolerance collapse false-trips on the fresh-Linux early chain.
> - **The trap:** all 2191 local Windows tests passed AND a careful diff review passed — only the **release CI
>   (Linux) caught it**. So the re-attempt's #1 job is a **regression test that reproduces the Linux failure
>   locally** (env-dependent → likely the analyzer cache `~/.audit-tools/analyzer-cache` and/or CRLF/path
>   content makes Windows artifact signatures artificially distinct where Linux's collide). Without that test,
>   any fix is unverifiable from a Windows box except via slow CI round-trips.
> - **The fix direction:** the audit cycle detection must FAITHFULLY preserve both old behaviours — (a) never
>   cycle-stop on `no-metadata` bootstrap states, and (b) a tolerance (≈16) for content-signature revisits — OR
>   keep the old two-guard structure and only swap the *loop* onto `advance`. Compare `nextStepStateSignature`
>   on `slice-2b-wip` against `checkNoProgressBeforeDispatch`/`checkFinalizationCycle` at `abd4a111`.

**START-HERE next session — A3 step 4 slice 2b (re-attempt; the audit fold rewire).** Replace
`runDeterministicForNextStep`'s `for`-loop with shared `advance`: audit obligations become `ObligationDef`s
(`derive` = lookup into `deriveAuditState`'s precomputed obligation states; `execute` = call the **slice-2a
runner** → `transition` for deterministic, `emit` for host-delegation/dispatch/terminal). **Cycle detection is
the landmine (see the ⚠️ above)** — preserve the old no-metadata-skip + tolerance-16 semantics and land a
Linux-reproducing test FIRST. Retire `checkNoProgressBeforeDispatch` + `checkFinalizationCycle` + `maxRuns`;
`preferredExecutor`/integrity-check become a preamble (like remediate's `forceReplan`). The typed host-step
branches (`handleGraphEnrichmentBranch` / `handleDesignReviewBranch` / `handleSynthesisNarrativeBranch` /
`ensureSemanticReviewRun`) relocate into the obligations' `emit` payloads. Atomic replace: hand-loop → `advance`.
The audit `node:test` suite (2193) is the equivalence oracle. Then **slice 2c** (reconcile + the dead-`description`
decision below). After 2c, A3 is done → B2+B3.

**OPEN Q for Ethan (non-blocking):** the `description` field on `EXECUTOR_REGISTRY` is read nowhere (dead as
*behaviour*) but is human-readable per-executor documentation. Keep as inline docs, or delete? Retained for now;
decide in slice 2c.

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
