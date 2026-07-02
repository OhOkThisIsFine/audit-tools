import { test, expect } from "vitest";

const { resolveWorkerTaskTimeoutMs, applyWorkerTaskLaunchSettings } =
  await import("../../src/shared/providers/workerTaskLaunch.ts");

test("resolveWorkerTaskTimeoutMs prefers a positive task timeout", () => {
  expect(resolveWorkerTaskTimeoutMs({ timeout_ms: 9000 }, 1000)).toBe(9000);
  expect(resolveWorkerTaskTimeoutMs({ timeout_ms: 1500.7 }, 1000)).toBe(1500);
});

test("resolveWorkerTaskTimeoutMs falls back for missing or invalid timeouts", () => {
  expect(resolveWorkerTaskTimeoutMs({}, 1000)).toBe(1000);
  expect(resolveWorkerTaskTimeoutMs({ timeout_ms: 0 }, 1000)).toBe(1000);
  expect(resolveWorkerTaskTimeoutMs({ timeout_ms: -5 }, 1000)).toBe(1000);
  expect(resolveWorkerTaskTimeoutMs({ timeout_ms: Number.NaN }, 1000)).toBe(1000);
  // Infinity is non-finite, so the guard rejects it and returns fallbackMs.
  expect(resolveWorkerTaskTimeoutMs({ timeout_ms: Infinity }, 1000)).toBe(1000);
});

test("applyWorkerTaskLaunchSettings overrides only timeoutMs", () => {
  const input = { repoRoot: "/r", runId: "x", timeoutMs: 1000 };
  const withTaskTimeout = applyWorkerTaskLaunchSettings(input, {
    timeout_ms: 7000,
  });
  expect(withTaskTimeout.timeoutMs).toBe(7000);
  expect(withTaskTimeout.repoRoot).toBe("/r");
  expect(withTaskTimeout.runId).toBe("x");
  // Original input is not mutated.
  expect(input.timeoutMs).toBe(1000);
  // No task timeout → input timeout retained.
  expect(applyWorkerTaskLaunchSettings(input, {}).timeoutMs).toBe(1000);
});
