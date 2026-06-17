import { describe, it, expect } from "vitest";
import {
  ITEM_STATUSES,
  isInProgressStatus,
  isTerminalStatus,
  isVerifiedCompleteStatus,
  isSkipStatus,
  statusToDisposition,
  dispositionToOutcomeStatus,
  type RemediationItemStatus,
} from "../src/state/itemStatus.js";
import type { PerFindingDisposition } from "../src/state/types.js";
import type { RemediationOutcomeStatus } from "@audit-tools/shared";

describe("itemStatus — canonical status enum", () => {
  it("enumerates the ten lifecycle statuses with no duplicates", () => {
    expect([...ITEM_STATUSES].sort()).toEqual([
      "blocked",
      "deemed_inappropriate",
      "ignored",
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
    blocked: "force_closed_unresolved",
    pending: "force_closed_unresolved",
    tested: "force_closed_unresolved",
    tested_successfully: "force_closed_unresolved",
    refactored: "force_closed_unresolved",
    verified: "force_closed_unresolved",
  };
  for (const status of ITEM_STATUSES) {
    it(`${status} → ${cases[status]}`, () => {
      expect(statusToDisposition(status)).toBe(cases[status]);
    });
  }
  it("unknown status falls back to force_closed_unresolved", () => {
    expect(statusToDisposition("not-a-status")).toBe("force_closed_unresolved");
  });
});

describe("itemStatus — dispositionToOutcomeStatus", () => {
  const cases: Record<PerFindingDisposition, RemediationOutcomeStatus> = {
    resolved: "resolved",
    resolved_no_change: "verified_no_change",
    ignored: "ignored",
    deemed_inappropriate: "inappropriate",
    force_closed_unresolved: "blocked",
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
    for (const s of ["ignored", "deemed_inappropriate", "blocked", "pending"]) {
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
  it("every status is in exactly one of {in-progress, verified-complete, skip, blocked}", () => {
    for (const status of ITEM_STATUSES) {
      const buckets = [
        isInProgressStatus(status),
        isVerifiedCompleteStatus(status),
        isSkipStatus(status),
        status === "blocked",
      ].filter(Boolean).length;
      expect(buckets, `status ${status} must be in exactly one bucket`).toBe(1);
    }
  });
  it("terminal is exactly verified-complete ∪ skip", () => {
    for (const status of ITEM_STATUSES) {
      expect(isTerminalStatus(status)).toBe(
        isVerifiedCompleteStatus(status) || isSkipStatus(status),
      );
    }
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
