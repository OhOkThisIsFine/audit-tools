import test from "node:test";
import assert from "node:assert/strict";

const { EXECUTOR_REGISTRY, isHostDelegationExecutor } = await import(
  "../src/orchestrator/executors.ts"
);

test("synthesis_narrative_executor is classified as host_delegation in the registry", () => {
  const entry = EXECUTOR_REGISTRY.find(
    (e) => e.id === "synthesis_narrative_executor",
  );
  assert.ok(entry, "synthesis_narrative_executor must exist in EXECUTOR_REGISTRY");
  assert.strictEqual(
    entry.kind,
    "host_delegation",
    "synthesis_narrative_executor kind must be host_delegation",
  );
});

test("isHostDelegationExecutor returns true for synthesis_narrative_executor", () => {
  assert.strictEqual(
    isHostDelegationExecutor("synthesis_narrative_executor"),
    true,
  );
});

test("isHostDelegationExecutor returns false for synthesis_executor (deterministic sibling)", () => {
  assert.strictEqual(
    isHostDelegationExecutor("synthesis_executor"),
    false,
  );
});
