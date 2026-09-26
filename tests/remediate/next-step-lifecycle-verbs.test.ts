// Operator lifecycle verbs (O31 / packet 14): plan-only, pause, resume, cancel.
//
// The acceptance condition is that the process RESTARTS between each transition,
// so every verb here re-reads the state from disk through a FRESH StateStore
// (a new process's only view). The properties under test:
//
//   - plan-only finishes planning and records a paused continuation BEFORE
//     implementation (status `paused`, not `implementing`).
//   - pause records the current item, binding, phase, and exact continuation.
//   - resume uses the saved continuation and skips accepted (terminal) work.
//   - cancel records a terminal cancellation and preserves artifacts.
//   - a host-reported worktree location/outcome is recorded WITHOUT the tool
//     owning branch create/delete.
//   - a bare next-step on `paused`/`cancelled` emits the truthful parked step,
//     never mis-routing to confirm_resume or dispatching work.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSyncHidden as spawnSync } from "../helpers/spawn.mjs";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { decideNextStep } from "../../src/remediate/steps/nextStep.js";
import { StateStore } from "../../src/remediate/state/store.js";
import type { RemediationState } from "../../src/remediate/state/store.js";
import {
  planOnlyVerb,
  pauseVerb,
  resumeVerb,
  cancelVerb,
} from "../../src/remediate/steps/lifecycle.js";
import {
  createNextStepHarness,
  makePlanningState,
  AUDIT_FIXTURE,
} from "./helpers/nextStepHarness.js";

const harness = createNextStepHarness(".test-next-step-lifecycle-verbs");
const { REPO_DIR, ARTIFACTS_DIR, saveState, writeIntentCheckpoint } =
  harness;

beforeEach(async () => {
  await harness.resetTestRepo();
});

afterEach(async () => {
  await harness.cleanupTestRepo();
});

/** A fresh StateStore over the same artifacts dir — a restarted process. */
function freshStore(): StateStore {
  return new StateStore(ARTIFACTS_DIR);
}

/** A valid implementing state with one resolved + one pending item and a binding. */
function makeImplementingState(): RemediationState {
  const base = makePlanningState();
  return {
    ...base,
    status: "implementing",
    items: {
      "F-001": { finding_id: "F-001", status: "resolved", block_id: "B-001" },
      "F-002": { finding_id: "F-002", status: "pending", block_id: "B-002" },
    },
    host_handoff: {
      contract_version: "remediation-host-handoff-record/v1alpha2",
      scope_semantics: "explicit-directory-markers/v1",
      run_id: "PLAN-1",
      baseline_commit: "a".repeat(40),
      workload_sha256: "b".repeat(64),
      work_item_ids: ["B-002"],
    },
  } as RemediationState;
}

function makePreDispatchState(): RemediationState {
  return makePlanningState({
    status: "implementing",
    conformance_review_policy: {
      plan_id: "PLAN-1",
      choice: "undecided",
      first_dispatch_recorded: false,
    },
  });
}

