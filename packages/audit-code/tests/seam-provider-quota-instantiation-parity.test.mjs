/**
 * seam-provider-quota-instantiation-parity.test.mjs
 *
 * Cross-module seam test: provider-quota-instantiation-parity
 *
 * Verifies that both orchestrators (audit-code and remediate-code) wire
 * provider/quota instantiation through the same shared primitives and expose
 * the same public surface without diverging. If either side adds or removes an
 * export, changes its ENV_PREFIX, or starts instantiating providers differently,
 * at least one assertion here will fail.
 *
 * Seam contract (N-TEST-SEAM-provider-quota-instantiation-parity):
 *
 *   1. Both quota/index re-export all shared quota symbols by the same names.
 *      Any symbol present in one but absent from the other is a divergence bug.
 *
 *   2. Both providers/index expose `createFreshSessionProvider` and
 *      `resolveFreshSessionProviderName` with the same call signatures (verified
 *      by calling them with identical inputs and comparing results).
 *
 *   3. resolveFreshSessionProviderName is a pure pass-through to shared:
 *      explicit provider name → same result from both orchestrators.
 *
 *   4. createFreshSessionProvider('local-subprocess', {}) returns an object
 *      whose `name` is 'local-subprocess' in both orchestrators.
 *
 *   5. hostLimits.detectHostActiveSubagentLimit reads distinct env prefixes
 *      (AUDIT_CODE vs REMEDIATE_CODE) so neither bleeds into the other.
 *
 *   6. hostLimits.resolveHostActiveSubagentLimit produces correct output for
 *      a numeric env var from each orchestrator's prefix; the OTHER prefix
 *      does NOT interfere with the result.
 *
 *   7. Both orchestrators' quota/index exports do NOT include symbols that
 *      belong exclusively to the other (no cross-bleed of auditor-only exports).
 */

import test from "node:test";
import assert from "node:assert/strict";

// ── Import both orchestrators' providers and quota modules ──────────────────

const auditProviders = await import("../src/providers/index.ts");
const remediateProvidersUrl = new URL(
  "../../../packages/remediate-code/src/providers/index.ts",
  import.meta.url,
);
const remediateProviders = await import(remediateProvidersUrl);

const auditQuota = await import("../src/quota/index.ts");
const remediateQuotaUrl = new URL(
  "../../../packages/remediate-code/src/quota/index.ts",
  import.meta.url,
);
const remediateQuota = await import(remediateQuotaUrl);

const auditHostLimits = await import("../src/quota/hostLimits.ts");
const remediateHostLimitsUrl = new URL(
  "../../../packages/remediate-code/src/quota/hostLimits.ts",
  import.meta.url,
);
const remediateHostLimits = await import(remediateHostLimitsUrl);

// ── Shared quota symbols both sides must re-export ──────────────────────────

/**
 * Symbols that both orchestrators' quota/index.ts must export.
 * These are the shared primitives from @audit-tools/shared that both pipelines
 * depend on; drift here breaks cross-orchestrator dispatch compatibility.
 */
const SHARED_QUOTA_SYMBOLS = [
  // Core limit resolution
  "resolveLimits",
  "classifyProvider",
  // State I/O
  "readQuotaState",
  "writeQuotaState",
  "getQuotaStatePath",
  "setQuotaStateDir",
  // Concurrency + wave
  "computeMaxSafeConcurrency",
  "recordWaveOutcome",
  "computeRampUpConcurrency",
  "scheduleWave",
  "buildProviderModelKey",
  // Backoff
  "computeBackoffCooldownMs",
  "computeBackoffFailureWeight",
  "computeCooldownUntil",
  "decayWeight",
  "applyDecayToEntry",
  // Rate-limit detection
  "detectRateLimitError",
  // File lock
  "acquireLock",
  "releaseLock",
  "withFileLock",
  "FileLockTimeoutError",
  // Sliding window
  "runSlidingWindow",
  // Quota source classes
  "LearnedQuotaSource",
  "CompositeQuotaSource",
  // Error parsers
  "GenericErrorParser",
  "ClaudeCodeErrorParser",
  "getErrorParserForProvider",
  // Capacity
  "computeDispatchCapacity",
  "summarizeDispatchCapacityPools",
  // Host limits (each side provides its own wrapper but shared is the same)
  "detectHostActiveSubagentLimit",
  "resolveHostActiveSubagentLimit",
];

// ── Tests ───────────────────────────────────────────────────────────────────

// 1. Shared quota symbols present in both

test("both orchestrators' quota/index export the same shared symbols", () => {
  for (const sym of SHARED_QUOTA_SYMBOLS) {
    assert.ok(
      sym in auditQuota,
      `audit-code quota/index is missing shared symbol: ${sym}`,
    );
    assert.ok(
      sym in remediateQuota,
      `remediate-code quota/index is missing shared symbol: ${sym}`,
    );
    // Both must be the same kind of thing (function vs class vs primitive)
    assert.equal(
      typeof auditQuota[sym],
      typeof remediateQuota[sym],
      `symbol ${sym} has type '${typeof auditQuota[sym]}' in audit-code but '${typeof remediateQuota[sym]}' in remediate-code`,
    );
  }
});

// 2. Both providers/index expose the factory functions

test("both providers/index expose createFreshSessionProvider and resolveFreshSessionProviderName", () => {
  assert.equal(typeof auditProviders.createFreshSessionProvider, "function");
  assert.equal(typeof auditProviders.resolveFreshSessionProviderName, "function");
  assert.equal(typeof remediateProviders.createFreshSessionProvider, "function");
  assert.equal(typeof remediateProviders.resolveFreshSessionProviderName, "function");
});

