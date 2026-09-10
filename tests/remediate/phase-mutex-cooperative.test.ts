import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, utimes } from "node:fs/promises";
import { join } from "node:path";
import { decideNextStep } from "../../src/remediate/steps/nextStep.js";
import { withFileLock, STALE_LOCK_MS } from "../../src/shared/io/fileLock.js";
import { StateStore } from "../../src/remediate/state/store.js";
import { createNextStepHarness, makePlanningState } from "./helpers/nextStepHarness.js";

// Slice 4 (spec/multi-ide-concurrent-runs-design.md): the phase mutex serializes
// the in-process serial state-machine advance so two joining agents never run the
// same serial phase and clobber state.json.
const harness = createNextStepHarness(".test-phase-mutex-coop");
const { REPO_DIR, ARTIFACTS_DIR, saveState, acknowledgeResume, writeIntentCheckpoint } = harness;

// Get an established planning run past the pre-intake gates so decideNextStep
// reaches the MAIN advance (where the phase mutex lives).
async function establishPlanningRun(): Promise<void> {
  await saveState(makePlanningState()); // plan_id PLAN-1, status planning
  await writeIntentCheckpoint();
  await acknowledgeResume();
}

beforeEach(async () => {
  await harness.resetTestRepo();
});
afterEach(async () => {
  await harness.cleanupTestRepo();
});

describe("cooperative phase mutex", () => {
  it("yields a phase_busy step (without advancing state) when a peer holds phase:main", async () => {
    await establishPlanningRun();

    // A peer holds the repo-level remediation phase mutex live.
    let signalAcquired!: () => void;
    let releasePeer!: () => void;
    const acquired = new Promise<void>((resolve) => {
      signalAcquired = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releasePeer = resolve;
    });
    const held = withFileLock(join(ARTIFACTS_DIR, "phase.lock"), async () => {
      signalAcquired();
      await release;
    });
    await acquired;

    const step = await decideNextStep({ root: REPO_DIR });
    releasePeer();
    await held;

    expect(step.step_kind).toBe("phase_busy");
    expect(step.status).toBe("ready");
    expect(step.run_id).toBe("PLAN-1");

    // The contended call must NOT have advanced the run — still planning.
    const state = await new StateStore(ARTIFACTS_DIR).loadState();
    expect(state?.status).toBe("planning");
  });

  it("advances normally (no phase_busy) when the mutex is free", async () => {
    await establishPlanningRun();
    const step = await decideNextStep({ root: REPO_DIR });
    // Whatever the planning step resolves to, it is NOT the cooperative-wait.
    expect(step.step_kind).not.toBe("phase_busy");
  });

  // ── A DEAD HOLDER'S LOCK IS NOT A PERMANENT WEDGE ─────────────────────────
  //
  // `PHASE_LOCK_TIMEOUT_MS = 0` makes the acquirer non-blocking: it must not
  // WAIT for a peer. The stale-steal check used to live inside the wait loop and
  // sit AFTER the deadline check, so this acquirer never reached it — a
  // phase.lock left behind by a killed process (observed: a next-step killed by
  // a shell timeout) bounced every later call forever and the operator had to
  // verify the dead pid and delete the lock by hand. The scan now runs before
  // the deadline check, so the FIRST and only iteration still recovers.

  it("steals a stale phase.lock on a zero-timeout acquire instead of bouncing forever", async () => {
    await establishPlanningRun();
    const lockFile = join(ARTIFACTS_DIR, "phase.lock");
    // The dead holder's lock, aged past the shared staleness window.
    await writeFile(lockFile, "dead-holder-token", "utf8");
    const stale = new Date(Date.now() - (STALE_LOCK_MS + 60_000));
    await utimes(lockFile, stale, stale);

    const step = await decideNextStep({ root: REPO_DIR });

    // Recovered, not bounced: the dead lock was removed and the advance ran.
    expect(step.step_kind).not.toBe("phase_busy");
  }, 30_000);

  it("still yields phase_busy for a FRESH lock — the steal never widens to a live peer", async () => {
    // The other half, and the one that keeps the recovery from becoming a
    // mutual-exclusion hole: a lock inside the staleness window is somebody's
    // LIVE critical section, and no timeout budget may take it.
    await establishPlanningRun();
    const lockFile = join(ARTIFACTS_DIR, "phase.lock");
    await writeFile(lockFile, "live-holder-token", "utf8");

    const step = await decideNextStep({ root: REPO_DIR });
    expect(step.step_kind).toBe("phase_busy");
  });
});
