import { test, expect } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { captureCreditExhaustionFriction, stepBoundaryEventId } = await import(
  "../../src/shared/friction/stepBoundaryCapture.ts"
);
const { frictionCapturePath } = await import(
  "../../src/shared/io/frictionCapture.ts"
);

/**
 * Slice A2 (backlog HIGH, 2026-07-11 live run) — credit-exhaustion graceful
 * degrade. captureCreditExhaustionFriction single-sources the onCreditExhausted
 * template both audit's rollingAuditDispatch.ts and remediate's nextStep.ts
 * fire — identical eventType/severity/area/note apart from the trailing source
 * tool tag, mirroring captureCostDriftFriction's pattern (tests/shared/cost-drift-friction.test.mjs).
 */

async function readRecord(dir, runId) {
  return JSON.parse(await readFile(frictionCapturePath(dir, runId), "utf8"));
}

// Fire-and-forget (returns void, not the underlying promise), so the test
// polls for the write to land instead of assuming a fixed delay is enough.
async function waitForFrictionCount(dir, runId, count, timeoutMs = 2000) {
  const start = Date.now();
  for (;;) {
    try {
      const raw = await readRecord(dir, runId);
      if (raw.frictions.length >= count) return raw;
    } catch {
      // File not written yet — keep polling.
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for ${count} friction record(s) in ${dir}/${runId}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("captureCreditExhaustionFriction records a credit_exhausted fact naming the pool + matched text", async () => {
  const dir = await mkdtemp(join(tmpdir(), "credit-exhausted-"));
  try {
    captureCreditExhaustionFriction(
      dir,
      "run-1",
      { poolId: "nim-deep", rawMatch: "credit balance is too low" },
      "audit-code",
    );
    const raw = await waitForFrictionCount(dir, "run-1", 1);
    expect(raw.frictions.length).toBe(1);
    const [item] = raw.frictions;
    expect(item.id).toBe(stepBoundaryEventId("credit_exhausted", "run-1", "nim-deep"));
    expect(item.note).toContain('pool "nim-deep" is out of prepaid usage credits');
    expect(item.note).toContain('matched: "credit balance is too low"');
    expect(item.note).toContain("no reset timer");
    expect(item.severity).toBe("high");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("captureCreditExhaustionFriction tolerates a null rawMatch (JSON-code-only detection)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "credit-exhausted-null-"));
  try {
    captureCreditExhaustionFriction(dir, "run-1", { poolId: "pool-x", rawMatch: null }, "remediate-code");
    const raw = await waitForFrictionCount(dir, "run-1", 1);
    expect(raw.frictions[0].note).toContain('pool "pool-x" is out of prepaid usage credits');
    expect(raw.frictions[0].note).not.toContain("matched:");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("captureCreditExhaustionFriction from audit-code and remediate-code use the identical template (differ only by source tool)", async () => {
  const dirA = await mkdtemp(join(tmpdir(), "credit-exhausted-audit-"));
  const dirR = await mkdtemp(join(tmpdir(), "credit-exhausted-remediate-"));
  try {
    const info = { poolId: "shared-pool", rawMatch: "insufficient credits" };
    captureCreditExhaustionFriction(dirA, "run-x", info, "audit-code");
    captureCreditExhaustionFriction(dirR, "run-x", info, "remediate-code");

    const rawA = await waitForFrictionCount(dirA, "run-x", 1);
    const rawR = await waitForFrictionCount(dirR, "run-x", 1);
    expect(rawA.frictions[0].note).toBe(rawR.frictions[0].note);
    expect(rawA.frictions[0].severity).toBe(rawR.frictions[0].severity);
    expect(rawA.tool).toBe("audit-code");
    expect(rawR.tool).toBe("remediate-code");
  } finally {
    await rm(dirA, { recursive: true, force: true });
    await rm(dirR, { recursive: true, force: true });
  }
});

test("captureCreditExhaustionFriction is fire-and-forget: returns void synchronously, never a Promise", () => {
  const result = captureCreditExhaustionFriction(
    "\0not-a-dir",
    "run-1",
    { poolId: "p", rawMatch: "x" },
    "remediate-code",
  );
  expect(result).toBeUndefined();
});
