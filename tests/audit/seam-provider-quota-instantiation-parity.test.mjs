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
 *   4. createFreshSessionProvider('worker-command', {}) returns an object
 *      whose `name` is 'worker-command' in both orchestrators.
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

import { test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ── Import both orchestrators' providers and quota modules ──────────────────

const auditProviders = await import("../../src/audit/providers/index.ts");
const remediateProvidersUrl = new URL(
  "../../src/remediate/providers/index.ts",
  import.meta.url,
);
const remediateProviders = await import(remediateProvidersUrl);

const auditQuota = await import("../../src/audit/quota/index.ts");
const remediateQuotaUrl = new URL(
  "../../src/remediate/quota/index.ts",
  import.meta.url,
);
const remediateQuota = await import(remediateQuotaUrl);

const auditHostLimits = await import("../../src/audit/quota/hostLimits.ts");
const remediateHostLimitsUrl = new URL(
  "../../src/remediate/quota/hostLimits.ts",
  import.meta.url,
);
const remediateHostLimits = await import(remediateHostLimitsUrl);

// ── Shared quota symbols both sides must re-export ──────────────────────────

/**
 * Symbols that both orchestrators' quota/index.ts must export.
 * These are the shared primitives from audit-tools/shared that both pipelines
 * depend on; drift here breaks cross-orchestrator dispatch compatibility.
 */
const SHARED_QUOTA_SYMBOLS = [
  // Core limit resolution
  "resolveLimits",
  "classifyProvider",
  // State I/O
  "readQuotaState",
  "readQuotaStateOrDegrade",
  "writeQuotaState",
  "getQuotaStatePath",
  "setQuotaStateDir",
  // Wave (no learned concurrency cap — concurrency is declared or absent)
  "recordWaveOutcome",
  "scheduleWave",
  "buildProviderModelKey",
  // Backoff
  "computeBackoffCooldownMs",
  "computeCooldownUntil",
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
    expect(sym in auditQuota, `audit-code quota/index is missing shared symbol: ${sym}`).toBeTruthy();
    expect(sym in remediateQuota, `remediate-code quota/index is missing shared symbol: ${sym}`).toBeTruthy();
    // Both must be the same kind of thing (function vs class vs primitive)
    expect(typeof auditQuota[sym], `symbol ${sym} has type '${typeof auditQuota[sym]}' in audit-code but '${typeof remediateQuota[sym]}' in remediate-code`).toBe(typeof remediateQuota[sym]);
  }
});

// 2. Both providers/index expose the factory functions

test("both providers/index expose createFreshSessionProvider and resolveFreshSessionProviderName", () => {
  expect(typeof auditProviders.createFreshSessionProvider).toBe("function");
  expect(typeof auditProviders.resolveFreshSessionProviderName).toBe("function");
  expect(typeof remediateProviders.createFreshSessionProvider).toBe("function");
  expect(typeof remediateProviders.resolveFreshSessionProviderName).toBe("function");
});

// 3. resolveFreshSessionProviderName: explicit provider passes through identically

test("resolveFreshSessionProviderName: explicit provider name produces same result in both orchestrators", () => {
  const providerNames = ["worker-command", "claude-code", "opencode", "codex"];
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
    expect(auditResult, `explicit provider '${name}' → audit='${auditResult}' remediate='${remediateResult}'`).toBe(remediateResult);
    expect(auditResult, `explicit provider '${name}' should pass through verbatim, got '${auditResult}'`).toBe(name);
  }
});

// 4. createFreshSessionProvider: worker-command produces provider with correct name

test("createFreshSessionProvider: worker-command instantiates correctly in both orchestrators", () => {
  const auditProvider = auditProviders.createFreshSessionProvider(
    "worker-command",
    {},
  );
  const remediateProvider = remediateProviders.createFreshSessionProvider(
    "worker-command",
    {},
  );
  expect(auditProvider.name).toBe("worker-command");
  expect(remediateProvider.name).toBe("worker-command");
  expect(typeof auditProvider.launch).toBe("function");
  expect(typeof remediateProvider.launch).toBe("function");
});

