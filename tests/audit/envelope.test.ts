import { test, expect } from "vitest";
import type { AuditState } from "../../src/audit/types/auditState.js";

const { buildManualReviewBlocker, buildBlockedAuditState } =
  await import("../../src/audit/cli/envelope.js");

test("buildManualReviewBlocker returns provider-neutral host handoff guidance", () => {
  const result = buildManualReviewBlocker();
  expect(result).toMatch(/host execution/);
  expect(result).toMatch(/bound work items/);
  expect(result).toMatch(/next-step/);
});

// ── buildBlockedAuditState ──────────────────────────────────────────────────

function makeState(overrides: Partial<AuditState> = {}): AuditState {
  return {
    status: "active",
    last_executor: "previous-executor",
    last_obligation: "previous-obligation",
    blockers: [],
    obligations: [
      { id: "ob-1", state: "missing" },
      { id: "ob-2", state: "present" },
    ],
    ...overrides,
  };
}

test("buildBlockedAuditState sets status to blocked and updates executor and obligation fields", () => {
  const state = makeState();
  const result = buildBlockedAuditState({
    state,
    obligationId: "ob-1",
    executor: "some-executor",
    blocker: "provider not configured",
  });
  expect(result.status).toBe("blocked");
  expect(result.last_executor).toBe("some-executor");
  expect(result.last_obligation).toBe("ob-1");
});

test("buildBlockedAuditState appends a new blocker to the blockers array", () => {
  const state = makeState({ blockers: ["existing-blocker"] });
  const result = buildBlockedAuditState({
    state,
    obligationId: "ob-1",
    executor: "some-executor",
    blocker: "new-blocker",
  });
  expect(result.blockers!.includes("new-blocker"), "new blocker is present").toBeTruthy();
  expect(result.blockers!.includes("existing-blocker"), "pre-existing blocker is preserved").toBeTruthy();
  expect(result.blockers!.length).toBe(2);
});

test("buildBlockedAuditState deduplicates repeated blockers", () => {
  const state = makeState({ blockers: ["duplicate-blocker"] });
  const result = buildBlockedAuditState({
    state,
    obligationId: "ob-1",
    executor: "some-executor",
    blocker: "duplicate-blocker",
  });
  expect(result.blockers!.length).toBe(1);
  expect(result.blockers![0]).toBe("duplicate-blocker");
});

test("buildBlockedAuditState patches the matching obligation's state and reason", () => {
  const state = makeState();
  const result = buildBlockedAuditState({
    state,
    obligationId: "ob-1",
    executor: "some-executor",
    blocker: "missing provider",
  });
  const matched = result.obligations.find((o) => o.id === "ob-1");
  expect(matched!.state).toBe("blocked");
  expect(matched!.reason).toBe("missing provider");
});

test("buildBlockedAuditState leaves non-matching obligations unchanged", () => {
  const state = makeState();
  const result = buildBlockedAuditState({
    state,
    obligationId: "ob-1",
    executor: "some-executor",
    blocker: "missing provider",
  });
  const untouched = result.obligations.find((o) => o.id === "ob-2");
  expect(untouched!.state).toBe("present");
  expect(untouched!.reason).toBe(undefined);
});

test("buildBlockedAuditState falls back to state.last_executor when executor param is null", () => {
  const state = makeState({ last_executor: "original-executor" });
  const result = buildBlockedAuditState({
    state,
    obligationId: "ob-1",
    executor: null,
    blocker: "some blocker",
  });
  expect(result.last_executor).toBe("original-executor");
});
