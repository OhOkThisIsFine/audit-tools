import { describe, it, expect } from "vitest";
import {
  ITEM_STATUSES,
  isInProgressStatus,
  isTerminalStatus,
  isVerifiedCompleteStatus,
  isSkipStatus,
  isUnsuccessfulEndStatus,
  statusToDisposition,
  dispositionToOutcomeStatus,
  type RemediationItemStatus,
} from "../../src/remediate/state/itemStatus.js";
import type { PerFindingDisposition } from "../../src/remediate/state/types.js";
import type { RemediationOutcomeStatus } from "audit-tools/shared";

describe("itemStatus — canonical status enum", () => {
  it("enumerates the twelve lifecycle statuses with no duplicates", () => {
    expect([...ITEM_STATUSES].sort()).toEqual([
      "abandoned",
      "blocked",
      "deemed_inappropriate",
      "ignored",
      "needs_clarification",
      "pending",
      "refactored",
      "resolved",
      "resolved_no_change",
      "tested",
      "tested_successfully",
      "verified",
    ]);
    expect(new Set(ITEM_STATUSES).size).toBe(ITEM_STATUSES.length);
  });
});

describe("itemStatus — statusToDisposition", () => {
  const cases: Record<RemediationItemStatus, PerFindingDisposition> = {
    resolved: "resolved",
    resolved_no_change: "resolved_no_change",
    ignored: "ignored",
    deemed_inappropriate: "deemed_inappropriate",
    abandoned: "abandoned",
    blocked: "abandoned",
    needs_clarification: "abandoned",
    pending: "abandoned",
    tested: "abandoned",
    tested_successfully: "abandoned",
    refactored: "abandoned",
    verified: "abandoned",
  };
  for (const status of ITEM_STATUSES) {
    it(`${status} → ${cases[status]}`, () => {
      expect(statusToDisposition(status)).toBe(cases[status]);
    });
  }
  it("unknown status falls back to abandoned", () => {
    expect(statusToDisposition("not-a-status")).toBe("abandoned");
  });
});

describe("itemStatus — dispositionToOutcomeStatus", () => {
  const cases: Record<PerFindingDisposition, RemediationOutcomeStatus> = {
    resolved: "resolved",
    resolved_no_change: "verified_no_change",
    ignored: "ignored",
    deemed_inappropriate: "inappropriate",
    abandoned: "blocked",
  };
  for (const [disposition, outcome] of Object.entries(cases)) {
    it(`${disposition} → ${outcome}`, () => {
      expect(
        dispositionToOutcomeStatus(disposition as PerFindingDisposition),
      ).toBe(outcome);
    });
  }
});

describe("itemStatus — isInProgressStatus", () => {
  it("true only for the mid-flight statuses", () => {
    for (const s of [
      "pending",
      "tested",
      "tested_successfully",
      "refactored",
      "verified",
    ]) {
      expect(isInProgressStatus(s)).toBe(true);
    }
    for (const s of [
      "resolved",
      "resolved_no_change",
      "blocked",
      "needs_clarification",
      "deemed_inappropriate",
      "ignored",
    ]) {
      expect(isInProgressStatus(s)).toBe(false);
    }
  });
});

describe("itemStatus — isTerminalStatus", () => {
  it("terminal = the two success + two skip states; blocked and in-progress are NOT", () => {
    for (const s of [
      "resolved",
      "resolved_no_change",
      "ignored",
      "deemed_inappropriate",
    ]) {
      expect(isTerminalStatus(s)).toBe(true);
    }
    for (const s of [
      "blocked",
      "needs_clarification",
      "pending",
      "tested",
      "tested_successfully",
      "refactored",
      "verified",
    ]) {
      expect(isTerminalStatus(s)).toBe(false);
    }
  });
});

describe("itemStatus — isVerifiedCompleteStatus", () => {
  it("only resolved / resolved_no_change are verified-complete (INV-RS-01)", () => {
    expect(isVerifiedCompleteStatus("resolved")).toBe(true);
    expect(isVerifiedCompleteStatus("resolved_no_change")).toBe(true);
    for (const s of ["ignored", "deemed_inappropriate", "blocked", "needs_clarification", "pending"]) {
      expect(isVerifiedCompleteStatus(s)).toBe(false);
    }
    expect(isVerifiedCompleteStatus(undefined)).toBe(false);
  });
});

