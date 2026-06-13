/**
 * Shared-API integration tests (N-X06).
 *
 * Validates the three versioned seam contracts (Rolling Dispatch Engine,
 * Provider Confirmation, FreeFormIntent Interpreter) end-to-end through the
 * audit-code consumer path.
 *
 * All tests are pure/synchronous or use mock dispatchers — no real LLM calls.
 */

import test from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Shared contract imports (the pinned seam types and version constants)
// ---------------------------------------------------------------------------

const {
  ROLLING_DISPATCH_ENGINE_VERSION,
  PROVIDER_CONFIRMATION_RESULT_VERSION,
  FREE_FORM_INTENT_INTERPRETATION_VERSION,
} = await import("@audit-tools/shared");

// ---------------------------------------------------------------------------
// audit-code consumer imports
// ---------------------------------------------------------------------------

const { confirmProviders } = await import(
  "../src/orchestrator/providerConfirmation.ts"
);
const { interpretFreeFormIntentForAudit } = await import(
  "../src/orchestrator/intentInterpreter.ts"
);
const { runRollingDispatch } = await import(
  "../src/orchestrator/rollingDispatch.ts"
);

// ============================================================================
// 1. RollingDispatchEngine contract
// ============================================================================

test("ROLLING_DISPATCH_ENGINE_VERSION is a non-empty string", () => {
  assert.equal(typeof ROLLING_DISPATCH_ENGINE_VERSION, "string");
  assert.ok(ROLLING_DISPATCH_ENGINE_VERSION.length > 0);
});