// 5. hostLimits: distinct ENV_PREFIX — neither bleeds into the other

test("audit-code hostLimits reads AUDIT_CODE_ prefix, not REMEDIATE_CODE_", () => {
  // Set the REMEDIATE prefix but NOT the AUDIT prefix — audit should return null
  const env = { REMEDIATE_CODE_HOST_MAX_ACTIVE_SUBAGENTS: "5" };
  const result = auditHostLimits.detectHostActiveSubagentLimit(env);
  expect(result, "audit-code must NOT read REMEDIATE_CODE_ prefix").toBe(null);
});

test("remediate-code hostLimits reads REMEDIATE_CODE_ prefix, not AUDIT_CODE_", () => {
  // Set the AUDIT prefix but NOT the REMEDIATE prefix — remediate should return null
  const env = { AUDIT_CODE_HOST_MAX_ACTIVE_SUBAGENTS: "5" };
  const result = remediateHostLimits.detectHostActiveSubagentLimit(env);
  expect(result, "remediate-code must NOT read AUDIT_CODE_ prefix").toBe(null);
});

// 6. resolveHostActiveSubagentLimit: correct prefix produces a numeric result
// Shared key format: ${envPrefix}_HOST_MAX_ACTIVE_SUBAGENTS

test("audit-code resolveHostActiveSubagentLimit reads its own AUDIT_CODE_HOST_MAX_ACTIVE_SUBAGENTS", () => {
  const result = auditHostLimits.resolveHostActiveSubagentLimit({
    sessionConfig: {},
    env: { AUDIT_CODE_HOST_MAX_ACTIVE_SUBAGENTS: "8" },
  });
  expect(result !== null, "should resolve a limit from AUDIT_CODE_HOST_MAX_ACTIVE_SUBAGENTS").toBeTruthy();
  expect(typeof result.active_subagents).toBe("number");
  expect(result.active_subagents).toBe(8);
});

test("remediate-code resolveHostActiveSubagentLimit reads its own REMEDIATE_CODE_HOST_MAX_ACTIVE_SUBAGENTS", () => {
  const result = remediateHostLimits.resolveHostActiveSubagentLimit({
    sessionConfig: {},
    env: { REMEDIATE_CODE_HOST_MAX_ACTIVE_SUBAGENTS: "4" },
  });
  expect(result !== null, "should resolve a limit from REMEDIATE_CODE_HOST_MAX_ACTIVE_SUBAGENTS").toBeTruthy();
  expect(typeof result.active_subagents).toBe("number");
  expect(result.active_subagents).toBe(4);
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
    "DISPATCH_QUOTA_V1ALPHA3",
    "resolveHostModel",
  ];
  for (const sym of auditorOnly) {
    expect(!(sym in remediateQuota), `remediate-code quota/index should NOT export auditor-only symbol: ${sym}`).toBeTruthy();
  }
});

test("audit-code quota/index exports auditor-specific symbols absent from shared", () => {
  const auditorOnly = [
    "lookupDiscoveredLimits",
    "updateDiscoveredLimits",
    "extractRateLimitHeaders",
    "DISPATCH_QUOTA_V1ALPHA3",
  ];
  for (const sym of auditorOnly) {
    expect(sym in auditQuota, `audit-code quota/index should export auditor-specific symbol: ${sym}`).toBeTruthy();
  }
});

// ── 8. Provider classes are single-sourced in shared (drift-plan E4) ─────────
//
// The claude-code / opencode provider classes live in audit-tools/shared. Each
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
  "../../src/audit/providers/claudeCodeProvider.ts",
  "../../src/audit/providers/opencodeProvider.ts",
  "../../src/remediate/providers/claudeCodeProvider.ts",
  "../../src/remediate/providers/opencodeProvider.ts",
];

