import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Import from source via tsx loader so un-rebuilt changes are caught.
import { EXECUTOR_REGISTRY, isHostDelegationExecutor } from "../src/orchestrator/executors.ts";
import { PRIORITY } from "../src/orchestrator/nextStep.ts";

const here = dirname(fileURLToPath(import.meta.url));
const advancePath = join(here, "..", "src", "orchestrator", "advance.ts");

/**
 * Extract the set of literal case strings from the switch(selectedExecutor)
 * block in advance.ts without importing or building the file.
 */
async function extractSwitchCases() {
  const src = await readFile(advancePath, "utf8");
  const cases = new Set();
  // Match case "...": lines inside the switch block.
  for (const m of src.matchAll(/case\s+"([^"]+)"\s*:/g)) {
    cases.add(m[1]);
  }
  return cases;
}

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

test("every registry executor with a PRIORITY obligation has an explicit case in the advance.ts switch", async () => {
  const switchCases = await extractSwitchCases();
  const prioritySet = new Set(PRIORITY);

  for (const entry of EXECUTOR_REGISTRY) {
    // Only check executors that have at least one obligation_id listed in PRIORITY.
    const hasPriorityObligation = entry.obligation_ids.some((id) =>
      prioritySet.has(id),
    );
    if (!hasPriorityObligation) continue;

    assert.ok(
      switchCases.has(entry.id),
      `EXECUTOR_REGISTRY entry "${entry.id}" has PRIORITY obligation(s) [${entry.obligation_ids.filter((id) => prioritySet.has(id)).join(", ")}] but has no explicit case in the advance.ts switch — it would silently fall through to the default branch`,
    );
  }
});
