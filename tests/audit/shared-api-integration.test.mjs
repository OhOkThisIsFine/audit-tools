/**
 * Shared-API integration tests (N-X06).
 *
 * Validates the three versioned seam contracts (Rolling Dispatch Engine,
 * Provider Confirmation, FreeFormIntent Interpreter) end-to-end through the
 * audit-code consumer path.
 *
 * All tests are pure/synchronous or use mock dispatchers — no real LLM calls.
 */

import { test, expect } from "vitest";

// ---------------------------------------------------------------------------
// Shared contract imports (the pinned seam types and version constants)
// ---------------------------------------------------------------------------

const {
  ROLLING_DISPATCH_ENGINE_VERSION,
  PROVIDER_CONFIRMATION_RESULT_VERSION,
  FREE_FORM_INTENT_INTERPRETATION_VERSION,
} = await import("audit-tools/shared");

// ---------------------------------------------------------------------------
// audit-code consumer imports
// ---------------------------------------------------------------------------

const { confirmProviders } = await import("../../src/audit/orchestrator/providerConfirmation.ts");
const { interpretFreeFormIntentForAudit } = await import("../../src/audit/orchestrator/intentInterpreter.ts");
const { runRollingDispatch } = await import("../../src/audit/orchestrator/rollingDispatch.ts");

// ============================================================================
// 1. RollingDispatchEngine contract
// ============================================================================

test("ROLLING_DISPATCH_ENGINE_VERSION is a non-empty string", () => {
  expect(typeof ROLLING_DISPATCH_ENGINE_VERSION).toBe("string");
  expect(ROLLING_DISPATCH_ENGINE_VERSION.length > 0).toBeTruthy();
});

test("runRollingDispatch: dispatches items and calls onResult once per item", async () => {
  const onResultCalls = [];
  const terminalCalls = [];

  // Two minimal packets
  const packets = [
    { id: "p1", payload: "task-1", estimatedTokens: 100, complexity: 0.5 },
    { id: "p2", payload: "task-2", estimatedTokens: 100, complexity: 0.5 },
  ];

  // Mock pool — worker-command, no concurrency limit
  const pool = [
    {
      id: "worker-command:null",
      providerName: "worker-command",
      hostModel: null,
      hostConcurrencyLimit: null,
    },
  ];

  const sessionConfig = {};

  const contract = {
    livelockGuard: 3,
    onResult: (result) => {
      onResultCalls.push(result.packet.id);
    },
    consumerTerminal: (status, results) => {
      terminalCalls.push({ status, count: results.length });
    },
  };

  let dispatchCount = 0;
  const dispatchPacket = async (packet, _slot) => {
    dispatchCount++;
    return { packet, outcome: "success" };
  };

  const result = await runRollingDispatch(
    packets,
    pool,
    sessionConfig,
    contract,
    dispatchPacket,
  );

  // Every packet should have been dispatched
  expect(dispatchCount, "dispatch called for each packet").toBe(2);
  // onResult called once per item
  expect(onResultCalls.length, "onResult called twice").toBe(2);
  expect(onResultCalls.includes("p1"), "onResult got p1").toBeTruthy();
  expect(onResultCalls.includes("p2"), "onResult got p2").toBeTruthy();
  // status is complete
  expect(result.status).toBe("complete");
  expect(result.stranded_ids.length).toBe(0);
  expect(result.schema_version).toBe(ROLLING_DISPATCH_ENGINE_VERSION);
  // consumerTerminal called with complete
  expect(terminalCalls.length).toBe(1);
  expect(terminalCalls[0].status).toBe("complete");
});

test("runRollingDispatch: terminates with status partial when pool is empty", async () => {
  const terminalCalls = [];

  const packets = [
    { id: "p1", payload: "task-1", estimatedTokens: 100, complexity: 0.5 },
  ];

  const contract = {
    livelockGuard: 3,
    onResult: undefined,
    consumerTerminal: (status, results) => {
      terminalCalls.push({ status, count: results.length });
    },
  };

  const result = await runRollingDispatch(
    packets,
    [], // empty pool
    {},
    contract,
    async (packet) => ({ packet, outcome: "success" }),
  );

  expect(result.status).toBe("partial");
  expect(result.stranded_ids).toEqual(["p1"]);
  expect(result.partial_reason).toBe("empty_pool");
  // consumerTerminal called with partial
  expect(terminalCalls.length).toBe(1);
  expect(terminalCalls[0].status).toBe("partial");
});

