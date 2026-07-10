# Why host self-quota monitoring "keeps disappearing" (2026-07-09)

## TL;DR

The Claude self-quota-monitoring code is **not being deleted** — git history shows
zero deletions of `claudeOAuthQuotaSource.ts` or `hostSessionQuotaSource.ts` ever;
both trace cleanly to their original feat commits and are wired into
`buildHostPoolPreamble`. What actually happens is that the whole subsystem is
**silently switched off** by three independent default-off / fail-silent paths, so
every run that doesn't explicitly arm it gets zero self-monitoring with no signal —
indistinguishable from "it got deleted again."

## Evidence (current `main`/tree)

- `src/shared/quota/claudeOAuthQuotaSource.ts` — proactive Claude `/usage` source
  (programmatic access to own remaining quota %). Present. History:
  `eb5289f6 feat(quota): proactive Claude subscription quota detection, wired into
  dispatch` → `e5a055a3 fix(quota): refresh Claude OAuth token instead of going dark
  on expiry` → account-keyed pools → token-budget gate. Never deleted.
- `src/shared/quota/hostSessionQuotaSource.ts` — reactive fixed-window source that
  models "You've hit your session limit · resets Xpm". Present. Never deleted.
- Both are constructed in live paths: `src/remediate/steps/nextStep.ts:1084/1877`,
  `src/remediate/steps/dispatch/waveScheduling.ts:225`, `src/audit/cli/dispatch/quotaPool.ts:146`,
  `src/audit/cli/dispatch.ts:305`. `claudeOAuth` is in the proactive list in
  `src/shared/quota/compositeQuotaSource.ts:126`.

## The three silent-disable paths

### 1. Default-off gating — the big one
`src/remediate/steps/dispatch/waveScheduling.ts` `scheduleWave` (~line 291):

```ts
const quota = (sessionConfig).quota;
if (!quota || quota.enabled === false) {
  // short-circuit: wave = hostLimit ?? DEFAULT_WAVE_SIZE (=5), RPM/TPM = null,
  // capacity_pools built WITHOUT any quota snapshot → optimistic infinite budget.
  // buildHostPoolPreamble / buildQuotaSource / the Claude /usage source are
  // NEVER reached.
}
```

`QuotaConfig.enabled` is opt-in (`src/shared/types/sessionConfig.ts:565` →
`interface QuotaConfig { enabled?: boolean; … }`). No code path writes
`quota.enabled = true` automatically — an empty session-config (`{}`, exactly what
the 2026-07-09 remediation run had) means **no `quota` block → the entire proactive
subsystem is short-circuited**, silently, with no log line. The wave ran at
`DEFAULT_WAVE_SIZE`/`cap=none`.

### 2. Proactive source goes dark silently
The existence of `e5a055a3 fix(quota): refresh Claude OAuth token instead of going
dark on expiry` documents the recurring failure: when `ClaudeOAuthQuotaSource` can't
resolve/refresh the OAuth credential it returns `null`, the composite falls through
to optimistic, and there is no throttle and no warning. (See project memory
`claude-quota-credential-resolution`.)

### 3. The host-subagent (Agent-tool) failure plane is invisible to the tool
`HostSessionQuotaSource` only records a wall from the **worker ERROR/STATUS channel**
via `recordLimit` (fed by the dispatcher). But when the conversational host fans out
via the `Agent` tool, those subagents share the host's session quota and their
"session limit" deaths are **harness-level API errors surfaced to the host**, not
worker-produced error lines the tool parses — they write no result file
("missing result → marking items blocked"). So `recordLimit` is never called and the
tool's session-wall detector never sees the wall it was built to catch. This is a
plane mismatch: the whole quota system assumes the TOOL dispatches and reads
worker channels; the Agent-tool fan-out fails to the harness instead.

## Net effect on the 2026-07-09 run

Empty session-config → path #1 fired (no quota block → naive wave, no self-monitoring)
AND path #3 (6 parallel Agent-tool workers' session-limit deaths never reached the
tool). Result: 6-wide fan-out on the shared Claude session budget, uncapped, 4 workers
killed at the session wall.

## Fix directions (choose per intent — not yet implemented)

1. **Fail loud, not silent.** When dispatch runs with quota disabled/absent OR the
   proactive source returns null, emit a visible one-line warning (and record it in
   the run ledger): "host self-quota monitoring is OFF (no quota config / source dark)
   — fan-out is unpaced." The single highest-leverage change; it turns every silent
   disappearance into an observable state.
2. **On-by-default for the conversational host.** Make the claude-code host path arm
   `quota.enabled` implicitly (query `/usage`, size the wave from remaining %) unless
   explicitly disabled, instead of requiring a `quota` block that nothing writes.
3. **Close the plane gap.** Give the host-subagent dispatch step a pre-spawn gate that
   consults the proactive `/usage` source before the host spawns the wave, and a
   contract for the host to feed Agent-tool subagent quota-deaths back into
   `recordLimit`. Today the handshake/dispatch-step contract requires neither.

The thing that "keeps disappearing" is not the code — it's the *arming* of it. Until
one of the fail-loud / on-by-default changes lands, the default experience is
correct-but-inert self-monitoring.