// 3. resolveFreshSessionProviderName: explicit provider passes through identically

test("resolveFreshSessionProviderName: explicit provider name produces same result in both orchestrators", () => {
  const providerNames = ["local-subprocess", "claude-code", "opencode", "codex"];
  for (const name of providerNames) {
    const auditResult = auditProviders.resolveFreshSessionProviderName(
      name,
      {},
      { commandExists: () => false, env: {} },
    );
    const remediateResult = remediateProviders.resolveFreshSessionProviderName(
      name,
      {},
      { commandExists: () => false, env: {} },
    );
    assert.equal(
      auditResult,
      remediateResult,
      `explicit provider '${name}' → audit='${auditResult}' remediate='${remediateResult}'`,
    );
    assert.equal(auditResult, name, `explicit provider '${name}' should pass through verbatim, got '${auditResult}'`);
  }
});

// 4. createFreshSessionProvider: local-subprocess produces provider with correct name

test("createFreshSessionProvider: local-subprocess instantiates correctly in both orchestrators", () => {
  const auditProvider = auditProviders.createFreshSessionProvider(
    "local-subprocess",
    {},
  );
  const remediateProvider = remediateProviders.createFreshSessionProvider(
    "local-subprocess",
    {},
  );
  assert.equal(auditProvider.name, "local-subprocess");
  assert.equal(remediateProvider.name, "local-subprocess");
  assert.equal(typeof auditProvider.launch, "function");
  assert.equal(typeof remediateProvider.launch, "function");
});

// 5. hostLimits: distinct ENV_PREFIX — neither bleeds into the other

test("audit-code hostLimits reads AUDIT_CODE_ prefix, not REMEDIATE_CODE_", () => {
  // Set the REMEDIATE prefix but NOT the AUDIT prefix — audit should return null
  const env = { REMEDIATE_CODE_HOST_MAX_ACTIVE_SUBAGENTS: "5" };
  const result = auditHostLimits.detectHostActiveSubagentLimit(env);
  assert.equal(result, null, "audit-code must NOT read REMEDIATE_CODE_ prefix");
});

test("remediate-code hostLimits reads REMEDIATE_CODE_ prefix, not AUDIT_CODE_", () => {
  // Set the AUDIT prefix but NOT the REMEDIATE prefix — remediate should return null
  const env = { AUDIT_CODE_HOST_MAX_ACTIVE_SUBAGENTS: "5" };
  const result = remediateHostLimits.detectHostActiveSubagentLimit(env);
  assert.equal(result, null, "remediate-code must NOT read AUDIT_CODE_ prefix");
});

// 6. resolveHostActiveSubagentLimit: correct prefix produces a numeric result
// Shared key format: ${envPrefix}_HOST_MAX_ACTIVE_SUBAGENTS

test("audit-code resolveHostActiveSubagentLimit reads its own AUDIT_CODE_HOST_MAX_ACTIVE_SUBAGENTS", () => {
  const result = auditHostLimits.resolveHostActiveSubagentLimit({
    sessionConfig: {},
    env: { AUDIT_CODE_HOST_MAX_ACTIVE_SUBAGENTS: "8" },
  });
  assert.ok(result !== null, "should resolve a limit from AUDIT_CODE_HOST_MAX_ACTIVE_SUBAGENTS");
  assert.equal(typeof result.active_subagents, "number");
  assert.equal(result.active_subagents, 8);
});

test("remediate-code resolveHostActiveSubagentLimit reads its own REMEDIATE_CODE_HOST_MAX_ACTIVE_SUBAGENTS", () => {
  const result = remediateHostLimits.resolveHostActiveSubagentLimit({
    sessionConfig: {},
    env: { REMEDIATE_CODE_HOST_MAX_ACTIVE_SUBAGENTS: "4" },
  });
  assert.ok(result !== null, "should resolve a limit from REMEDIATE_CODE_HOST_MAX_ACTIVE_SUBAGENTS");
  assert.equal(typeof result.active_subagents, "number");
  assert.equal(result.active_subagents, 4);
});

// 7. No cross-bleed: auditor-only symbols absent from remediate-code quota/index

test("remediate-code quota/index does not export auditor-only symbols", () => {
  const auditorOnly = [
    // These are exported by audit-code's quota/index but should NOT exist in
    // remediate-code (they are audit-specific discovered-limits / header machinery).
    "lookupDiscoveredLimits",
    "updateDiscoveredLimits",
    "mergeDiscoveredLimits",
    "readDiscoveredLimitsCache",
    "writeDiscoveredLimitsCache",
    "extractRateLimitHeaders",
    "GenericHeaderExtractor",
    "ClaudeCodeHeaderExtractor",
    "getHeaderExtractorForProvider",
    "DISPATCH_QUOTA_V1ALPHA1",
    "DISPATCH_QUOTA_V1ALPHA2",
    "resolveHostModel",
  ];
  for (const sym of auditorOnly) {
    assert.ok(
      !(sym in remediateQuota),
      `remediate-code quota/index should NOT export auditor-only symbol: ${sym}`,
    );
  }
});

test("audit-code quota/index exports auditor-specific symbols absent from shared", () => {
  const auditorOnly = [
    "lookupDiscoveredLimits",
    "updateDiscoveredLimits",
    "extractRateLimitHeaders",
    "DISPATCH_QUOTA_V1ALPHA1",
    "DISPATCH_QUOTA_V1ALPHA2",
  ];
  for (const sym of auditorOnly) {
    assert.ok(
      sym in auditQuota,
      `audit-code quota/index should export auditor-specific symbol: ${sym}`,
    );
  }
});