// TST-30655614: individual packet failure path — one packet returns outcome:'failed'
// while another succeeds. The engine considers both "dispatched"; the overall
// status is "complete" (all packets processed) but the failed packet is visible
// in the results with outcome:'failed'. This test pins the contract.
test("runRollingDispatch: one packet outcome:failed is included in results with outcome failed", async () => {
  const onResultCalls = [];

  const packets = [
    { id: "p-ok", payload: "task-ok", estimatedTokens: 100, complexity: 0.5 },
    { id: "p-fail", payload: "task-fail", estimatedTokens: 100, complexity: 0.5 },
  ];

  const pool = [
    {
      id: "worker-command:null",
      providerName: "worker-command",
      hostModel: null,
      hostConcurrencyLimit: null,
    },
  ];

  const contract = {
    livelockGuard: 3,
    onResult: (result) => {
      onResultCalls.push({ id: result.packet.id, outcome: result.outcome });
    },
    consumerTerminal: undefined,
  };

  const dispatchPacket = async (packet) => {
    if (packet.id === "p-fail") {
      return { packet, outcome: "failed" };
    }
    return { packet, outcome: "success" };
  };

  const result = await runRollingDispatch(packets, pool, {}, contract, dispatchPacket);

  // Both packets are dispatched; outcome:'failed' is a completed result, not a strandedId.
  expect(result.status, "all packets dispatched → status is complete").toBe("complete");
  expect(result.stranded_ids.length, "no stranded packets — failure is still a dispatch result").toBe(0);

  // onResult is invoked for every dispatched packet, including the failed one.
  const resultIds = onResultCalls.map((r) => r.id);
  expect(resultIds.includes("p-ok"), "onResult should be called for the successful packet").toBeTruthy();
  expect(resultIds.includes("p-fail"), "onResult should be called for the failed packet").toBeTruthy();

  // Verify the failed packet's outcome is correctly recorded.
  const failedResult = onResultCalls.find((r) => r.id === "p-fail");
  expect(failedResult?.outcome, "failed packet must have outcome:failed in results").toBe("failed");
});

// ============================================================================
// 2. ProviderConfirmationResult contract
// ============================================================================

test("PROVIDER_CONFIRMATION_RESULT_VERSION is a non-empty string", () => {
  expect(typeof PROVIDER_CONFIRMATION_RESULT_VERSION).toBe("string");
  expect(PROVIDER_CONFIRMATION_RESULT_VERSION.length > 0).toBeTruthy();
});

test("confirmProviders: returns a valid ProviderConfirmationResult with schema_version", () => {
  // Run in an env that has no CLIs on PATH (commandExists will return false
  // for all CLIs since we inject a clean env without PATH entries for them).
  const result = confirmProviders(
    {},
    {
      // Deliberately no CLAUDECODE/CODEX/OPENCODE env vars — no self-spawn block.
      // Deliberately no claude/opencode/codex on PATH.
    },
    [],
  );

  expect(result.schema_version).toBe(PROVIDER_CONFIRMATION_RESULT_VERSION);
  expect(typeof result.confirmed_at).toBe("string");
  expect(result.confirmed_at.length > 0, "confirmed_at is set").toBeTruthy();
  expect(Array.isArray(result.provider_pool), "provider_pool is array").toBeTruthy();
  expect(result.provider_pool.length >= 1, "at least one pool entry").toBeTruthy();
  expect(result.session_level).toBe(true);
});

test("confirmProviders: every pool entry has name, capability_tier, excluded flag", () => {
  const result = confirmProviders({}, {}, []);

  for (const entry of result.provider_pool) {
    expect(typeof entry.name, `entry.name is string for ${JSON.stringify(entry)}`).toBe("string");
    expect(typeof entry.capability_tier, `entry.capability_tier is string`).toBe("string");
    expect(typeof entry.excluded, `entry.excluded is boolean`).toBe("boolean");
  }
});

test("confirmProviders: worker-command is present and not excluded by default", () => {
  const result = confirmProviders({}, {}, []);
  const local = result.provider_pool.find((e) => e.name === "worker-command");
  expect(local, "worker-command in pool").toBeTruthy();
  expect(local.excluded).toBe(false);
});

test("confirmProviders: worker-command is marked excluded when explicitly excluded", () => {
  const result = confirmProviders({}, {}, ["worker-command"]);
  const local = result.provider_pool.find((e) => e.name === "worker-command");
  expect(local, "worker-command still in pool when excluded").toBeTruthy();
  expect(local.excluded).toBe(true);
});

// ============================================================================
// 3. FreeFormIntentInterpretation contract
// ============================================================================