describe("plan-only stops before implementation and persists the continuation", () => {
  it("keeps completed-report redelivery when bare plan-only has no new intake", async () => {
    await writeFile(
      join(REPO_DIR, ".audit-tools", "remediation-report.md"),
      "# Previous remediation report\n",
      "utf8",
    );

    const step = await decideNextStep({ root: REPO_DIR, planOnly: true });
    expect(step.step_kind).toBe("present_report");
    expect(await freshStore().loadState()).toBeNull();
  });

  it("keeps active intake ahead of a leftover report while recording plan-only", async () => {
    await writeFile(
      join(REPO_DIR, ".audit-tools", "remediation-report.md"),
      "# Previous remediation report\n",
      "utf8",
    );
    const inputPath = join(REPO_DIR, "audit-findings.json");
    await writeFile(inputPath, await readFile(AUDIT_FIXTURE), "utf8");
    await harness.writeReadyStructuredAuditIntake(inputPath);

    const step = await decideNextStep({ root: REPO_DIR, planOnly: true });
    expect(step.step_kind).not.toBe("present_report");
    expect((await freshStore().loadState())?.plan_only_request?.request_id).toEqual(expect.any(String));
  });

  it("retains a planning stop across a review prompt and resumes into one dispatch", async () => {
    await saveState(makePlanningState({
      conformance_review_policy: {
        plan_id: "PLAN-1",
        choice: "undecided",
        first_dispatch_recorded: false,
      },
    }));
    await writeIntentCheckpoint();
    await harness.acknowledgeResume();

    const review = await decideNextStep({ root: REPO_DIR, planOnly: true });
    expect(review.step_kind).not.toBe("dispatch_implement");
    expect((await freshStore().loadState())?.plan_only_request?.plan_id).toBe("PLAN-1");

    await harness.approveReviewGate();
    const pausedStep = await decideNextStep({ root: REPO_DIR });
    expect(pausedStep.step_kind).toBe("paused");
    const paused = await freshStore().loadState();
    expect(paused?.status).toBe("paused");
    expect(paused?.lifecycle?.action).toBe("plan_only");
    expect(paused?.plan_only_request).toBeUndefined();
    expect(paused?.host_handoff).toBeUndefined();

    expect((await resumeVerb({ root: REPO_DIR, artifactsDir: ARTIFACTS_DIR })).status).toBe("ok");
    const dispatch = await decideNextStep({ root: REPO_DIR });
    expect(dispatch.step_kind).toBe("dispatch_implement");
    expect((await freshStore().loadState())?.status).toBe("implementing");
  });

  it("carries fresh structured input and review opt-in through first plan mint to pause", async () => {
    const inputPath = join(REPO_DIR, "audit-findings.json");
    await writeFile(inputPath, await readFile(AUDIT_FIXTURE));

    const first = await decideNextStep({
      root: REPO_DIR,
      input: inputPath,
      planOnly: true,
      conformanceReview: true,
      planOnlyWorktree: { location: "feature/plan-only" },
    });
    expect(first.step_kind).toBe("synthesize_intake");
    const beforePlan = await freshStore().loadState();
    expect(beforePlan?.status).toBe("pending");
    expect(beforePlan?.plan_only_request?.plan_id).toBeUndefined();
    expect(beforePlan?.conformance_review_policy?.choice).toBe("on");

    await harness.writeReadyStructuredAuditIntake(inputPath);
    await harness.writeCompleteContractPipelineDag();
    await harness.approveReviewGate();
    const pausedStep = await decideNextStep({ root: REPO_DIR });
    expect(pausedStep.step_kind).toBe("paused");
    const paused = await freshStore().loadState();
    expect(paused?.status).toBe("paused");
    expect(paused?.plan?.plan_id).toEqual(expect.any(String));
    expect(paused?.lifecycle?.action).toBe("plan_only");
    expect(paused?.lifecycle?.worktree?.location).toBe("feature/plan-only");
    expect(paused?.plan_only_request).toBeUndefined();
    expect(paused?.host_handoff).toBeUndefined();
    expect(paused?.conformance_review_policy).toMatchObject({
      plan_id: paused?.plan?.plan_id,
      choice: "on",
      first_dispatch_recorded: false,
    });

    expect((await resumeVerb({ root: REPO_DIR, artifactsDir: ARTIFACTS_DIR })).status).toBe("ok");
    const dispatch = await decideNextStep({ root: REPO_DIR });
    expect(dispatch.step_kind).toBe("dispatch_implement");
    const afterDispatch = await freshStore().loadState();
    expect(afterDispatch?.plan?.plan_id).toBe(paused?.plan?.plan_id);
    expect(afterDispatch?.conformance_review_policy).toMatchObject({
      choice: "on",
      first_dispatch_recorded: true,
    });
  });

  it("does not skip planning when requested before a plan exists", async () => {
    await saveState(makePlanningState({ status: "pending", plan: undefined, items: {} }));

    const result = await planOnlyVerb({ root: REPO_DIR, artifactsDir: ARTIFACTS_DIR });
    expect(result.status).toBe("unrunnable");

    const state = await freshStore().loadState();
    expect(state?.status).toBe("pending");
    expect(state?.lifecycle).toBeUndefined();
  });

  it("does not skip planning review gates just because a plan is present", async () => {
    await saveState(makePlanningState({ status: "planning" }));

    const result = await planOnlyVerb({ root: REPO_DIR, artifactsDir: ARTIFACTS_DIR });
    expect(result.status).toBe("unrunnable");
    const state = await freshStore().loadState();
    expect(state?.status).toBe("planning");
    expect(state?.lifecycle).toBeUndefined();
  });

  it("sets status paused (not implementing) with a plan_only lifecycle record", async () => {
    await saveState(makePreDispatchState());

    const result = await planOnlyVerb({ root: REPO_DIR, artifactsDir: ARTIFACTS_DIR });
    expect(result.status).toBe("ok");

    // Restart: read back through a fresh store.
    const state = await freshStore().loadState();
    expect(state?.status).toBe("paused");
    expect(state?.status).not.toBe("implementing");
    expect(state?.lifecycle?.action).toBe("plan_only");
    expect(state?.lifecycle?.continuation).toMatch(/implement/i);
    // The plan and items are intact (nothing dispatched or dropped).
    expect(state?.plan?.plan_id).toBe("PLAN-1");
    expect(Object.keys(state?.items ?? {}).length).toBe(2);
  });

  it("a bare next-step on the paused plan-only state emits the paused step, not a dispatch", async () => {
    await saveState(makePreDispatchState());
    await planOnlyVerb({ root: REPO_DIR, artifactsDir: ARTIFACTS_DIR });

    const step = await decideNextStep({ root: REPO_DIR });
    expect(step.step_kind).toBe("paused");
    expect(step.status).toBe("ready");
  });

  it("does not relabel an already dispatched implementation as plan-only", async () => {
    await saveState(makeImplementingState());

    const result = await planOnlyVerb({ root: REPO_DIR, artifactsDir: ARTIFACTS_DIR });
    expect(result.status).toBe("unrunnable");
    const state = await freshStore().loadState();
    expect(state?.status).toBe("implementing");
    expect(state?.host_handoff).toBeDefined();
    expect(state?.lifecycle).toBeUndefined();
  });

  it("does not relabel a dispatched run after its handoff record is cleared", async () => {
    await saveState(makePlanningState({
      status: "implementing",
      conformance_review_policy: {
        plan_id: "PLAN-1",
        choice: "off",
        first_dispatch_recorded: true,
      },
    }));

    const result = await planOnlyVerb({ root: REPO_DIR, artifactsDir: ARTIFACTS_DIR });
    expect(result.status).toBe("unrunnable");
    expect((await freshStore().loadState())?.lifecycle).toBeUndefined();
  });

  it("repeating plan-only preserves its saved continuation", async () => {
    await saveState(makePreDispatchState());
    await planOnlyVerb({ root: REPO_DIR, artifactsDir: ARTIFACTS_DIR });
    const first = await freshStore().loadState();

    const repeated = await planOnlyVerb({ root: REPO_DIR, artifactsDir: ARTIFACTS_DIR });
    expect(repeated.status).toBe("ok");
    const again = await freshStore().loadState();
    expect(again?.lifecycle).toEqual(first?.lifecycle);

    const resumed = await resumeVerb({ root: REPO_DIR, artifactsDir: ARTIFACTS_DIR });
    expect(resumed.status).toBe("ok");
    expect((await freshStore().loadState())?.status).toBe("implementing");
  });
});