test("no per-orchestrator provider class body: orchestrator provider files declare no FreshSessionProvider class", () => {
  for (const rel of PER_ORCHESTRATOR_PROVIDER_FILES) {
    const source = stripComments(readProviderSource(rel));
    // A re-export (`export { ClaudeCodeProvider } from "audit-tools/shared"`)
    // is allowed; a class *declaration* is not. Match `class <Name>` definitions.
    expect(!/\bclass\s+\w+/.test(source), `${rel} must not declare a provider class — the class is single-sourced in audit-tools/shared (drift-plan E4)`).toBeTruthy();
    // It must also not re-implement FreshSessionProvider locally.
    expect(!/implements\s+FreshSessionProvider/.test(source), `${rel} must not implement FreshSessionProvider locally (drift-plan E4)`).toBeTruthy();
    // It must construct/bind the shared class (factory injection), so the shared
    // import has to be present.
    expect(source.includes("audit-tools/shared"), `${rel} must source its provider class from audit-tools/shared`).toBeTruthy();
  }
});

test("provider class single-source: both orchestrators' ClaudeCodeProvider is the SAME shared class identity", async () => {
  const sharedShared = await import("audit-tools/shared");
  const auditClaude = await import("../../src/audit/providers/claudeCodeProvider.ts");
  const remediateClaude = await import(
    new URL(
      "../../src/remediate/providers/claudeCodeProvider.ts",
      import.meta.url,
    )
  );
  expect(auditClaude.ClaudeCodeProvider, "audit-code ClaudeCodeProvider must be the shared class, not a re-implementation").toBe(sharedShared.ClaudeCodeProvider);
  expect(remediateClaude.ClaudeCodeProvider, "remediate-code ClaudeCodeProvider must be the shared class, not a re-implementation").toBe(sharedShared.ClaudeCodeProvider);
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

  const auditClaude = await import("../../src/audit/providers/claudeCodeProvider.ts");
  const remediateClaude = await import(
    new URL(
      "../../src/remediate/providers/claudeCodeProvider.ts",
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
  expect(!auditCall.args.includes("--dangerously-skip-permissions"), "audit-code claude-code must NOT skip permissions by default").toBeTruthy();
  // remediate-code default: permissions skipped (unattended).
  expect(remediateCall.args.includes("--dangerously-skip-permissions"), "remediate-code claude-code MUST skip permissions by default").toBeTruthy();
  // Shared behavior: both deliver the prompt via stdin (not as an argv value).
  expect(auditCall.launchInput.stdinText).toBe("prompt body");
  expect(remediateCall.launchInput.stdinText).toBe("prompt body");
  expect(!auditCall.args.includes("prompt body")).toBeTruthy();
  expect(!remediateCall.args.includes("prompt body")).toBeTruthy();
});

// ── 9. Provider-keyed factory: unknown key → generic fallback (drift-plan E5) ─

test("getErrorParserForProvider: unknown provider key falls back to the generic parser (both orchestrators)", () => {
  for (const [label, quota] of [["audit-code", auditQuota], ["remediate-code", remediateQuota]]) {
    const claude = quota.getErrorParserForProvider("claude-code");
    expect(claude.name, `${label} must resolve claude-code parser`).toBe("claude-code");
    const unknown = quota.getErrorParserForProvider("totally-unknown-provider");
    expect(unknown.name, `${label} unknown key must fall back to generic parser`).toBe("generic");
  }
});

test("getHeaderExtractorForProvider: unknown provider key falls back to the generic extractor (audit-only axis)", async () => {
  // The header AXIS is intentionally audit-only; we only verify the unknown-key
  // fallback contract of its provider-keyed factory here.
  const { getHeaderExtractorForProvider } = await import("../../src/audit/quota/headerExtractors/index.ts");
  expect(getHeaderExtractorForProvider("claude-code").name).toBe("claude-code");
  expect(getHeaderExtractorForProvider("totally-unknown").name).toBe("generic");
});