test("FREE_FORM_INTENT_INTERPRETATION_VERSION is a non-empty string", () => {
  expect(typeof FREE_FORM_INTENT_INTERPRETATION_VERSION).toBe("string");
  expect(FREE_FORM_INTENT_INTERPRETATION_VERSION.length > 0).toBeTruthy();
});

test("interpretFreeFormIntentForAudit: encodes a lens clause and promotes an uncodable clause", () => {
  // Use a compound input where one clause maps to a lens and one is genuinely
  // unencodable (no lens keyword, scope pattern, or priority keyword).
  const result = interpretFreeFormIntentForAudit(
    "focus on security; use strict mode for all modules",
  );

  expect(result.schema_version).toBe(FREE_FORM_INTENT_INTERPRETATION_VERSION);
  expect(Array.isArray(result.encoded_clauses), "encoded_clauses is array").toBeTruthy();
  expect(Array.isArray(result.checkpoint_questions), "checkpoint_questions is array").toBeTruthy();
  expect(typeof result.has_unencodable).toBe("boolean");

  // "focus on security" → lens_weight for security
  const securityClause = result.encoded_clauses.find(
    (c) => c.kind === "lens_weight" && c.lens === "security",
  );
  expect(securityClause, "encoded_clauses contains a lens_weight entry for security").toBeTruthy();

  // "use strict mode for all modules" cannot be encoded → checkpoint question
  expect(result.checkpoint_questions.length >= 1, "at least one checkpoint question").toBeTruthy();
  expect(result.has_unencodable).toBe(true);
});

test("interpretFreeFormIntentForAudit: free_form_intent is NOT threaded verbatim into any returned field", () => {
  const verbatim = "focus on security; use strict mode for all modules";
  const result = interpretFreeFormIntentForAudit(verbatim);

  // schema_version should not contain verbatim
  expect(!result.schema_version.includes(verbatim)).toBeTruthy();

  // No encoded clause's text field should equal the full input verbatim
  for (const clause of result.encoded_clauses) {
    expect(clause.text !== verbatim, `encoded clause text should not equal verbatim input, got: ${clause.text}`).toBeTruthy();
  }
});

test("interpretFreeFormIntentForAudit: empty input returns empty results", () => {
  const result = interpretFreeFormIntentForAudit("");
  expect(result.schema_version).toBe(FREE_FORM_INTENT_INTERPRETATION_VERSION);
  expect(result.encoded_clauses).toEqual([]);
  expect(result.checkpoint_questions).toEqual([]);
  expect(result.has_unencodable).toBe(false);
});

// ============================================================================
// 4. End-to-end: all three compose without throwing
// ============================================================================

test("all three shared APIs compose end-to-end without throwing", async () => {
  // Step 1: confirm providers (deterministic)
  const confirmation = confirmProviders({}, {}, []);
  expect(confirmation.schema_version).toBe(PROVIDER_CONFIRMATION_RESULT_VERSION);

  // Step 2: interpret intent (deterministic)
  const interpretation = interpretFreeFormIntentForAudit("review security and performance");
  expect(interpretation.schema_version).toBe(FREE_FORM_INTENT_INTERPRETATION_VERSION);

  // Step 3: run rolling dispatch through the confirmed pool
  const packets = [
    { id: "task-1", payload: { lens: "security" }, estimatedTokens: 200, complexity: 0.8 },
    { id: "task-2", payload: { lens: "performance" }, estimatedTokens: 200, complexity: 0.3 },
  ];

  // Use worker-command pool (always available)
  const pool = [
    {
      id: "worker-command:null",
      providerName: "worker-command",
      hostModel: null,
      hostConcurrencyLimit: null,
    },
  ];

  const onResultIds = [];
  const contract = {
    livelockGuard: 3,
    onResult: (r) => onResultIds.push(r.packet.id),
    consumerTerminal: undefined,
  };

  const dispatchResult = await runRollingDispatch(
    packets,
    pool,
    {},
    contract,
    async (packet) => ({ packet, outcome: "success" }),
  );

  // All three composed without throwing; dispatch completed
  expect(dispatchResult.status).toBe("complete");
  expect(dispatchResult.results.length).toBe(2);
  expect(onResultIds.length).toBe(2);

  // Verify confirmation and interpretation are non-trivially populated
  expect(confirmation.provider_pool.length >= 1).toBeTruthy();
  expect(interpretation.encoded_clauses.length >= 1 ||
      interpretation.checkpoint_questions.length >= 1, "interpretation has at least some output").toBeTruthy();
});