describe("pause records item, binding, phase and exact continuation", () => {
  it("refuses a pending run that cannot resume through the saved phase", async () => {
    await saveState(makePlanningState({ status: "pending", plan: undefined, items: {} }));

    const result = await pauseVerb({ root: REPO_DIR, artifactsDir: ARTIFACTS_DIR });
    expect(result.status).toBe("unrunnable");
    const state = await freshStore().loadState();
    expect(state?.status).toBe("pending");
    expect(state?.lifecycle).toBeUndefined();
  });

  it("repeated pause preserves the original continuation across a restart", async () => {
    const impl = makeImplementingState();
    await saveState(impl);
    await pauseVerb({ root: REPO_DIR, artifactsDir: ARTIFACTS_DIR });
    const first = await freshStore().loadState();

    const again = await pauseVerb({ root: REPO_DIR, artifactsDir: ARTIFACTS_DIR });
    expect(again.status).toBe("ok");
    const stillPaused = await freshStore().loadState();
    expect(stillPaused?.lifecycle).toEqual(first?.lifecycle);

    const resumed = await resumeVerb({ root: REPO_DIR, artifactsDir: ARTIFACTS_DIR });
    expect(resumed.status).toBe("ok");
    const restored = await freshStore().loadState();
    expect(restored?.status).toBe("implementing");
    expect(restored?.host_handoff).toEqual(impl.host_handoff);
  });

  it("moves the workload binding into the lifecycle record and clears host_handoff", async () => {
    const impl = makeImplementingState();
    await saveState(impl);

    const result = await pauseVerb({ root: REPO_DIR, artifactsDir: ARTIFACTS_DIR });
    expect(result.status).toBe("ok");

    const state = await freshStore().loadState();
    expect(state?.status).toBe("paused");
    expect(state?.lifecycle?.action).toBe("pause");
    expect(state?.lifecycle?.phase).toBe("implementing");
    expect(state?.lifecycle?.current_item_id).toBe("F-002");
    // The binding is preserved verbatim in the record...
    expect(state?.lifecycle?.binding).toEqual(impl.host_handoff);
    // ...and cleared from the live state (the validator scopes it to implementing).
    expect(state?.host_handoff).toBeUndefined();
  });

  it("records a host-reported worktree location/outcome without owning the branch", async () => {
    await saveState(makeImplementingState());

    const result = await pauseVerb({
      root: REPO_DIR,
      artifactsDir: ARTIFACTS_DIR,
      worktree: { location: ".audit-tools/worktrees/remediate-F-002", outcome: "unmerged" },
    });
    expect(result.status).toBe("ok");

    const state = await freshStore().loadState();
    expect(state?.lifecycle?.worktree).toEqual({
      location: ".audit-tools/worktrees/remediate-F-002",
      outcome: "unmerged",
    });
  });
});