test("runRollingDispatch: dispatches items and calls onResult once per item", async () => {
  const onResultCalls = [];
  const terminalCalls = [];

  // Two minimal packets
  const packets = [
    { id: "p1", payload: "task-1", estimatedTokens: 100, complexity: 0.5 },
    { id: "p2", payload: "task-2", estimatedTokens: 100, complexity: 0.5 },
  ];

  // Mock pool — local-subprocess, no concurrency limit
  const pool = [
    {
      id: "local-subprocess:null",
      providerName: "local-subprocess",
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
  assert.equal(dispatchCount, 2, "dispatch called for each packet");
  // onResult called once per item
  assert.equal(onResultCalls.length, 2, "onResult called twice");
  assert.ok(onResultCalls.includes("p1"), "onResult got p1");
  assert.ok(onResultCalls.includes("p2"), "onResult got p2");
  // status is complete
  assert.equal(result.status, "complete");
  assert.equal(result.stranded_ids.length, 0);
  assert.equal(result.schema_version, ROLLING_DISPATCH_ENGINE_VERSION);
  // consumerTerminal called with complete
  assert.equal(terminalCalls.length, 1);
  assert.equal(terminalCalls[0].status, "complete");
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

  assert.equal(result.status, "partial");
  assert.deepEqual(result.stranded_ids, ["p1"]);
  assert.equal(result.partial_reason, "empty_pool");
  // consumerTerminal called with partial
  assert.equal(terminalCalls.length, 1);
  assert.equal(terminalCalls[0].status, "partial");
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
      id: "local-subprocess:null",
      providerName: "local-subprocess",
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
  assert.equal(result.status, "complete", "all packets dispatched → status is complete");
  assert.equal(result.stranded_ids.length, 0, "no stranded packets — failure is still a dispatch result");

  // onResult is invoked for every dispatched packet, including the failed one.
  const resultIds = onResultCalls.map((r) => r.id);
  assert.ok(resultIds.includes("p-ok"), "onResult should be called for the successful packet");
  assert.ok(resultIds.includes("p-fail"), "onResult should be called for the failed packet");

  // Verify the failed packet's outcome is correctly recorded.
  const failedResult = onResultCalls.find((r) => r.id === "p-fail");
  assert.equal(failedResult?.outcome, "failed", "failed packet must have outcome:failed in results");
});

// ============================================================================
// 2. ProviderConfirmationResult contract
// ============================================================================

test("PROVIDER_CONFIRMATION_RESULT_VERSION is a non-empty string", () => {
  assert.equal(typeof PROVIDER_CONFIRMATION_RESULT_VERSION, "string");
  assert.ok(PROVIDER_CONFIRMATION_RESULT_VERSION.length > 0);
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

  assert.equal(result.schema_version, PROVIDER_CONFIRMATION_RESULT_VERSION);
  assert.equal(typeof result.confirmed_at, "string");
  assert.ok(result.confirmed_at.length > 0, "confirmed_at is set");
  assert.ok(Array.isArray(result.provider_pool), "provider_pool is array");
  assert.ok(result.provider_pool.length >= 1, "at least one pool entry");
  assert.equal(result.session_level, true);
});

test("confirmProviders: every pool entry has name, capability_tier, excluded flag", () => {
  const result = confirmProviders({}, {}, []);

  for (const entry of result.provider_pool) {
    assert.equal(typeof entry.name, "string", `entry.name is string for ${JSON.stringify(entry)}`);
    assert.equal(typeof entry.capability_tier, "string", `entry.capability_tier is string`);
    assert.equal(typeof entry.excluded, "boolean", `entry.excluded is boolean`);
  }
});

test("confirmProviders: local-subprocess is present and not excluded by default", () => {
  const result = confirmProviders({}, {}, []);
  const local = result.provider_pool.find((e) => e.name === "local-subprocess");
  assert.ok(local, "local-subprocess in pool");
  assert.equal(local.excluded, false);
});

test("confirmProviders: local-subprocess is marked excluded when explicitly excluded", () => {
  const result = confirmProviders({}, {}, ["local-subprocess"]);
  const local = result.provider_pool.find((e) => e.name === "local-subprocess");
  assert.ok(local, "local-subprocess still in pool when excluded");
  assert.equal(local.excluded, true);
});

// ============================================================================
// 3. FreeFormIntentInterpretation contract
// ============================================================================

test("FREE_FORM_INTENT_INTERPRETATION_VERSION is a non-empty string", () => {
  assert.equal(typeof FREE_FORM_INTENT_INTERPRETATION_VERSION, "string");
  assert.ok(FREE_FORM_INTENT_INTERPRETATION_VERSION.length > 0);
});

test("interpretFreeFormIntentForAudit: encodes a lens clause and promotes an uncodable clause", () => {
  // Use a compound input where one clause maps to a lens and one is genuinely
  // unencodable (no lens keyword, scope pattern, or priority keyword).
  const result = interpretFreeFormIntentForAudit(
    "focus on security; use strict mode for all modules",
  );

  assert.equal(result.schema_version, FREE_FORM_INTENT_INTERPRETATION_VERSION);
  assert.ok(Array.isArray(result.encoded_clauses), "encoded_clauses is array");
  assert.ok(Array.isArray(result.checkpoint_questions), "checkpoint_questions is array");
  assert.equal(typeof result.has_unencodable, "boolean");

  // "focus on security" → lens_weight for security
  const securityClause = result.encoded_clauses.find(
    (c) => c.kind === "lens_weight" && c.lens === "security",
  );
  assert.ok(securityClause, "encoded_clauses contains a lens_weight entry for security");

  // "use strict mode for all modules" cannot be encoded → checkpoint question
  assert.ok(result.checkpoint_questions.length >= 1, "at least one checkpoint question");
  assert.equal(result.has_unencodable, true);
});

test("interpretFreeFormIntentForAudit: free_form_intent is NOT threaded verbatim into any returned field", () => {
  const verbatim = "focus on security; use strict mode for all modules";
  const result = interpretFreeFormIntentForAudit(verbatim);

  // schema_version should not contain verbatim
  assert.ok(!result.schema_version.includes(verbatim));

  // No encoded clause's text field should equal the full input verbatim
  for (const clause of result.encoded_clauses) {
    assert.ok(
      clause.text !== verbatim,
      `encoded clause text should not equal verbatim input, got: ${clause.text}`,
    );
  }
});

test("interpretFreeFormIntentForAudit: empty input returns empty results", () => {
  const result = interpretFreeFormIntentForAudit("");
  assert.equal(result.schema_version, FREE_FORM_INTENT_INTERPRETATION_VERSION);
  assert.deepEqual(result.encoded_clauses, []);
  assert.deepEqual(result.checkpoint_questions, []);
  assert.equal(result.has_unencodable, false);
});

// ============================================================================
// 4. End-to-end: all three compose without throwing
// ============================================================================

test("all three shared APIs compose end-to-end without throwing", async () => {
  // Step 1: confirm providers (deterministic)
  const confirmation = confirmProviders({}, {}, []);
  assert.equal(confirmation.schema_version, PROVIDER_CONFIRMATION_RESULT_VERSION);

  // Step 2: interpret intent (deterministic)
  const interpretation = interpretFreeFormIntentForAudit("review security and performance");
  assert.equal(interpretation.schema_version, FREE_FORM_INTENT_INTERPRETATION_VERSION);

  // Step 3: run rolling dispatch through the confirmed pool
  const packets = [
    { id: "task-1", payload: { lens: "security" }, estimatedTokens: 200, complexity: 0.8 },
    { id: "task-2", payload: { lens: "performance" }, estimatedTokens: 200, complexity: 0.3 },
  ];

  // Use local-subprocess pool (always available)
  const pool = [
    {
      id: "local-subprocess:null",
      providerName: "local-subprocess",
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
  assert.equal(dispatchResult.status, "complete");
  assert.equal(dispatchResult.results.length, 2);
  assert.equal(onResultIds.length, 2);

  // Verify confirmation and interpretation are non-trivially populated
  assert.ok(confirmation.provider_pool.length >= 1);
  assert.ok(
    interpretation.encoded_clauses.length >= 1 ||
      interpretation.checkpoint_questions.length >= 1,
    "interpretation has at least some output",
  );
});
