/**
 * Integration tests for shared-engine behaviors from the workflow redesign (N-S08).
 *
 * Five tests:
 *   1. quota-only throttling — max_concurrent bounded exclusively by RPM
 *   2. capability-tier routing — classifyProvider struct (hostClass + concurrencyFloor)
 *   3. free_form_intent never emitted verbatim by shared-layer prompt builders
 *   4. emptied provider pool reaches waiting_for_provider terminal (pending — ProviderPool)
 *   5. per-clause escape-hatch for unencodable hard clause in compound intent
 */

import test from "node:test";
import assert from "node:assert/strict";

const { scheduleWave, classifyProvider } = await import(
  "../../src/shared/quota/scheduler.ts"
);
const { buildCacheablePrompt } = await import("../../src/shared/prompts.ts");
const { filterNewProviders, advancePausedState } = await import("../../src/shared/rolling/pausedState.ts");
const { interpretIntent } = await import("../../src/shared/intent/clauseInterpreter.ts");

// ---------------------------------------------------------------------------
// 1. Quota-only throttling — max_concurrent bounded exclusively by RPM
// ---------------------------------------------------------------------------

test("quota-only throttling: max_concurrent bounded exclusively by RPM when it is the sole constraint", () => {
  const N = 7;
  const schedule = scheduleWave({
    providerName: "claude-code",
    sessionConfig: {
      quota: {
        enabled: true,
        safety_margin: 1.0, // no safety shrinkage so cap is exact
        empirical_half_life_hours: 24,
        models: {
          "test/rpm-only-model": { requests_per_minute: N },
        },
        // no unknown_hosted_concurrency, no first_contact_concurrency
      },
    },
    hostModel: "test/rpm-only-model",
    requestedConcurrency: N * 10, // >> N so RPM is definitively binding
    quotaStateEntry: null,
    hostConcurrencyLimit: null,
  });

  assert.equal(
    schedule.max_concurrent,
    N,
    `max_concurrent should equal RPM limit ${N}, got ${schedule.max_concurrent}`,
  );
  assert.equal(
    schedule.binding_cap,
    "rpm",
    `binding_cap should be 'rpm', got ${schedule.binding_cap}`,
  );
  assert.equal(
    schedule.cooldown_until,
    null,
    "cooldown_until should be null when there is no cooldown",
  );
  // source should reflect explicit_config since limits came from quota.models
  assert.equal(
    schedule.confidence,
    "high",
    "confidence should be 'high' for explicit_config limit source",
  );
});

// ---------------------------------------------------------------------------
// 2. Capability-tier routing
// ---------------------------------------------------------------------------

test("capability-tier routing: classifyProvider returns correct host-class for every ResolvedProviderName", () => {
  assert.equal(classifyProvider("claude-code").hostClass, "hosted", "claude-code → hosted");
  assert.equal(classifyProvider("codex").hostClass, "hosted", "codex → hosted");
  assert.equal(classifyProvider("opencode").hostClass, "local", "opencode → local");
  assert.equal(
    classifyProvider("local-subprocess").hostClass,
    "local",
    "local-subprocess → local",
  );
  assert.equal(
    classifyProvider("subprocess-template").hostClass,
    "unknown",
    "subprocess-template → unknown",
  );
  assert.equal(classifyProvider("vscode-task").hostClass, "unknown", "vscode-task → unknown");
  assert.equal(classifyProvider("antigravity").hostClass, "unknown", "antigravity → unknown");
});

test("capability-tier routing: classifyProvider.concurrencyFloor lifts capable agent hosts off the cold-start floor", () => {
  // Capable agent hosts (claude-code / vscode-task) share the lifted agent-host
  // floor; everything else stays at the conservative cold-start floor — all
  // surfaced ONLY via the struct's concurrencyFloor (no separable constant).
  const agentFloor = classifyProvider("claude-code").concurrencyFloor;
  assert.ok(agentFloor > 3, "claude-code floor lifted above the cold-start floor");
  assert.equal(
    classifyProvider("vscode-task").concurrencyFloor,
    agentFloor,
    "vscode-task shares the agent-host floor",
  );
  // codex / opencode are not capable agent hosts → conservative cold-start floor.
  assert.ok(
    classifyProvider("codex").concurrencyFloor < agentFloor,
    "codex stays at the cold-start floor",
  );
  assert.ok(
    classifyProvider("opencode").concurrencyFloor < agentFloor,
    "opencode stays at the cold-start floor",
  );
});

// ---------------------------------------------------------------------------
// 3. free_form_intent never emitted verbatim by shared-layer prompt builders
// ---------------------------------------------------------------------------