describe("resume uses the saved continuation and skips accepted work", () => {
  it("restores the phase and binding, keeping terminal items terminal", async () => {
    const impl = makeImplementingState();
    await saveState(impl);
    await pauseVerb({ root: REPO_DIR, artifactsDir: ARTIFACTS_DIR });

    // Restart: resume from the paused state through a separate invocation.
    const result = await resumeVerb({ root: REPO_DIR, artifactsDir: ARTIFACTS_DIR });
    expect(result.status).toBe("ok");

    const state = await freshStore().loadState();
    expect(state?.status).toBe("implementing");
    // The binding is restored verbatim.
    expect(state?.host_handoff).toEqual(impl.host_handoff);
    // The lifecycle record is consumed.
    expect(state?.lifecycle).toBeUndefined();
    // The already-accepted item stayed resolved — resume must not re-run it.
    expect(state?.items?.["F-001"]?.status).toBe("resolved");
    expect(state?.items?.["F-002"]?.status).toBe("pending");
  });

  it("after resume, next-step dispatches only pending items and does not rerun accepted items", async () => {
    await writeIntentCheckpoint();
    const impl = makeImplementingState();
    await saveState(impl);
    await pauseVerb({ root: REPO_DIR, artifactsDir: ARTIFACTS_DIR });

    const result = await resumeVerb({ root: REPO_DIR, artifactsDir: ARTIFACTS_DIR });
    expect(result.status).toBe("ok");

    // Restart: invoke decideNextStep as a fresh process.
    const step = await decideNextStep({ root: REPO_DIR, skipFinalGate: true });
    expect(step.step_kind).toBe("dispatch_implement");
    const workloadPath = step.artifact_paths.host_workload;
    expect(workloadPath).toBeTruthy();
    const workload = JSON.parse(await readFile(workloadPath!, "utf8")) as {
      work_items: { id: string; finding_ids: string[] }[];
    };
    const blockIds = workload.work_items.map((w) => w.id);
    const findingIds = workload.work_items.flatMap((w) => w.finding_ids);
    // Dispatched pending block B-002 (item F-002), but skipped resolved block B-001 (item F-001).
    expect(blockIds).toContain("B-002");
    expect(blockIds).not.toContain("B-001");
    expect(findingIds).toContain("F-002");
    expect(findingIds).not.toContain("F-001");
  });

  it("pause and resume retain waiting_for_clarification phase", async () => {
    await writeIntentCheckpoint();
    const base = makePlanningState();
    const clarificationState: RemediationState = {
      ...base,
      status: "waiting_for_clarification",
      items: {
        "F-001": {
          finding_id: "F-001",
          status: "needs_clarification",
          block_id: "B-001",
          clarification_question: {
            category: "public_contract",
            description: "Which contract shape should be used?",
          },
        },
      },
    } as RemediationState;
    await saveState(clarificationState);

    const paused = await pauseVerb({ root: REPO_DIR, artifactsDir: ARTIFACTS_DIR });
    expect(paused.status).toBe("ok");

    const stateAfterPause = await freshStore().loadState();
    expect(stateAfterPause?.status).toBe("paused");
    expect(stateAfterPause?.lifecycle?.phase).toBe("waiting_for_clarification");
    expect(stateAfterPause?.lifecycle?.current_item_id).toBe("F-001");

    const resumed = await resumeVerb({ root: REPO_DIR, artifactsDir: ARTIFACTS_DIR });
    expect(resumed.status).toBe("ok");

    const stateAfterResume = await freshStore().loadState();
    expect(stateAfterResume?.status).toBe("waiting_for_clarification");
    expect(stateAfterResume?.lifecycle).toBeUndefined();

    // The resumed state emits the clarification prompt step.
    const step = await decideNextStep({ root: REPO_DIR });
    expect(step.step_kind).toBe("collect_clarifications");
  });

  it("refuses to resume a run that is not paused", async () => {
    await saveState(makePlanningState({ status: "planning" }));
    const result = await resumeVerb({ root: REPO_DIR, artifactsDir: ARTIFACTS_DIR });
    expect(result.status).toBe("unrunnable");
    if (result.status === "unrunnable") expect(result.message).toMatch(/not paused/i);
  });
});

