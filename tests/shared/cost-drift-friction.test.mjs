import { test, expect } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { captureCostDriftFriction, stepBoundaryEventId } = await import(
  "../../src/shared/friction/stepBoundaryCapture.ts"
);
const { frictionCapturePath } = await import(
  "../../src/shared/io/frictionCapture.ts"
);

/**
 * Tier C: captureCostDriftFriction single-sources the onCostDrift template both
 * audit's rollingAuditDispatch.ts and remediate's nextStep.ts fire — identical
 * eventType/severity/area/note apart from the trailing source tool tag.
 */

async function readRecord(dir, runId) {
  return JSON.parse(await readFile(frictionCapturePath(dir, runId), "utf8"));
}

// captureCostDriftFriction is intentionally fire-and-forget (returns void, not
// the underlying promise — matching the `void captureStepBoundaryFriction(...)`
// pattern it replaces at both call sites), so the test polls for the write to
// land instead of assuming a fixed delay is enough.
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

test("captureCostDriftFriction records a declared_cost_drift fact with the shared note template", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cost-drift-"));
  try {
    captureCostDriftFriction(
      dir,
      "run-1",
      { poolId: "nim-free", observedCostUsd: 0.42, declaredCostPerMtok: 0 },
      "audit-code",
    );
    const raw = await waitForFrictionCount(dir, "run-1", 1);
    expect(raw.frictions.length).toBe(1);
    const [item] = raw.frictions;
    expect(item.id).toBe(stepBoundaryEventId("declared_cost_drift", "run-1", "nim-free"));
    expect(item.note).toContain('pool "nim-free" was declared free (cost_per_mtok=0)');
    expect(item.note).toContain("reported cost=0.42");
    expect(item.severity).toBe("medium");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("captureCostDriftFriction from audit-code and remediate-code use the identical template (differ only by source tool)", async () => {
  const dirA = await mkdtemp(join(tmpdir(), "cost-drift-audit-"));
  const dirR = await mkdtemp(join(tmpdir(), "cost-drift-remediate-"));
  try {
    const info = { poolId: "shared-pool", observedCostUsd: 1.5, declaredCostPerMtok: 0 };
    captureCostDriftFriction(dirA, "run-x", info, "audit-code");
    captureCostDriftFriction(dirR, "run-x", info, "remediate-code");

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

test("captureCostDriftFriction is fire-and-forget: returns void synchronously, never a Promise", () => {
  const result = captureCostDriftFriction(
    "\0not-a-dir",
    "run-1",
    { poolId: "p", observedCostUsd: 1, declaredCostPerMtok: 0 },
    "remediate-code",
  );
  expect(result).toBeUndefined();
});
