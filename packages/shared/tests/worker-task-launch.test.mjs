import test from "node:test";
import assert from "node:assert/strict";

const { resolveWorkerTaskTimeoutMs, applyWorkerTaskLaunchSettings } =
  await import("../dist/providers/workerTaskLaunch.js");

test("resolveWorkerTaskTimeoutMs prefers a positive task timeout", () => {
  assert.equal(resolveWorkerTaskTimeoutMs({ timeout_ms: 9000 }, 1000), 9000);
  assert.equal(resolveWorkerTaskTimeoutMs({ timeout_ms: 1500.7 }, 1000), 1500);
});

test("resolveWorkerTaskTimeoutMs falls back for missing or invalid timeouts", () => {
  assert.equal(resolveWorkerTaskTimeoutMs({}, 1000), 1000);
  assert.equal(resolveWorkerTaskTimeoutMs({ timeout_ms: 0 }, 1000), 1000);
  assert.equal(resolveWorkerTaskTimeoutMs({ timeout_ms: -5 }, 1000), 1000);
  assert.equal(
    resolveWorkerTaskTimeoutMs({ timeout_ms: Number.NaN }, 1000),
    1000,
  );
});

test("applyWorkerTaskLaunchSettings overrides only timeoutMs", () => {
  const input = { repoRoot: "/r", runId: "x", timeoutMs: 1000 };
  const withTaskTimeout = applyWorkerTaskLaunchSettings(input, {
    timeout_ms: 7000,
  });
  assert.equal(withTaskTimeout.timeoutMs, 7000);
  assert.equal(withTaskTimeout.repoRoot, "/r");
  assert.equal(withTaskTimeout.runId, "x");
  // Original input is not mutated.
  assert.equal(input.timeoutMs, 1000);
  // No task timeout → input timeout retained.
  assert.equal(applyWorkerTaskLaunchSettings(input, {}).timeoutMs, 1000);
});
