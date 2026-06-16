# HANDOFF — audit-tools

> **Audience:** the next agent instantiation (no memory of the session that produced this).
> **The single rolling handoff** — keep using *this* file; trim it as state changes, don't spawn
> per-topic handoffs. **Immediate next steps only** — durable concepts live in `CLAUDE.md`, the
> program of record in `docs/backlog.md`, history in git/memory. Do NOT turn this back into a changelog.

---

## Where things stand

- **`main` @ `c45d1b0f`.** Clean tree, all pushed. **NOT published** — this session's commits sit on main
  unreleased (mid-program; release when A8 lands + is validated). Last published: `@audit-tools/shared 0.22.0`
  / `auditor-lambda 0.27.0` / `remediator-lambda 0.27.0` (global bins + host assets on 4 hosts current to that).
- **This session's commits (all green):** `dc4d9c2` A8 step-1 (rolling engine made functional, default-OFF) ·
  `0fa13d3` codex provider made real · `5518f31` A8 reframe docs · `76604a3` everything-agnostic invariant ·
  `c45d1b0` quota-signal finding. Green at HEAD: shared 631/0, remediate 1610/0, build+check clean.
- **A8 was REFRAMED this session** → one shared rolling `acceptNode` core + two co-equal full-rolling drivers
  (in-conversation subagent dispatch is FIRST-CLASS). And **the proactive Claude quota signal was found.**
- **Deliberate intermediate state (NOT bugs):** the rolling engine is functional but **default-OFF** (host-fanned
  wave path intact, nothing broken); codex provider is real but its real agentic run is unvalidated (codex quota
  resets **Jun 19**); the `acceptNode` extraction + host-subagent driver + the `QuotaSource` are **designed, not
  yet built**. Program of record: `docs/backlog.md` → "Accepted go-forward program (2026-06-15 review)".

## Standing directives (Ethan) — read before deciding anything

- **Effort/complexity/refactor-size is NOT a cost.** Only the cleanest/most-efficient/most-robust *endpoint*
  matters. Never defer, stage-to-avoid-work, or pick a lighter half-measure because something is big or a
  large atomic change. The ONLY thing that gates pace is **correctness** — green at every commit, no
  broken/lossy intermediate states. (CLAUDE.md "Ideal code over compatibility"; memory
  `prefer-ideal-code-no-backcompat`.)
- **Ask on genuine ambiguity; never defer merely because something is big.** When a decision is genuinely
  Ethan's and his preference is unclear, ASK (batch the questions) — don't guess or silently defer. (memory
  `ask-on-ambiguity-dont-defer-silently`.)
- **Order of program items is yours** — sequence logically so one refactor doesn't undo another.

## Immediate next: (1) quota detection, THEN (2) the A8 host-subagent driver

Ethan's directive: **sort out quota detection before resuming the A8 build.** Read these FIRST —
[`docs/a8-rolling-cutover-plan.md`](a8-rolling-cutover-plan.md), memory
`conversation-first-subagent-dispatch-first-class`, memory `claude-oauth-usage-quota-endpoint`.

