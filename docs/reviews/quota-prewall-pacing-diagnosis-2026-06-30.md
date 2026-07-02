# Quota pre-wall pacing — root-cause diagnosis (2026-06-30)

## Symptom
During the audit-full-sweep remediation, the rolling implement phase fanned out 4 concurrent
node-worker subagents; 3 of 4 died mid-run with `You've hit your session limit · resets 1:50pm`
(account-wide rolling cap). The quota subsystem did not pace/pause before the wall.

## What is NOT the problem (falsified)
- **Not credential darkness.** Live probe of `ClaudeOAuthQuotaSource` (`claude-code/*`) in the same
  environment returns `status: ok`, `remaining_pct: 0.6`, `reset_at` set. The proactive endpoint
  (`GET api.anthropic.com/api/oauth/usage`) is reachable and the CLI credential resolves.
- **Not missing modeling.** The 5-hr window does not need separate modeling: `mapUsageToSnapshot`
  already picks the *binding* (highest-utilization) window across `limits[]` + top-level windows, so
  `remaining_pct` is the most-constraining window's remaining fraction.
- **Not missing wiring.** `buildHostPoolPreamble` (`src/remediate/steps/dispatch.ts:296`) builds a
  `quotaSource` with the proactive Claude OAuth source by default; `buildConfirmedPools` feeds it to
  the rolling driver's pool sizing.

## Root cause
`applyQuotaSourceAdjustment` (`src/shared/quota/scheduler.ts:345`) consumes `remaining_pct` only as
two cliff bands:

- `remaining_pct < 0.1` (CRITICAL) → wave size 1 + cooldown to reset
- `remaining_pct < 0.3` (LOW) → halve the wave
- `remaining_pct >= 0.3` → **no adjustment**

At 0.6 remaining the scheduler applies the full host concurrency (4). Four concurrent, long-running
workers then consume the remaining binding-window budget in parallel and all hit the wall together.
The proactive signal is read but never translated into "how many concurrent workers can this
remaining budget safely sustain" — parallelism multiplies burn rate, and that is invisible to a
static band check.

## The three real gaps (backlog → Open bugs, 2026-06-30)
1. **Remaining budget not divided across K concurrent workers.** A `remaining_pct` band that fires
   only below 0.3 lets a partially-consumed window be fanned into at full width. Concurrency must
   taper with remaining budget *above* the 0.3 cliff, well before exhaustion — K should be a function
   of remaining_pct (and the reset horizon), not a two-step cliff.
2. **No pre-dispatch "K workers vs remaining budget" check.** The decision is per-pool band-throttle;
   it never asks whether spawning K workers will exhaust the binding window before they finish.
3. **Quota death is not a retryable pause.** A worker that walls mid-edit is indistinguishable from a
   real failure: its worktree holds partial/no edits and no result file. A session-limit death should
   be a pause-until-`reset_at` + preserve-worktree + re-dispatch, not a node failure.

## What the /usage endpoint actually exposes (verified raw, 2026-06-30)
Dumped the raw body on a subscription account. The only live signal is **percent-utilization per
window** — there is NO absolute token/request/dollar budget:

- `five_hour: {utilization:41, resets_at, limit_dollars:null, used_dollars:null, remaining_dollars:null}`
- `seven_day: {utilization:14, …dollars null}`
- `limits: [{kind:"session", percent:41, severity:"normal", is_active:true, resets_at}, {kind:"weekly_all", percent:14, is_active:false}]`
- `spend: {used:{amount_minor:0}, limit:{amount_minor:5000}, enabled:false}` (credit/API path, disabled here)

So "percent is all we get" is a **data limit**, not a faulty mapper. A real *token-budget* gate must
relate our own token consumption to percent consumed — i.e. LEARN tokens-per-percent from observed
Δutilization vs tokens-dispatched (persist in quota-state). Underused richer fields: per-limit
`severity` (escalates near the cap) and `is_active` (marks the binding window directly).

## Corrected concurrency model (the owner, 2026-06-30)
Concurrency is limited by ONLY two things — everything else in the scheduler is invented and must be
stripped:
1. **IDE/provider subagent allowance** — a hard ceiling ONLY when the host actually reports one
   (`hostConcurrencyLimit`). Most IDEs report none → no ceiling from here.
2. **Token budget** — real provider RPM/TPM when discovered, PLUS the window-budget gate: estimated
   tokens of in-flight + next task must fit within remaining budget (remaining_pct × learned
   tokens_per_pct), reserving headroom to `reset_at`.

**Strip (the "nonsense" caps):** the `first_contact` floor (~3/8, `scheduler.ts:500`), the `fallback`
`unknown_*_concurrency` caps (`scheduler.ts:486`), and the `applyQuotaSourceAdjustment` 0.1/0.3 cliffs.
Atomic-replace each with the budget gate.

**Cold start (no learned tokens_per_pct yet):** calibrate, don't invent a cap — dispatch a small first
batch, observe Δutilization to seed tokens_per_pct, then widen. A measurement bootstrap, not a fixed
ceiling.

## Quota death = retryable pause (gap 3)
A detected session-limit worker death pauses until `reset_at`, preserves the worktree
(`quarantineUncommittedWorktreeEdits`), and re-dispatches — never a node failure.

## Verification anchor
- Live probe: `new ClaudeOAuthQuotaSource().probeUsage("claude-code/*")` → `{status:"ok",
  remaining_pct:0.6, reset_at:"2026-07-01T01:59:59Z"}`.
- Band logic: `src/shared/quota/scheduler.ts:325-371`.
</content>
</invoke>