describe("cancel records a terminal cancellation and preserves artifacts", () => {
  it("sets status cancelled and leaves state.json + plan on disk", async () => {
    await saveState(makeImplementingState());

    const result = await cancelVerb({
      root: REPO_DIR,
      artifactsDir: ARTIFACTS_DIR,
      worktree: { location: "feature/remediate", outcome: "discarded" },
    });
    expect(result.status).toBe("ok");

    const state = await freshStore().loadState();
    expect(state?.status).toBe("cancelled");
    expect(state?.lifecycle?.action).toBe("cancel");
    // Artifacts preserved: the state file and the plan's items all still exist.
    expect(existsSync(join(ARTIFACTS_DIR, "state.json"))).toBe(true);
    expect(state?.plan?.plan_id).toBe("PLAN-1");
    expect(Object.keys(state?.items ?? {}).length).toBe(2);
    expect(state?.lifecycle?.worktree?.location).toBe("feature/remediate");
  });

  it("a bare next-step on a cancelled run emits the terminal cancelled step, never advancing", async () => {
    await saveState(makeImplementingState());
    await cancelVerb({ root: REPO_DIR, artifactsDir: ARTIFACTS_DIR });

    const step1 = await decideNextStep({ root: REPO_DIR });
    expect(step1.step_kind).toBe("cancelled");
    expect(step1.status).toBe("complete");

    // Second invocation across process restart: still emits cancelled and does not advance.
    const step2 = await decideNextStep({ root: REPO_DIR });
    expect(step2.step_kind).toBe("cancelled");
    expect(step2.status).toBe("complete");

    // And it did not mutate the run: still cancelled, items unchanged.
    const state = await freshStore().loadState();
    expect(state?.status).toBe("cancelled");
  });

  it("refuses to cancel an already-cancelled run", async () => {
    await saveState(makeImplementingState());
    await cancelVerb({ root: REPO_DIR, artifactsDir: ARTIFACTS_DIR });
    const second = await cancelVerb({ root: REPO_DIR, artifactsDir: ARTIFACTS_DIR });
    expect(second.status).toBe("unrunnable");
    if (second.status === "unrunnable") expect(second.message).toMatch(/cancelled/i);
  });

  it("refuses to resume a cancelled run", async () => {
    await saveState(makeImplementingState());
    await cancelVerb({ root: REPO_DIR, artifactsDir: ARTIFACTS_DIR });
    const result = await resumeVerb({ root: REPO_DIR, artifactsDir: ARTIFACTS_DIR });
    expect(result.status).toBe("unrunnable");
    if (result.status === "unrunnable") expect(result.message).toMatch(/cancelled|not paused/i);
  });
});