describe("itemStatus — isSkipStatus", () => {
  it("skip = ignored / deemed_inappropriate only", () => {
    expect(isSkipStatus("ignored")).toBe(true);
    expect(isSkipStatus("deemed_inappropriate")).toBe(true);
    for (const s of [
      "resolved",
      "resolved_no_change",
      "blocked",
      "needs_clarification",
      "pending",
      "verified",
    ]) {
      expect(isSkipStatus(s)).toBe(false);
    }
  });
});

// Structural invariant: the four predicates partition the status enum, and
// terminal is exactly verified-complete ∪ skip. Adding a status without
// classifying it (or mis-bucketing one) fails here.
describe("itemStatus — partition coherence", () => {
  it("every status is in exactly one of {in-progress, verified-complete, skip, blocked, needs_clarification, abandoned}", () => {
    for (const status of ITEM_STATUSES) {
      const buckets = [
        isInProgressStatus(status),
        isVerifiedCompleteStatus(status),
        isSkipStatus(status),
        status === "blocked",
        status === "needs_clarification",
        status === "abandoned",
      ].filter(Boolean).length;
      expect(buckets, `status ${status} must be in exactly one bucket`).toBe(1);
    }
  });
  it("terminal is exactly verified-complete ∪ skip ∪ {abandoned}", () => {
    // `abandoned` is terminal WITHOUT being verified-complete or a skip: the tool
    // gave up, which ends the item but is neither a success nor a settled decision
    // not to act. Keeping it out of the skip set is load-bearing — INV-RS-01 says a
    // SKIP never satisfies a dependency edge, and neither may an abandoned node.
    for (const status of ITEM_STATUSES) {
      expect(isTerminalStatus(status)).toBe(
        isVerifiedCompleteStatus(status) || isSkipStatus(status) || status === "abandoned",
      );
    }
  });
  it("abandoned is terminal but never verified-complete, never a skip, and blocks a green close", () => {
    // The invariant the `abandoned` status exists to restore: every item ends
    // terminal, so a run can never complete with an item that reached no end state.
    expect(isTerminalStatus("abandoned")).toBe(true);
    expect(isVerifiedCompleteStatus("abandoned")).toBe(false);
    expect(isSkipStatus("abandoned")).toBe(false);
    expect(isInProgressStatus("abandoned")).toBe(false);
    // Both non-success endings must keep a run from landing green with its
    // artifacts deleted; the green-close guard reads this predicate, so a force
    // close can never be mistaken for a clean one.
    expect(isUnsuccessfulEndStatus("abandoned")).toBe(true);
    expect(isUnsuccessfulEndStatus("blocked")).toBe(true);
    expect(isUnsuccessfulEndStatus("resolved")).toBe(false);
    expect(isUnsuccessfulEndStatus("ignored")).toBe(false);
  });
});

// Regression lock: the close phase derives its outcome as
// `isInProgressStatus(s) ? "blocked" : dispositionToOutcomeStatus(statusToDisposition(s))`.
// This table pins the exact status→outcome mapping the close phase used before
// the disposition vocabulary was single-sourced (the old OUTCOME_BY_STATUS map
// plus the force-close fallback), so any future drift in the chain is caught.
describe("itemStatus — close-phase outcome derivation (behavior lock)", () => {
  const expected: Record<RemediationItemStatus, RemediationOutcomeStatus> = {
    resolved: "resolved",
    resolved_no_change: "verified_no_change",
    deemed_inappropriate: "inappropriate",
    ignored: "ignored",
    blocked: "blocked",
    // The force-close seam converts non-terminal items to `abandoned`, which is
    // terminal and renders as the `blocked` outcome — so the wire contract the
    // close phase emits is unchanged by that seam moving.
    abandoned: "blocked",
    // needs_clarification → force-closed (if the run ends before the answer) → blocked
    needs_clarification: "blocked",
    // in-progress → force-closed → blocked
    pending: "blocked",
    tested: "blocked",
    tested_successfully: "blocked",
    refactored: "blocked",
    verified: "blocked",
  };
  for (const status of ITEM_STATUSES) {
    it(`${status} → ${expected[status]}`, () => {
      const outcome = isInProgressStatus(status)
        ? "blocked"
        : dispositionToOutcomeStatus(statusToDisposition(status));
      expect(outcome).toBe(expected[status]);
    });
  }
});