### 1. Quota detection — per-provider `QuotaSource` (everything-agnostic)
**The proactive Claude quota signal was FOUND this session** (full recipe in memory
`claude-oauth-usage-quota-endpoint`): `GET https://api.anthropic.com/api/oauth/usage` (Bearer
`claudeAiOauth.accessToken` from `~/.claude/.credentials.json`, header `anthropic-beta: oauth-2025-04-20`)
→ `five_hour` / `seven_day` / per-model `seven_day_opus|sonnet` each `{utilization%, resets_at}` +
`extra_usage`; companion `/api/oauth/profile` → `rate_limit_tier`. `utilization%`+`resets_at` = remaining
**without a hardcoded ceiling**; per-model = strength-aware routing; `extra_usage` = cost-awareness.
- **(quick first, needs Ethan's OK to touch the token)** a live confirmation GET on this machine to prove
  it end-to-end + see current utilization.
- Build a per-provider **`QuotaSource`** interface: Claude = the endpoint (cache ~30–60s; refresh token on
  401; degrade on schema change); codex = reactive parse of its dated *"usage limit… try again `<date>`"*
  stderr → `exhausted-until`; local = unbounded. Wire **utilization-driven spill across pools** +
  per-model/cost routing into the scheduler. **The binding constraint is quota+rate, NOT max-parallel-`N`**
  (some IDEs cap subagent count, many don't).
- **NEW (Ethan, this session): hunt the same robust-as-possible quota signal for EVERY other model source** —
  codex/OpenAI, gemini, opencode, antigravity, local LLM, other IDEs (Cursor has an org admin API). Mirror the
  Claude discovery: prefer a proactive endpoint > reactive dated-limit parse > consumption-estimate; document a
  per-provider QuotaSource matrix; robust-as-possible per source, graceful degrade. (Backlog: *Cross-IDE/provider
  quota detection*.)

### 2. THEN the A8 host-subagent full-rolling driver (the meaty build — start fresh)
Extract the shared **`acceptNode`** core (`acceptNodeWorktree` out of `dispatchNodeWithWorktree`) → add an
`accept-node --id X` per-completion callback command → a dispatch step that pre-creates eligible worktrees and
drives the host to spawn subagents + call `accept-node` as each finishes (dispatch-next-on-complete) → select
driver by availability. Protocol detail: plan doc "Host-subagent driver protocol." **Validate IN-SESSION** (the
host instance spawns real Task-subagents via the Agent tool — no quota). codex/provider-path real validation is
quota-blocked until **Jun 19**.

- Then the rest of the program: **A1** fast path, **A3+A4** unify obligation engines + `RemediationItem`,
  **B1** magic numbers, **B2+B3** diff re-reviews + obligation-set staleness, **B4** hard-exclude
  tool-refuted findings (re-scoped), **B8** finding-merge discriminator (re-scoped), **A5+A11**, **A6**,
  **A12**, **A7**. Deferred: A2, A9/A10.

**Review gate, as shipped (orientation):** Path A gates the ORIGINAL findings at intake (over the
filter-pass survivors); Path B gates the deduped/grounded node findings at the planning point
(`runPlanningReviewGate` in `nextStep.ts`, fires only when `review_decision.json` is absent → plan_id
`path-b-review`). Declined items become a recorded terminal disposition, never a silent close. The classic
impl-risk preview is gone. Triage auto-retry is now unconditional (capped), no longer keyed on the removed
preview ack. `classifyFindingRisk`/`FindingRiskTier` were KEPT (dispatch model-tier consumer, orthogonal to
the review surface).

**Provider-hang trap (logged in backlog "Deferred fixes"):** in a provider-less env (e.g. CLAUDECODE unset,
as in the release gate) `createFreshSessionProvider` auto-resolves a CLI backend whose subprocess hangs —
Ethan UNINSTALLED OpenCode, so `opencode run` auto-resolution is the prime suspect. It surfaced as a 30s
hang in `phase-plan.test.ts` under the release gate; that test was made hermetic (`b8c8c30a`, injects the
`extractFindings` seam), but the underlying auto-resolution hang is still OPEN — watch for it.

## Pointers
- Working doc for A8: [`docs/a8-rolling-cutover-plan.md`](a8-rolling-cutover-plan.md) (design + protocol +
  open items). Fold + delete it into here/backlog when A8 fully lands.
- Memory (this session): `conversation-first-subagent-dispatch-first-class`, `claude-oauth-usage-quota-endpoint`.
  Also: `review-gate-execution-status`, `prefer-ideal-code-no-backcompat`, `ask-on-ambiguity-dont-defer-silently`,
  `remediation-review-gate-must-be-tool-enforced`.
- **`MEMORY.md` is over its size limit** — a `consolidate-memory` pass is due (merge/trim verbose index lines);
  not blocking, but do it before adding many more entries.
- Review-gate artifacts (under `.audit-tools/remediation/`): `review_request.json` /
  `review_resolution.json` / `review_decision.json` / `review_filter_dispositions.json`.

## Working constraints
- **Green at every commit:** `npm run build -w @audit-tools/shared && npm run build && npm run check` →
  zero errors (shared first). The commit hook enforces it.
- **Run remediate vitest FROM `packages/remediate-code`** (`cd` there first). Running `vitest` from the repo
  root globs shared's `node:test` `.mjs` files and reports a wall of false failures — they are NOT real.
- **CLAUDECODE** is set in-session; UNSET only for release gates (`env -u CLAUDECODE …` via Bash).
- The async typecheck hook can false-alarm on stale `shared/dist` or a mid-edit snapshot — a central
  `npm run build -w @audit-tools/shared` + the commit gate are authoritative; re-run `check` yourself to confirm.
- Ship via the `/ship` skill (encodes the publish-flow traps). Don't park at the push/publish boundary.
