import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { decideNextStep } from "../../src/remediate/steps/nextStep.js";
import { withFileLock } from "../../src/shared/io/fileLock.js";
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
});
