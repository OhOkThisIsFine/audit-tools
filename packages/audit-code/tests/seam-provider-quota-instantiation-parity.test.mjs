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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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

// ── 8. Provider classes are single-sourced in shared (drift-plan E4) ─────────
//
// The claude-code / opencode provider classes live in @audit-tools/shared. Each
// orchestrator's per-package provider module may bind options + re-export, but
// must NOT define a provider class body of its own — that is exactly the
// accidental-drift surface E4 removed. These guards fail if a class body
// (re)appears in either orchestrator's provider file.

function readProviderSource(relFromSeamTest) {
  const url = new URL(relFromSeamTest, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf8");
}

/**
 * Strip block (slash-star) and line (double-slash) comments so prose like
 * "no provider class body of its own" does not trip the class-declaration scan.
 * Coarse but sufficient for these small, string-literal-free provider shims.
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const PER_ORCHESTRATOR_PROVIDER_FILES = [
  "../src/providers/claudeCodeProvider.ts",
  "../src/providers/opencodeProvider.ts",
  "../../../packages/remediate-code/src/providers/claudeCodeProvider.ts",
  "../../../packages/remediate-code/src/providers/opencodeProvider.ts",
];

test("no per-orchestrator provider class body: orchestrator provider files declare no FreshSessionProvider class", () => {
  for (const rel of PER_ORCHESTRATOR_PROVIDER_FILES) {
    const source = stripComments(readProviderSource(rel));
    // A re-export (`export { ClaudeCodeProvider } from "@audit-tools/shared"`)
    // is allowed; a class *declaration* is not. Match `class <Name>` definitions.
    assert.ok(
      !/\bclass\s+\w+/.test(source),
      `${rel} must not declare a provider class — the class is single-sourced in @audit-tools/shared (drift-plan E4)`,
    );
    // It must also not re-implement FreshSessionProvider locally.
    assert.ok(
      !/implements\s+FreshSessionProvider/.test(source),
      `${rel} must not implement FreshSessionProvider locally (drift-plan E4)`,
    );
    // It must construct/bind the shared class (factory injection), so the shared
    // import has to be present.
    assert.ok(
      source.includes("@audit-tools/shared"),
      `${rel} must source its provider class from @audit-tools/shared`,
    );
  }
});

test("provider class single-source: both orchestrators' ClaudeCodeProvider is the SAME shared class identity", async () => {
  const sharedShared = await import("@audit-tools/shared");
  const auditClaude = await import("../src/providers/claudeCodeProvider.ts");
  const remediateClaude = await import(
    new URL(
      "../../../packages/remediate-code/src/providers/claudeCodeProvider.ts",
      import.meta.url,
    )
  );
  assert.strictEqual(
    auditClaude.ClaudeCodeProvider,
    sharedShared.ClaudeCodeProvider,
    "audit-code ClaudeCodeProvider must be the shared class, not a re-implementation",
  );
  assert.strictEqual(
    remediateClaude.ClaudeCodeProvider,
    sharedShared.ClaudeCodeProvider,
    "remediate-code ClaudeCodeProvider must be the shared class, not a re-implementation",
  );
});

test("per-orchestrator delta is ONLY the claude-code skip-permissions default", async () => {
  // The intended divergence between the two orchestrators is exactly the
  // skip-permissions default (audit: off, remediate: on). Both deliver the
  // prompt via stdin and emit diagnostics. We verify the default by launching
  // each orchestrator's bound provider with a config that does NOT set
  // dangerously_skip_permissions and inspecting the resulting argv.
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const auditClaude = await import("../src/providers/claudeCodeProvider.ts");
  const remediateClaude = await import(
    new URL(
      "../../../packages/remediate-code/src/providers/claudeCodeProvider.ts",
      import.meta.url,
    )
  );

  async function argvFor(createProvider) {
    const dir = await mkdtemp(join(tmpdir(), "seam-skipperm-"));
    try {
      const promptPath = join(dir, "prompt.md");
      const taskPath = join(dir, "task.json");
      await writeFile(promptPath, "prompt body", "utf8");
      await writeFile(taskPath, JSON.stringify({ worker_command: ["claude"] }), "utf8");
      const calls = [];
      const provider = createProvider(
        {},
        async (command, args, launchInput) => {
          calls.push({ command, args, launchInput });
          return { accepted: true, exitCode: 0 };
        },
      );
      const input = {
        repoRoot: dir,
        runId: "seam-run",
        obligationId: null,
        promptPath,
        taskPath,
        resultPath: join(dir, "result.json"),
        stdoutPath: join(dir, "out.log"),
        stderrPath: join(dir, "err.log"),
        uiMode: "headless",
        timeoutMs: 5000,
      };
      const saved = process.env.CLAUDECODE;
      delete process.env.CLAUDECODE;
      try {
        await provider.launch(input);
      } finally {
        if (saved !== undefined) process.env.CLAUDECODE = saved;
      }
      return calls[0];
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  const auditCall = await argvFor(auditClaude.createClaudeCodeProvider);
  const remediateCall = await argvFor(remediateClaude.createClaudeCodeProvider);

  // audit-code default: permissions NOT skipped.
  assert.ok(
    !auditCall.args.includes("--dangerously-skip-permissions"),
    "audit-code claude-code must NOT skip permissions by default",
  );
  // remediate-code default: permissions skipped (unattended).
  assert.ok(
    remediateCall.args.includes("--dangerously-skip-permissions"),
    "remediate-code claude-code MUST skip permissions by default",
  );
  // Shared behavior: both deliver the prompt via stdin (not as an argv value).
  assert.equal(auditCall.launchInput.stdinText, "prompt body");
  assert.equal(remediateCall.launchInput.stdinText, "prompt body");
  assert.ok(!auditCall.args.includes("prompt body"));
  assert.ok(!remediateCall.args.includes("prompt body"));
});

// ── 9. Provider-keyed factory: unknown key → generic fallback (drift-plan E5) ─

test("getErrorParserForProvider: unknown provider key falls back to the generic parser (both orchestrators)", () => {
  for (const [label, quota] of [["audit-code", auditQuota], ["remediate-code", remediateQuota]]) {
    const claude = quota.getErrorParserForProvider("claude-code");
    assert.equal(claude.name, "claude-code", `${label} must resolve claude-code parser`);
    const unknown = quota.getErrorParserForProvider("totally-unknown-provider");
    assert.equal(unknown.name, "generic", `${label} unknown key must fall back to generic parser`);
  }
});

test("getHeaderExtractorForProvider: unknown provider key falls back to the generic extractor (audit-only axis)", async () => {
  // The header AXIS is intentionally audit-only; we only verify the unknown-key
  // fallback contract of its provider-keyed factory here.
  const { getHeaderExtractorForProvider } = await import(
    "../src/quota/headerExtractors/index.ts"
  );
  assert.equal(getHeaderExtractorForProvider("claude-code").name, "claude-code");
  assert.equal(getHeaderExtractorForProvider("totally-unknown").name, "generic");
});
