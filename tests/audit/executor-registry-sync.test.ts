import { test, expect } from "vitest";

// Import from source via tsx loader so un-rebuilt changes are caught.
import { EXECUTOR_REGISTRY, isHostDelegationExecutor } from "../../src/audit/orchestrator/executors.js";
import { EXECUTOR_RUNNERS } from "../../src/audit/orchestrator/executorRunners.js";
import { PRIORITY } from "../../src/audit/orchestrator/nextStep.js";
import { buildAuditObligations } from "../../src/audit/cli/nextStepHelpers.js";

test("every PRIORITY obligation is covered by exactly one EXECUTOR_REGISTRY entry", () => {
  for (const obligationId of PRIORITY) {
    const matches = EXECUTOR_REGISTRY.filter((entry) =>
      entry.obligation_ids.includes(obligationId),
    );
    expect(matches.length, `PRIORITY obligation "${obligationId}" should be claimed by exactly one EXECUTOR_REGISTRY entry, got ${matches.length}: [${matches.map((e) => e.id).join(", ")}]`).toBe(1);
  }
});

test("every engine-dispatched PRIORITY obligation has an entry in the CLI fold's buildAuditObligations() array", () => {
  // The conversation-first `next-step` fold (runDeterministicForNextStep → advance)
  // scans exactly buildAuditObligations(); an id in PRIORITY but missing here is
  // silently skipped on the primary path (regression guard for the dropped
  // structure_decomposition_current obligation — doc-review D-56).
  //
  // Exception: friction_capture_current is intentionally NOT engine-dispatched — it
  // is absent from deriveAuditState and handled out-of-band by the friction close-out
  // Stop-hook (see executorRunners.ts: "retained for schema compatibility but
  // unreachable"), so it legitimately has no fold entry.
  const OUT_OF_BAND = new Set(["friction_capture_current"]);
  const foldIds = new Set(buildAuditObligations().map((o) => o.id));
  for (const obligationId of PRIORITY) {
    if (OUT_OF_BAND.has(obligationId)) continue;
    expect(foldIds.has(obligationId), `PRIORITY obligation "${obligationId}" is missing from buildAuditObligations() — the CLI next-step fold would skip past it`).toBe(true);
  }
});

// CP-NODE-14 (OBL-impl-block-148-contract): the REVERSE direction of the test
// above. `findFirstActionableObligation` treats PRIORITY as the authority on
// order AND membership — an obligation absent from it is never selected — so a
// registration that never reaches PRIORITY is not a slow path or a fallback, it
// is dead code that looks live at its definition site. The forward test cannot
// see that: it walks PRIORITY, so an id missing from PRIORITY is exactly what it
// never visits.
test("every buildAuditObligations() registration appears in PRIORITY (an unlisted one is unreachable)", () => {
  const prioritySet = new Set(PRIORITY);
  const unreachable = buildAuditObligations()
    .map((obligation) => obligation.id)
    .filter((id) => !prioritySet.has(id));

  expect(
    unreachable,
    "these obligations are registered in the CLI fold but absent from PRIORITY, so the engine's " +
      "ordered scan can never select them — either add them to PRIORITY or delete the registration",
  ).toEqual([]);
});

test("isHostDelegationExecutor recognizes the registered host-delegation executors", () => {
  expect(isHostDelegationExecutor("design_review_contract")).toBe(true);
  expect(isHostDelegationExecutor("design_review_conceptual")).toBe(true);
  expect(isHostDelegationExecutor("semantic_review_executor")).toBe(true);
  expect(isHostDelegationExecutor("intent_checkpoint_executor")).toBe(true);
  expect(isHostDelegationExecutor("synthesis_narrative_executor")).toBe(true);
  expect(isHostDelegationExecutor("intake_executor")).toBe(false);
  expect(isHostDelegationExecutor("synthesis_executor")).toBe(false);
  expect(isHostDelegationExecutor("planning_executor")).toBe(false);
  expect(isHostDelegationExecutor("unknown_executor")).toBe(false);
  // design_review no longer exists in registry
  expect(isHostDelegationExecutor("design_review")).toBe(false);
});

test("all EXECUTOR_REGISTRY entries have a valid kind field", () => {
  const hostDelegationIds = new Set([
    "critical_flow_fallback_executor",
    "charter_extraction_executor",
    "charter_delta_executor",
    "charter_clarification_executor",
    "systemic_challenge_executor",
    "design_review_contract",
    "design_review_conceptual",
    "intent_checkpoint_executor",
    "intent_equivalence_executor",
    "semantic_review_executor",
    "synthesis_narrative_executor",
  ]);
  for (const entry of EXECUTOR_REGISTRY) {
    expect(entry.kind === "deterministic" || entry.kind === "host_delegation", `EXECUTOR_REGISTRY entry "${entry.id}" has invalid kind: ${String(entry.kind)}`).toBeTruthy();
    if (hostDelegationIds.has(entry.id)) {
      expect(entry.kind, `EXECUTOR_REGISTRY entry "${entry.id}" should have kind "host_delegation"`).toBe("host_delegation");
    } else {
      expect(entry.kind, `EXECUTOR_REGISTRY entry "${entry.id}" should have kind "deterministic"`).toBe("deterministic");
    }
  }
  // Verify exactly these executors are host_delegation
  const hostEntries = EXECUTOR_REGISTRY.filter((e) => e.kind === "host_delegation");
  expect(hostEntries.map((e) => e.id).sort()).toEqual(["charter_clarification_executor", "charter_delta_executor", "charter_extraction_executor", "critical_flow_fallback_executor", "design_review_conceptual", "design_review_contract", "intent_checkpoint_executor", "intent_equivalence_executor", "semantic_review_executor", "synthesis_narrative_executor", "systemic_challenge_executor"]);
});

test("every registry executor with a PRIORITY obligation has the expected runner ownership", () => {
  const prioritySet = new Set(PRIORITY);
  // These host-owned steps are emitted and consumed by the conversation fold;
  // they must never have deterministic fallback runners.
  const HOST_OWNED_WITHOUT_RUNNER = new Set([
    "design_review_contract",
    "design_review_conceptual",
    "intent_checkpoint_executor",
    "semantic_review_executor",
  ]);

  for (const entry of EXECUTOR_REGISTRY) {
    const hasPriorityObligation = entry.obligation_ids.some((id) =>
      prioritySet.has(id),
    );
    if (!hasPriorityObligation) continue;

    const hasRunner = Object.hasOwn(EXECUTOR_RUNNERS, entry.id);
    if (HOST_OWNED_WITHOUT_RUNNER.has(entry.id)) {
      expect(!hasRunner, `host-owned executor "${entry.id}" must NOT have a deterministic runner in EXECUTOR_RUNNERS`).toBeTruthy();
    } else {
      expect(hasRunner, `EXECUTOR_REGISTRY entry "${entry.id}" has PRIORITY obligation(s) [${entry.obligation_ids.filter((id) => prioritySet.has(id)).join(", ")}] but no runner in EXECUTOR_RUNNERS — advanceAudit could not dispatch it`).toBeTruthy();
    }
  }
});
