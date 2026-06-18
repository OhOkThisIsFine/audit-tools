import test from "node:test";
import assert from "node:assert/strict";

// Import from source via tsx loader so un-rebuilt changes are caught.
import { EXECUTOR_REGISTRY, isHostDelegationExecutor } from "../src/orchestrator/executors.ts";
import { EXECUTOR_RUNNERS } from "../src/orchestrator/executorRunners.ts";
import { PRIORITY } from "../src/orchestrator/nextStep.ts";

test("every PRIORITY obligation is covered by exactly one EXECUTOR_REGISTRY entry", () => {
  for (const obligationId of PRIORITY) {
    const matches = EXECUTOR_REGISTRY.filter((entry) =>
      entry.obligation_ids.includes(obligationId),
    );
    assert.equal(
      matches.length,
      1,
      `PRIORITY obligation "${obligationId}" should be claimed by exactly one EXECUTOR_REGISTRY entry, got ${matches.length}: [${matches.map((e) => e.id).join(", ")}]`,
    );
  }
});

test("isHostDelegationExecutor returns true for design_review_contract, design_review_conceptual, agent, intent_checkpoint_executor, provider_confirmation_executor, and synthesis_narrative_executor", () => {
  assert.equal(isHostDelegationExecutor("design_review_contract"), true);
  assert.equal(isHostDelegationExecutor("design_review_conceptual"), true);
  assert.equal(isHostDelegationExecutor("agent"), true);
  assert.equal(isHostDelegationExecutor("intent_checkpoint_executor"), true);
  assert.equal(isHostDelegationExecutor("provider_confirmation_executor"), true);
  assert.equal(isHostDelegationExecutor("synthesis_narrative_executor"), true);
  assert.equal(isHostDelegationExecutor("intake_executor"), false);
  assert.equal(isHostDelegationExecutor("synthesis_executor"), false);
  assert.equal(isHostDelegationExecutor("planning_executor"), false);
  assert.equal(isHostDelegationExecutor("unknown_executor"), false);
  // design_review no longer exists in registry
  assert.equal(isHostDelegationExecutor("design_review"), false);
});

test("all EXECUTOR_REGISTRY entries have a valid kind field", () => {
  const hostDelegationIds = new Set([
    "design_review_contract",
    "design_review_conceptual",
    "agent",
    "intent_checkpoint_executor",
    "provider_confirmation_executor",
    "rolling_dispatch_executor",
    "synthesis_narrative_executor",
  ]);
  for (const entry of EXECUTOR_REGISTRY) {
    assert.ok(
      entry.kind === "deterministic" || entry.kind === "host_delegation",
      `EXECUTOR_REGISTRY entry "${entry.id}" has invalid kind: ${String(entry.kind)}`,
    );
    if (hostDelegationIds.has(entry.id)) {
      assert.equal(
        entry.kind,
        "host_delegation",
        `EXECUTOR_REGISTRY entry "${entry.id}" should have kind "host_delegation"`,
      );
    } else {
      assert.equal(
        entry.kind,
        "deterministic",
        `EXECUTOR_REGISTRY entry "${entry.id}" should have kind "deterministic"`,
      );
    }
  }
  // Verify exactly these executors are host_delegation
  const hostEntries = EXECUTOR_REGISTRY.filter((e) => e.kind === "host_delegation");
  assert.deepEqual(
    hostEntries.map((e) => e.id).sort(),
    ["agent", "design_review_conceptual", "design_review_contract", "intent_checkpoint_executor", "provider_confirmation_executor", "rolling_dispatch_executor", "synthesis_narrative_executor"],
    "Exactly 'agent', 'design_review_contract', 'design_review_conceptual', 'intent_checkpoint_executor', 'provider_confirmation_executor', 'rolling_dispatch_executor', and 'synthesis_narrative_executor' should have kind host_delegation",
  );
});

test("every registry executor with a PRIORITY obligation has a runner in EXECUTOR_RUNNERS (host-delegation dispatch executors excepted)", () => {
  const prioritySet = new Set(PRIORITY);
  // agent + rolling_dispatch_executor are host-delegation *dispatch* points:
  // routed through host delegation before advanceAudit, they intentionally have
  // NO deterministic runner and produce a no-progress handoff (the "no runner"
  // branch in advanceAudit) if dispatched directly. EXECUTOR_RUNNERS is now the
  // single source of dispatch — this replaces the old "explicit case in the
  // advance.ts switch" invariant (the switch is gone).
  const HOST_DELEGATED_DISPATCH = new Set(["agent", "rolling_dispatch_executor"]);

  for (const entry of EXECUTOR_REGISTRY) {
    const hasPriorityObligation = entry.obligation_ids.some((id) =>
      prioritySet.has(id),
    );
    if (!hasPriorityObligation) continue;

    const hasRunner = Object.hasOwn(EXECUTOR_RUNNERS, entry.id);
    if (HOST_DELEGATED_DISPATCH.has(entry.id)) {
      assert.ok(
        !hasRunner,
        `host-delegation dispatch executor "${entry.id}" must NOT have a deterministic runner in EXECUTOR_RUNNERS`,
      );
    } else {
      assert.ok(
        hasRunner,
        `EXECUTOR_REGISTRY entry "${entry.id}" has PRIORITY obligation(s) [${entry.obligation_ids.filter((id) => prioritySet.has(id)).join(", ")}] but no runner in EXECUTOR_RUNNERS — advanceAudit could not dispatch it`,
      );
    }
  }
});
