/**
 * Tests for renderReuseNotice helper (TST-4c8bd93a-3).
 * This test file covers the reuse notice generation for conceptual dispatch.
 */

import { test, expect } from "vitest";
import {
  renderReuseNotice,
  resolveConceptualReviewSettings,
} from "../../src/audit/cli/conceptualDispatch.js";
import type { IntentCheckpoint } from "audit-tools/shared";

test("renderReuseNotice: basic case with all fields", () => {
  const checkpoint: NonNullable<IntentCheckpoint["design_review"]> = {
    conceptual_depth: "deep",
    perspectives: 3,
  };
  const result = renderReuseNotice(checkpoint, "2026-08-06T10:30:00Z", { include: ["correctness"], exclude: ["performance"] }, "shallow");
  expect(result).toContain("2026-08-06T10:30:00Z");
  expect(result).toContain("correctness");
  expect(result).toContain("performance");
  expect(result).toContain("deep");
});

test("renderReuseNotice: degradation on missing confirmed_at", () => {
  const checkpoint: NonNullable<IntentCheckpoint["design_review"]> = {
    conceptual_depth: "shallow",
    perspectives: 1,
  };
  const result = renderReuseNotice(checkpoint, undefined, {}, "deep");
  expect(result).toContain("unknown");
  expect(result).toContain("all lenses");
});

test("renderReuseNotice: empty confirmed_at falls back to unknown", () => {
  const checkpoint: NonNullable<IntentCheckpoint["design_review"]> = {
    conceptual_depth: "deep",
    perspectives: 2,
  };
  const result = renderReuseNotice(checkpoint, "", { include: ["maintainability"] }, "shallow");
  expect(result).toContain("unknown");
  expect(result).toContain("maintainability");
});

test("renderReuseNotice: sorted lens inclusion and exclusion", () => {
  const checkpoint: NonNullable<IntentCheckpoint["design_review"]> = {
    conceptual_depth: "shallow",
    perspectives: 1,
  };
  const result = renderReuseNotice(
    checkpoint,
    "2026-08-06T10:30:00Z",
    { include: ["security", "correctness", "architecture"], exclude: ["performance", "maintainability"] },
    "shallow"
  );
  // Lenses should be sorted alphabetically in the output
  expect(result).toContain("+architecture,correctness,security");
  expect(result).toContain("-maintainability,performance");
});

test("renderReuseNotice: only include lenses", () => {
  const checkpoint: NonNullable<IntentCheckpoint["design_review"]> = {
    conceptual_depth: "deep",
    perspectives: 3,
  };
  const result = renderReuseNotice(checkpoint, "2026-08-06T10:30:00Z", { include: ["tests", "reliability"] }, "deep");
  expect(result).toContain("+reliability,tests");
  expect(result).not.toContain(" -");
});

test("renderReuseNotice: only exclude lenses", () => {
  const checkpoint: NonNullable<IntentCheckpoint["design_review"]> = {
    conceptual_depth: "shallow",
    perspectives: 1,
  };
  const result = renderReuseNotice(checkpoint, "2026-08-06T10:30:00Z", { exclude: ["operability"] }, "shallow");
  expect(result).toContain("-operability");
  expect(result).not.toContain("+");
  expect(result).not.toContain("all lenses"); // an exclusion filter IS a lens filter — "all lenses" renders only when both lists are empty
});

test("renderReuseNotice: checkpoint depth used when present", () => {
  const checkpoint: NonNullable<IntentCheckpoint["design_review"]> = {
    conceptual_depth: "deep",
    perspectives: 5,
  };
  const result = renderReuseNotice(checkpoint, "2026-08-06T10:30:00Z", {}, "shallow");
  expect(result).toContain("conceptual depth deep");
  expect(result).not.toContain("shallow");
});

test("renderReuseNotice: fallback to resolvedDepth when checkpoint depth absent", () => {
  const checkpoint: NonNullable<IntentCheckpoint["design_review"]> = {
    perspectives: 2,
  };
  const result = renderReuseNotice(checkpoint, "2026-08-06T10:30:00Z", {}, "deep");
  expect(result).toContain("conceptual depth deep");
});

// INV 11 (audit-artifact-promotion-lifecycle): the CONSUMER-ENTRY-POINT leg.
//
// conceptualDispatch reads two NESTED bundle paths by name —
// `intent_checkpoint.design_review` and `charter_register.subsystems[].charters`.
// The typechecker covers a rename within one build; it cannot see a bundle
// written in one phase and read back in another, which is exactly the position
// this consumer is in. So the entry point is driven here and both paths are
// asserted to resolve, alongside the field-set pin in io-remediation.test.ts.
test("INV 11: resolveConceptualReviewSettings resolves both nested bundle paths it reads by name", () => {
  const bundle = {
    intent_checkpoint: {
      schema_version: "intent-checkpoint/v1",
      confirmed_at: "2026-08-20T00:00:00Z",
      design_review: { conceptual_depth: "deep", perspectives: 2 },
    },
    charter_register: {
      schema_version: "charter-register/v3",
      subsystems: [
        { name: "s", charters: [{ id: "c", confidence: "low" }] },
      ],
    },
  } as never;

  const settings = resolveConceptualReviewSettings(bundle);

  // Resolved through intent_checkpoint.design_review: a rename of that path
  // would silently drop the depth back to its "shallow" default.
  expect(
    settings.conceptual_depth,
    "conceptualDispatch reads intent_checkpoint.design_review.conceptual_depth by name",
  ).toBe("deep");
  expect(settings.perspectives).toBe(2);
  // Resolved through charter_register.subsystems[].charters: the low-confidence
  // charter must reach charterReviewDisposition. A rename of that path would
  // leave this undefined and silently stop flagging for a human.
  expect(
    settings.flag_for_human,
    "conceptualDispatch reads charter_register.subsystems[].charters by name",
  ).toBe(true);
  // And the notice derives from the same checkpoint, so its presence is a third
  // witness that the nested read resolved.
  expect(settings.reuse_notice).toBeDefined();
});
