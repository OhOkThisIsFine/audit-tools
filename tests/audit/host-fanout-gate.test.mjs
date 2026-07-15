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
const { stampDesignReviewSkipped, stampSystemicChallengeSkipped } = await import(
  "../../src/audit/cli/nextStepHelpers.ts"
);
const { readDesignReviewSnapshot, isDesignReviewStale } = await import(
  "../../src/audit/orchestrator/designReviewSnapshot.ts"
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

describe("gateHostFanout — livelock → skip (Increment 2)", () => {
  test("a persistent wall flips to livelocked once the pause bound is reached", async () => {
    const dir = await tmp("host-fanout-livelock-");
    setQuotaStateDir(await tmp("host-fanout-state-"));
    const resetAt = new Date(Date.now() + 60 * 60_000).toISOString();
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
      const flags = [];
      // Same artifactsDir across passes ⇒ the family's pause.json counter persists.
      for (let i = 0; i < 4; i++) {
        const outcome = await gateHostFanout({
          artifactsDir: dir,
          sessionConfig: { provider: "claude-code" },
          family: "design_review",
          units: units(5),
        });
        expect(outcome.atWall).toBe(true);
        flags.push(outcome.livelocked);
      }
      // LIVELOCK_PAUSE_LIMIT = 3: passes 1-3 pause (counter 0,1,2), the 4th trips the
      // guard (nextCount 3 ≥ 3) → livelocked, so the caller skips the enrichment.
      expect(flags).toEqual([false, false, false, true]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a cleared wall resets the pause counter (no premature skip after transient walls)", async () => {
    const dir = await tmp("host-fanout-reset-");
    const stateDir = await tmp("host-fanout-state-");
    setQuotaStateDir(stateDir);
    const cooldownEntries = {
      "claude-code/*": {
        updated_at: new Date().toISOString(),
        cooldown_until: new Date(Date.now() + 60 * 60_000).toISOString(),
        last_429_at: null,
      },
    };
    try {
      // Two walled passes (counter → 0, 1)…
      await writeQuotaState({ version: 2, entries: cooldownEntries });
      await gateHostFanout({ artifactsDir: dir, sessionConfig: { provider: "claude-code" }, family: "design_review", units: units(5) });
      await gateHostFanout({ artifactsDir: dir, sessionConfig: { provider: "claude-code" }, family: "design_review", units: units(5) });
      // …then the wall clears (counter reset)…
      await writeQuotaState({ version: 2, entries: {} });
      const cleared = await gateHostFanout({ artifactsDir: dir, sessionConfig: { provider: "claude-code" }, family: "design_review", units: units(5) });
      expect(cleared.atWall).toBe(false);
      // …so a fresh wall starts counting from zero — not immediately livelocked.
      await writeQuotaState({ version: 2, entries: cooldownEntries });
      const first = await gateHostFanout({ artifactsDir: dir, sessionConfig: { provider: "claude-code" }, family: "design_review", units: units(5) });
      expect(first.atWall).toBe(true);
      expect(first.livelocked).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("fan-out skip stamps (Increment 2)", () => {
  test("stampDesignReviewSkipped satisfies both review passes", async () => {
    const dir = await tmp("skip-design-");
    try {
      await stampDesignReviewSkipped(dir, { repo_manifest: { files: [] } });
      const assessment = JSON.parse(
        await readFile(join(dir, "design_assessment.json"), "utf8"),
      );
      expect(assessment.contract_reviewed).toBe(true);
      expect(assessment.conceptual_reviewed).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("stampDesignReviewSkipped STICKS — both passes non-stale on the next derive even when design_assessment was absent", async () => {
    // The self-restale trap: an absent design_assessment projects to null, but the
    // stamp writes findings:[]. Snapshotting the input bundle would record null and
    // re-stale against the reloaded [] next pass. This asserts the skip sticks in one
    // cycle by snapshotting the just-written assessment.
    const dir = await tmp("skip-design-stick-");
    try {
      const inputBundle = { repo_manifest: { files: [] } }; // no design_assessment
      await stampDesignReviewSkipped(dir, inputBundle);
      const writtenDA = JSON.parse(
        await readFile(join(dir, "design_assessment.json"), "utf8"),
      );
      // The next derive reloads design_assessment (findings:[]) into the bundle.
      const nextBundle = { ...inputBundle, design_assessment: writtenDA };
      for (const pass of ["contract", "conceptual"]) {
        const snapshot = await readDesignReviewSnapshot(dir, pass);
        expect(snapshot, `snapshot for ${pass} must exist`).toBeTruthy();
        expect(
          isDesignReviewStale(snapshot, nextBundle),
          `${pass} pass must read non-stale so the skip sticks`,
        ).toBe(false);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("stampSystemicChallengeSkipped converges the loop", async () => {
    const dir = await tmp("skip-systemic-");
    try {
      await stampSystemicChallengeSkipped(dir, {});
      const register = JSON.parse(
        await readFile(join(dir, "systemic_challenge.json"), "utf8"),
      );
      expect(register.converged).toBe(true);
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
