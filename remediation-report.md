# Remediation Report

## Resolved — Changed Files

- **FINDING-001**: Provider resolution forces local-subprocess; active backend never detected
  - *Verification*: resolveFreshSessionProviderName now auto-detects when provider is omitted or defaulted to local-subprocess, while explicit local-subprocess still wins.
Added provider auto-resolution coverage for omitted/defaulted active CLAUDECODE and OPENCODE sessions.
Verification: npm test -w auditor-lambda passed (538 tests).
- **FINDING-002**: Canonical dispatch path never acquires live quota (central regression)
  - *Verification*: prepareDispatchArtifacts now accepts injected provider queryLimits, merges provider-reported limits ahead of cached discovered limits, builds a real-time quota source snapshot, and passes quotaSourceSnapshot into scheduleWave.
cmdPrepareDispatch and the semantic review dispatch path now construct the active provider/session config and pass queryLimits plus a best-effort hostModel into prepareDispatchArtifacts.
Verification: npm test -w auditor-lambda passed (538 tests).
- **FINDING-004**: Add a cascading quota-signal fallback chain
  - *Verification*: Added shared buildQuotaSource factory to centralize quota snapshot cascade ordering, and replaced inline legacy quota-source construction with the shared factory.
resolveLimits now uses providerName for a provider_default fallback rung before the generic default.
Verification: npm test -w @audit-tools/shared passed (28 tests); npm test -w auditor-lambda passed (538 tests).

## Closing Action

Action: none
Status: skipped

## Remediation Outcomes

Of 3 finding(s): 3 resolved, 0 verified already correct, 0 deemed inappropriate, 0 ignored, 0 blocked.

By lens:
- operability: resolved 1
- reliability: resolved 2