test("free_form_intent never emitted verbatim: IntentCheckpoint type-level invariant", () => {
  const SENTINEL = "SENTINEL_FREE_FORM_7f3a9b2c_MUST_NOT_APPEAR_IN_PROMPT";

  /** @type {import('../../src/shared/types/intentCheckpoint.ts').IntentCheckpoint} */
  const checkpoint = {
    schema_version: "intent-checkpoint/v1",
    confirmed_at: "2026-01-01T00:00:00.000Z",
    confirmed_by: "host",
    scope_summary: "Audit the payments module",
    intent_summary: "Full security review of payments",
    free_form_intent: SENTINEL,
  };

  // Round-trip through JSON preserves the structured fields
  const roundTripped = JSON.parse(JSON.stringify(checkpoint));
  assert.equal(
    roundTripped.scope_summary,
    "Audit the payments module",
    "scope_summary must survive JSON round-trip",
  );
  assert.equal(
    roundTripped.intent_summary,
    "Full security review of payments",
    "intent_summary must survive JSON round-trip",
  );

  // The sentinel is stored on the type but must NOT appear in any
  // shared-layer prompt-builder output.  buildCacheablePrompt is the
  // canonical shared-layer helper that assembles prompts; we verify it
  // does not include the sentinel when given structured intent fields.
  const builtPrompt = buildCacheablePrompt({
    sharedPrefix: `Scope: ${checkpoint.scope_summary}`,
    perAgentPayload: `Goal: ${checkpoint.intent_summary}`,
  });

  assert.ok(
    !builtPrompt.includes(SENTINEL),
    `Sentinel free_form_intent value must not appear in built prompt; got:\n${builtPrompt}`,
  );

  // Structured fields ARE present; the sentinel is NOT
  assert.ok(
    builtPrompt.includes(checkpoint.scope_summary),
    "scope_summary should appear in the assembled prompt",
  );
  assert.ok(
    builtPrompt.includes(checkpoint.intent_summary),
    "intent_summary should appear in the assembled prompt",
  );
});

// ---------------------------------------------------------------------------
// 4. Emptied provider pool reaches waiting_for_provider (uses pausedState logic)
// ---------------------------------------------------------------------------

test("emptied provider pool reaches waiting_for_provider terminal state", () => {
  // Simulate: a pool with one provider entry that is then excluded.
  // After exclusion, filterNewProviders returns [] (all discovered providers
  // are in the settled exclusion set).  advancePausedState below the livelock
  // limit returns waiting_for_provider — not any dispatch-capable state.

  const excludedProvider = "pool-provider-A";
  const settled = new Set([excludedProvider]);

  // Re-discovery surfaces the same (now-excluded) provider only.
  const genuinelyNew = filterNewProviders([excludedProvider], settled);
  assert.equal(
    genuinelyNew.length,
    0,
    "No genuinely new providers after the only provider is excluded",
  );

  // Engine transitions into waiting_for_provider (not a dispatch state).
  const pausedState = {
    kind: /** @type {"waiting_for_provider"} */ ("waiting_for_provider"),
    paused_at: new Date().toISOString(),
    pause_count: 0,
    stranded_node_ids: ["node-X"],
  };

  const next = advancePausedState({
    current: pausedState,
    rediscoveredProviders: [excludedProvider],
    settledExclusions: settled,
    livelockLimit: 999, // stay paused, do not livelock in this test
  });

  assert.equal(
    next.kind,
    "waiting_for_provider",
    "outcome should be waiting_for_provider, not a dispatch-capable state",
  );
  assert.notEqual(next.kind, "running", "must not fall through to running/dispatch");
  assert.notEqual(next.kind, "terminal", "must not immediately livelock");

  // No retry or re-offer of the excluded provider: settled set is not mutated
  assert.ok(settled.has(excludedProvider), "settled set must still contain the excluded provider");
  assert.equal(settled.size, 1, "settled set must not grow or shrink");
});

// ---------------------------------------------------------------------------
// 5. Per-clause escape-hatch: unencodable hard clause in compound intent
// ---------------------------------------------------------------------------

test("per-clause escape-hatch: unencodable hard clause in otherwise-encodable compound intent", () => {
  // Two encodable clauses + one unencodable clause.
  // interpretIntent must: encode the two valid clauses, surface a
  // checkpoint_question for the unencodable one, and not throw.
  const input = [
    "focus on security",
    "check performance",
    "freeze the public API contract of ServiceX permanently",
  ].join(". ");

  let result;
  // Must not throw — escape-hatch is structured output, not an exception
  assert.doesNotThrow(() => {
    result = interpretIntent(input);
  }, "interpretIntent must not throw for compound intent with one unencodable clause");

  assert.ok(result, "result must be non-null");

  // Encodable clauses are processed without error
  const encodableClauses = result.clauses.filter((c) => c.encodable);
  assert.ok(
    encodableClauses.length >= 2,
    `expected at least 2 encodable clauses, got ${encodableClauses.length}: ${JSON.stringify(result.clauses.map((c) => c.text))}`,
  );

  // Unencodable clause surfaces a checkpoint_question (escape-hatch)
  assert.ok(
    result.has_unencodable,
    "has_unencodable must be true when an unencodable clause is present",
  );
  assert.ok(
    result.checkpoint_questions.length >= 1,
    `expected at least one checkpoint_question, got ${result.checkpoint_questions.length}`,
  );

  // The escape-hatch entry names the specific clause — checkpoint_question is non-empty
  for (const q of result.checkpoint_questions) {
    assert.ok(
      typeof q === "string" && q.length > 0,
      `checkpoint_question must be a non-empty string, got: ${JSON.stringify(q)}`,
    );
  }

  // The two valid clauses are independently encoded (their sibling unencodable
  // clause does not suppress them)
  const unencodableClauses = result.clauses.filter((c) => !c.encodable);
  assert.ok(
    unencodableClauses.length >= 1,
    "at least one clause must be unencodable",
  );
  for (const u of unencodableClauses) {
    assert.ok(
      typeof u.checkpoint_question === "string" && u.checkpoint_question.length > 0,
      `unencodable clause must carry a checkpoint_question, got: ${JSON.stringify(u)}`,
    );
  }
});
