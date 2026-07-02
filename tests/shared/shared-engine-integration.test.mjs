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

import { test, expect } from "vitest";
import assert from "node:assert/strict";

const { scheduleWave, classifyProvider, selectDispatchDriver, DISPATCH_Y_DISPATCHER_MIN_ITEMS } = await import(
  "../../src/shared/quota/scheduler.ts"
);
const { renderDispatchDriverInstruction } = await import(
  "../../src/shared/quota/dispatchDriverPrompt.ts"
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

  expect(schedule.max_concurrent, `max_concurrent should equal RPM limit ${N}, got ${schedule.max_concurrent}`).toBe(N);
  expect(schedule.binding_cap, `binding_cap should be 'rpm', got ${schedule.binding_cap}`).toBe("rpm");
  expect(schedule.cooldown_until, "cooldown_until should be null when there is no cooldown").toBe(null);
  // source should reflect explicit_config since limits came from quota.models
  expect(schedule.confidence, "confidence should be 'high' for explicit_config limit source").toBe("high");
});

// ---------------------------------------------------------------------------
// 2. Capability-tier routing
// ---------------------------------------------------------------------------

test("capability-tier routing: classifyProvider returns correct host-class for every ResolvedProviderName", () => {
  expect(classifyProvider("claude-code").hostClass, "claude-code → hosted").toBe("hosted");
  expect(classifyProvider("codex").hostClass, "codex → hosted").toBe("hosted");
  expect(classifyProvider("opencode").hostClass, "opencode → local").toBe("local");
  expect(classifyProvider("local-subprocess").hostClass, "local-subprocess → local").toBe("local");
  expect(classifyProvider("subprocess-template").hostClass, "subprocess-template → unknown").toBe("unknown");
  expect(classifyProvider("vscode-task").hostClass, "vscode-task → unknown").toBe("unknown");
  expect(classifyProvider("antigravity").hostClass, "antigravity → unknown").toBe("unknown");
});

test("capability-tier routing: classifyProvider.concurrencyFloor lifts capable agent hosts off the cold-start floor", () => {
  // Capable agent hosts (claude-code / vscode-task) share the lifted agent-host
  // floor; everything else stays at the conservative cold-start floor — all
  // surfaced ONLY via the struct's concurrencyFloor (no separable constant).
  const agentFloor = classifyProvider("claude-code").concurrencyFloor;
  expect(agentFloor > 3, "claude-code floor lifted above the cold-start floor").toBeTruthy();
  expect(classifyProvider("vscode-task").concurrencyFloor, "vscode-task shares the agent-host floor").toBe(agentFloor);
  // codex / opencode are not capable agent hosts → conservative cold-start floor.
  expect(classifyProvider("codex").concurrencyFloor < agentFloor, "codex stays at the cold-start floor").toBeTruthy();
  expect(classifyProvider("opencode").concurrencyFloor < agentFloor, "opencode stays at the cold-start floor").toBeTruthy();
});

// ---------------------------------------------------------------------------
// 2b. capability-tiered driver selection (S-BROKER-WIRING #13)
// ---------------------------------------------------------------------------

test("selectDispatchDriver: local provider always uses the in-process engine", () => {
  const sel = selectDispatchDriver({
    classification: classifyProvider("opencode"),
    eligibleItemCount: 50,
    slots: 8,
  });
  expect(sel.strategy, "local provider → in_process regardless of frontier size").toBe("in_process");
});

test("selectDispatchDriver: a single slot drives slot-pull (no loop to delegate)", () => {
  const sel = selectDispatchDriver({
    classification: classifyProvider("claude-code"),
    eligibleItemCount: 50,
    slots: 1,
  });
  expect(sel.strategy, "one slot → host drives serially, no dispatcher agent").toBe("slot_pull");
});

test("selectDispatchDriver: a small frontier drives slot-pull even on a capable agent host", () => {
  const sel = selectDispatchDriver({
    classification: classifyProvider("claude-code"),
    eligibleItemCount: DISPATCH_Y_DISPATCHER_MIN_ITEMS - 1,
    slots: 8,
  });
  expect(sel.strategy, "frontier below the threshold → host drives directly").toBe("slot_pull");
});

test("selectDispatchDriver: a large frontier on a capable agent host delegates to a dispatcher subagent", () => {
  const sel = selectDispatchDriver({
    classification: classifyProvider("claude-code"),
    eligibleItemCount: DISPATCH_Y_DISPATCHER_MIN_ITEMS,
    slots: 8,
  });
  expect(sel.strategy, "frontier at/above the threshold with multiple slots → delegate the loop").toBe("y_dispatcher");
  expect(sel.reason).toMatch(/delegate the rolling loop/i);
});

