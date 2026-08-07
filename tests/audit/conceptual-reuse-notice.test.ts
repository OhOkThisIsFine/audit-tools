/**
 * Tests for renderReuseNotice helper (TST-4c8bd93a-3).
 * This test file covers the reuse notice generation for conceptual dispatch.
 */

import { test, expect } from "vitest";
import { renderReuseNotice } from "../../src/audit/cli/conceptualDispatch.js";
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
