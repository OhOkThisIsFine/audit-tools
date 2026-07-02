import { test, expect } from "vitest";

const { EXECUTOR_REGISTRY, isHostDelegationExecutor } = await import("../../src/audit/orchestrator/executors.ts");

test("synthesis_narrative_executor is classified as host_delegation in the registry", () => {
  const entry = EXECUTOR_REGISTRY.find(
    (e) => e.id === "synthesis_narrative_executor",
  );
  expect(entry, "synthesis_narrative_executor must exist in EXECUTOR_REGISTRY").toBeTruthy();
  expect(entry.kind, "synthesis_narrative_executor kind must be host_delegation").toBe("host_delegation");
});

test("isHostDelegationExecutor returns true for synthesis_narrative_executor", () => {
  expect(isHostDelegationExecutor("synthesis_narrative_executor")).toBe(true);
});

test("isHostDelegationExecutor returns false for synthesis_executor (deterministic sibling)", () => {
  expect(isHostDelegationExecutor("synthesis_executor")).toBe(false);
});
