import { test, expect, describe } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";

// Import the .ts sources so gateHostFanout and setQuotaStateDir share the SAME
// quota-state module singleton (mixing dist + src would give each its own
// quota-state-dir slot and the sandbox dir wouldn't be seen).
const { gateHostFanout, reconcileHostFanoutLeases, hostFanoutQuotaPath } =
  await import("../../src/audit/cli/dispatch/hostFanoutGate.ts");
const { admitBatch } = await import("../../src/shared/dispatch/admissionLoop.ts");
const {
  ReservationLedger,
  getReservationLedgerPath,
} = await import("../../src/shared/quota/reservationLedger.ts");
const { setQuotaStateDir, writeQuotaState } = await import(
  "../../src/shared/quota/state.ts"
);

async function tmp(prefix) {
  return await mkdtemp(join(tmpdir(), prefix));
}
function units(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: `u${i + 1}`,
    estInputBytes: 4000,
  }));
}

describe("gateHostFanout — item C host fan-out quota gate", () => {
  test("blind host grants the whole panel (no cold-start livelock) and leases it at the namespaced path", async () => {
    const dir = await tmp("host-fanout-gate-");
    setQuotaStateDir(await tmp("host-fanout-state-"));
    try {
      const outcome = await gateHostFanout({
        artifactsDir: dir,
        sessionConfig: {},
        family: "design_review",
        units: units(5),
      });
      // A 5-perspective panel must grant WHOLE — the cold-start calibration probe
      // would clamp it to a partial grant and the atomic panel could never dispatch.
      expect(outcome.atWall).toBe(false);
      expect(outcome.grantedCount).toBe(5);
      expect(outcome.requiredCount).toBe(5);
      const quotaPath = hostFanoutQuotaPath(dir, "design_review");
      expect(existsSync(quotaPath)).toBe(true);
      const quota = JSON.parse(await readFile(quotaPath, "utf8"));
      expect(quota.admission.leases.length).toBe(5);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("fan-out mode ignores the host concurrency cap — a 5-panel grants fully even at active_subagents=2", async () => {
    // The concurrency cap governs how many subagents run in parallel, not whether
    // the panel is affordable; the host serializes past its cap. fanoutMode drops
    // the declared cap so a concurrency shortfall never walls the panel.
    const dir = await tmp("host-fanout-cap-");
    setQuotaStateDir(await tmp("host-fanout-state-"));
    try {
      const outcome = await gateHostFanout({
        artifactsDir: dir,
        sessionConfig: {},
        family: "design_review",
        units: units(5),
        hostActiveSubagentLimit: 2,
      });
      expect(outcome.atWall).toBe(false);
      expect(outcome.grantedCount).toBe(5);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an active cooldown walls the panel — atWall with the reset time, leases released", async () => {
    const dir = await tmp("host-fanout-wall-");
    const stateDir = await tmp("host-fanout-state-");
    setQuotaStateDir(stateDir);
    const resetAt = new Date(Date.now() + 60 * 60_000).toISOString();
    // Pin the provider so the pool key is deterministic (claude-code/*), then seed a
    // live cooldown on that key so the wave sees an active cooldown wall.
    await writeQuotaState({
      version: 2,
      entries: {
        "claude-code/*": {
          updated_at: new Date().toISOString(),
          cooldown_until: resetAt,
          last_429_at: null,
        },
      },
    });
    try {
      const outcome = await gateHostFanout({
        artifactsDir: dir,
        sessionConfig: { provider: "claude-code" },
        family: "design_review",
        units: units(5),
      });
      expect(outcome.atWall).toBe(true);
      expect(outcome.reason).toBe("cooldown");
      expect(outcome.earliestResetAt).toBe(resetAt);
      // Pausing skips the ingest reconcile, so the gate must release the leases it
      // reserved before returning at-wall — no lingering leases until the TTL.
      const ledger = new ReservationLedger(getReservationLedgerPath());
      const held = Object.values(await ledger.snapshot()).flat().length;
      expect(held).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a large-prompt panel is NOT context-fit-walled on a blind host (fanout relaxes the capability gate)", async () => {
    // Regression for the capability-fit livelock: a unit whose estimated cost exceeds
    // the tool's conservative blind context default (32k tokens) must still grant —
    // the host runs it on its own model window; there is no alternative pool to route
    // to, so a context-fit block would permanently wall a panel the host can run.
    const dir = await tmp("host-fanout-big-");
    setQuotaStateDir(await tmp("host-fanout-state-"));
    try {
      const outcome = await gateHostFanout({
        artifactsDir: dir,
        sessionConfig: {},
        family: "design_review",
        // ~600KB prompt ⇒ well over the 32k-token blind context default.
        units: [{ id: "big", estInputBytes: 600_000 }],
      });
      expect(outcome.atWall).toBe(false);
      expect(outcome.grantedCount).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("re-gating a family reconciles the prior grant's leases — no accumulation / leak", async () => {
    const dir = await tmp("host-fanout-regate-");
    setQuotaStateDir(await tmp("host-fanout-state-"));
    try {
      await gateHostFanout({
        artifactsDir: dir,
        sessionConfig: {},
        family: "design_review",
        units: units(3),
      });
      const ledger = new ReservationLedger(getReservationLedgerPath());
      const afterFirst = Object.values(await ledger.snapshot()).flat().length;
      expect(afterFirst).toBe(3);

      // The host re-runs next-step before ingest (obligation still derives) → the gate
      // runs again. Without reconcile-before-grant the first 3 leases would orphan and
      // accumulate; with it, only the fresh grant's 3 remain.
      await gateHostFanout({
        artifactsDir: dir,
        sessionConfig: {},
        family: "design_review",
        units: units(3),
      });
      const afterSecond = Object.values(await ledger.snapshot()).flat().length;
      expect(afterSecond).toBe(3);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("reconcileHostFanoutLeases frees the panel's leases after ingest and is idempotent / absent-tolerant", async () => {
    const dir = await tmp("host-fanout-recon-");
    const stateDir = await tmp("host-fanout-state-");
    setQuotaStateDir(stateDir);
    try {
      await gateHostFanout({
        artifactsDir: dir,
        sessionConfig: {},
        family: "systemic_challenge",
        units: units(1),
      });
      const quotaPath = hostFanoutQuotaPath(dir, "systemic_challenge");
      const before = JSON.parse(await readFile(quotaPath, "utf8"));
      expect(before.admission.leases.length).toBe(1);

      const ledger = new ReservationLedger(getReservationLedgerPath());
      const held = Object.values(await ledger.snapshot()).flat().length;
      expect(held).toBeGreaterThanOrEqual(1);

      await reconcileHostFanoutLeases(dir, "systemic_challenge");
      const freed = Object.values(await ledger.snapshot()).flat().length;
      expect(freed).toBe(0);

      // A second reconcile, and one for a family that never dispatched, are no-ops.
      await reconcileHostFanoutLeases(dir, "systemic_challenge");
      await reconcileHostFanoutLeases(dir, "design_review");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("host fan-out livelock guard (admission mechanism)", () => {
  test("a calibrating pool with a declared cap partial-grants a 5-panel — the livelock the fanout override avoids", async () => {
    const packets = Array.from({ length: 5 }, (_, i) => ({
      id: `p${i + 1}`,
      cost: 4000,
      complexity: 1,
    }));
    const basePool = {
      poolId: "claude-code/*",
      resourceKey: "claude-code/*",
      budget: Infinity,
      declaredCap: 2,
      costRank: 0,
      capabilityRank: 0,
      capabilityScore: null,
      throughputConcurrency: Infinity,
      capacityTokens: Infinity,
      calibrating: true,
    };

    // As the packet path would admit it: calibrating cold-start clamp + declared cap
    // ⇒ a partial grant, which for an ATOMIC panel is a perpetual pause.
    const clampedDir = await tmp("fanout-admit-clamp-");
    const clamped = await admitBatch({
      packets,
      pools: [basePool],
      ledger: new ReservationLedger(join(clampedDir, "reservations.json")),
    });
    expect(clamped.granted.length).toBeLessThan(5);

    // The fanoutMode override (calibrating:false + declaredCap:null) grants the whole
    // panel — budget-only gating, so the atomic panel dispatches.
    const fanoutDir = await tmp("fanout-admit-full-");
    const full = await admitBatch({
      packets,
      pools: [{ ...basePool, calibrating: false, declaredCap: null }],
      ledger: new ReservationLedger(join(fanoutDir, "reservations.json")),
    });
    expect(full.granted.length).toBe(5);
  });
});