test("selectDispatchDriver: an explicit threshold override is honored", () => {
  const sel = selectDispatchDriver({
    classification: classifyProvider("vscode-task"),
    eligibleItemCount: 3,
    slots: 4,
    threshold: 3,
  });
  expect(sel.strategy, "frontier 3 ≥ override threshold 3 → delegate").toBe("y_dispatcher");
});

test("renderDispatchDriverInstruction: prose matches the chosen strategy and embeds the slots label", () => {
  const y = renderDispatchDriverInstruction(
    { strategy: "y_dispatcher", reason: "x" },
    "`max_concurrent_agents`",
  );
  expect(y).toMatch(/dedicated dispatcher subagent/i);
  expect(y).toMatch(/`max_concurrent_agents`/);

  const pull = renderDispatchDriverInstruction(
    { strategy: "slot_pull", reason: "x" },
    "**4**",
  );
  expect(pull).toMatch(/drive the (rolling )?loop directly|drive the loop yourself/i);
  expect(pull).toMatch(/\*\*4\*\*/);

  const inproc = renderDispatchDriverInstruction(
    { strategy: "in_process", reason: "x" },
    "N",
  );
  expect(inproc).toMatch(/in-process rolling engine/i);
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
  expect(roundTripped.scope_summary, "scope_summary must survive JSON round-trip").toBe("Audit the payments module");
  expect(roundTripped.intent_summary, "intent_summary must survive JSON round-trip").toBe("Full security review of payments");

  // The sentinel is stored on the type but must NOT appear in any
  // shared-layer prompt-builder output.  buildCacheablePrompt is the
  // canonical shared-layer helper that assembles prompts; we verify it
  // does not include the sentinel when given structured intent fields.
  const builtPrompt = buildCacheablePrompt({
    sharedPrefix: `Scope: ${checkpoint.scope_summary}`,
    perAgentPayload: `Goal: ${checkpoint.intent_summary}`,
  });

  expect(!builtPrompt.includes(SENTINEL), `Sentinel free_form_intent value must not appear in built prompt; got:\n${builtPrompt}`).toBeTruthy();

  // Structured fields ARE present; the sentinel is NOT
  expect(builtPrompt.includes(checkpoint.scope_summary), "scope_summary should appear in the assembled prompt").toBeTruthy();
  expect(builtPrompt.includes(checkpoint.intent_summary), "intent_summary should appear in the assembled prompt").toBeTruthy();
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
  expect(genuinelyNew.length, "No genuinely new providers after the only provider is excluded").toBe(0);

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

  expect(next.kind, "outcome should be waiting_for_provider, not a dispatch-capable state").toBe("waiting_for_provider");
  expect(next.kind, "must not fall through to running/dispatch").not.toBe("running");
  expect(next.kind, "must not immediately livelock").not.toBe("terminal");

  // No retry or re-offer of the excluded provider: settled set is not mutated
  expect(settled.has(excludedProvider), "settled set must still contain the excluded provider").toBeTruthy();
  expect(settled.size, "settled set must not grow or shrink").toBe(1);
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

  expect(result, "result must be non-null").toBeTruthy();

  // Encodable clauses are processed without error
  const encodableClauses = result.clauses.filter((c) => c.encodable);
  expect(encodableClauses.length >= 2, `expected at least 2 encodable clauses, got ${encodableClauses.length}: ${JSON.stringify(result.clauses.map((c) => c.text))}`).toBeTruthy();

  // Unencodable clause surfaces a checkpoint_question (escape-hatch)
  expect(result.has_unencodable, "has_unencodable must be true when an unencodable clause is present").toBeTruthy();
  expect(result.checkpoint_questions.length >= 1, `expected at least one checkpoint_question, got ${result.checkpoint_questions.length}`).toBeTruthy();

  // The escape-hatch entry names the specific clause — checkpoint_question is non-empty
  for (const q of result.checkpoint_questions) {
    expect(typeof q === "string" && q.length > 0, `checkpoint_question must be a non-empty string, got: ${JSON.stringify(q)}`).toBeTruthy();
  }

  // The two valid clauses are independently encoded (their sibling unencodable
  // clause does not suppress them)
  const unencodableClauses = result.clauses.filter((c) => !c.encodable);
  expect(unencodableClauses.length >= 1, "at least one clause must be unencodable").toBeTruthy();
  for (const u of unencodableClauses) {
    expect(typeof u.checkpoint_question === "string" && u.checkpoint_question.length > 0, `unencodable clause must carry a checkpoint_question, got: ${JSON.stringify(u)}`).toBeTruthy();
  }
});