describe("CLI lifecycle verbs via subprocess", () => {
  const cliPath = join(
    fileURLToPath(new URL(".", import.meta.url)),
    "..",
    "..",
    "dist",
    "remediate",
    "index.js",
  );

  it("starts plan-only from a fresh input and retains the request through intake", async () => {
    const inputPath = join(REPO_DIR, "feedback.md");
    await writeFile(inputPath, "# Feedback\n\nFix the repository issue.\n", "utf8");

    const run = spawnSync(
      process.execPath,
      [cliPath, "plan-only", "--root", REPO_DIR, "--input", inputPath],
      { encoding: "utf8" },
    );
    expect(run.status).toBe(0);
    const step = JSON.parse(run.stdout) as { step_kind: string };
    expect(step.step_kind).toBe("synthesize_intake");

    const state = await freshStore().loadState();
    expect(state?.status).toBe("pending");
    expect(state?.plan_only_request).toMatchObject({
      request_id: expect.any(String),
    });
  });

  it("executes pause and resume CLI commands with worktree options", async () => {
    await saveState(makeImplementingState());

    const pauseRun = spawnSync(
      process.execPath,
      [
        cliPath,
        "pause",
        "--root",
        REPO_DIR,
        "--worktree-location",
        ".audit-tools/wt-cli",
        "--worktree-outcome",
        "unmerged",
      ],
      { encoding: "utf8" },
    );
    expect(pauseRun.status).toBe(0);

    const pausedState = await freshStore().loadState();
    expect(pausedState?.status).toBe("paused");
    expect(pausedState?.lifecycle?.worktree).toEqual({
      location: ".audit-tools/wt-cli",
      outcome: "unmerged",
    });

    const resumeRun = spawnSync(
      process.execPath,
      [cliPath, "resume", "--root", REPO_DIR],
      { encoding: "utf8" },
    );
    expect(resumeRun.status).toBe(0);

    const resumedState = await freshStore().loadState();
    expect(resumedState?.status).toBe("implementing");
    expect(resumedState?.lifecycle).toBeUndefined();
  });

  it("executes cancel CLI command with worktree options and rejects resume", async () => {
    await saveState(makeImplementingState());

    const cancelRun = spawnSync(
      process.execPath,
      [
        cliPath,
        "cancel",
        "--root",
        REPO_DIR,
        "--worktree-location",
        ".audit-tools/wt-cli",
        "--worktree-outcome",
        "discarded",
      ],
      { encoding: "utf8" },
    );
    expect(cancelRun.status).toBe(0);

    const cancelledState = await freshStore().loadState();
    expect(cancelledState?.status).toBe("cancelled");
    expect(cancelledState?.lifecycle?.worktree?.outcome).toBe("discarded");

    const resumeRun = spawnSync(
      process.execPath,
      [cliPath, "resume", "--root", REPO_DIR],
      { encoding: "utf8" },
    );
    expect(resumeRun.status).not.toBe(0);
  });
});
