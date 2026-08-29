// An empty dispatch frontier PAUSES; it never throws (the 2026-08-23
// empty-frontier incident, closed by this test's commit).
//
// The dispatch guard and the workload builder must draw from ONE frontier
// computation. When they disagreed — `implementableBlocks` (edge-only) said
// "dispatch" while `hostDependencyLevels` (phase barrier + existence +
// permanent ineligibility) produced zero work items —
// `prepareRemediationHostHandoff` threw "Cannot prepare an empty remediation
// host workload" and the run wedged until the operator hand-edited state.json.
//
// Required routing on an empty frontier: unanswered clarifications ->
// `collect_clarifications`; blocked dependents -> `collect_triage`; never an
// exception.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { StateStore } from "../../src/remediate/state/store.js";
import type { RemediationState } from "../../src/remediate/state/store.js";
import type {
  RemediationBlock,
  RemediationItemState,
} from "../../src/remediate/state/types.js";
import { decideNextStep } from "../../src/remediate/steps/nextStep.js";
import { createNextStepHarness } from "./helpers/nextStepHarness.js";

function block(
  id: string,
  items: string[],
  opts: { dependencies?: string[]; phase_ordinal?: number } = {},
): RemediationBlock {
  return {
    block_id: id,
    items,
    parallel_safe: true,
    dependencies: opts.dependencies ?? [],
    touched_files: [],
    ...(opts.phase_ordinal === undefined
      ? {}
      : { phase_ordinal: opts.phase_ordinal }),
  };
}

function item(
  findingId: string,
  blockId: string,
  status: RemediationItemState["status"],
  extra: Partial<RemediationItemState> = {},
): RemediationItemState {
  return {
    finding_id: findingId,
    status,
    block_id: blockId,
    ...extra,
  };
}

function stateWith(
  blocks: RemediationBlock[],
  items: Record<string, RemediationItemState>,
): RemediationState {
  return {
    status: "implementing",
    plan: {
      plan_id: "PLAN-EF",
      findings: blocks.flatMap((b) =>
        b.items.map((id) => ({
          id,
          title: id,
          category: "correctness",
          severity: "medium" as const,
          confidence: "high" as const,
          lens: "correctness",
          summary: id,
          affected_files: [{ path: `src/${id}.ts` }],
          evidence: [`src/${id}.ts:1`],
        })),
      ),
      blocks,
      project_type: "unknown",
      candidate_closing_actions: ["none"],
    },
    items,
    closing_plan: { action: "none" },
  } as RemediationState;
}

async function readState(artifactsDir: string): Promise<{
  items: Record<string, { status: string; failure_reason?: string }>;
  status: string;
}> {
  return JSON.parse(await readFile(join(artifactsDir, "state.json"), "utf8"));
}

// ===========================================================================
// A blocked item holding a phase barrier routes to triage, never a throw
// ===========================================================================

describe("empty frontier: a blocked item holding a phase barrier", () => {
  const harness = createNextStepHarness(".test-empty-frontier-barrier");
  const { REPO_DIR, ARTIFACTS_DIR } = harness;

  beforeEach(async () => {
    await harness.resetTestRepo();
  });
  afterEach(async () => {
    await harness.cleanupTestRepo();
  });

  it("emits collect_triage instead of throwing the empty-workload error", async () => {
    // Phase 0 holds one blocked item with its retry budget spent; phase 1 holds
    // a pending block with NO declared dependency edges. The edge-only dispatch
    // guard sees the phase-1 block as dispatchable; the workload builder's
    // phase barrier excludes it — zero work items. Today next-step dies with
    // "Cannot prepare an empty remediation host workload".
    const blocks = [
      block("B1", ["F1"], { phase_ordinal: 0 }),
      block("B2", ["F2"], { phase_ordinal: 1 }),
    ];
    const st = stateWith(blocks, {
      F1: item("F1", "B1", "blocked", {
        failure_reason: "worker reported a failing prerequisite",
        rework_count: 2,
      }),
      F2: item("F2", "B2", "pending"),
    });
    await new StateStore(ARTIFACTS_DIR).saveState(st);
    await harness.acknowledgeResume();
    await harness.writeIntentCheckpoint();

    let step = await decideNextStep({ root: REPO_DIR });
    let guard = 20;
    while (step.step_kind !== "collect_triage" && guard-- > 0) {
      step = await decideNextStep({ root: REPO_DIR });
    }
    expect(guard).toBeGreaterThan(0);
    expect(step.step_kind).toBe("collect_triage");

    // The barrier holder is still on the triage batch, undecided — the tool
    // paused for the operator instead of dying.
    const finalState = await readState(ARTIFACTS_DIR);
    expect(finalState.items.F1.status).toBe("blocked");
    expect(finalState.status).toBe("waiting_for_triage");
  });
});

// ===========================================================================
// A needs_clarification item holding a phase barrier asks the question
// ===========================================================================

describe("empty frontier: a clarification holding a phase barrier", () => {
  const harness = createNextStepHarness(".test-empty-frontier-clarification");
  const { REPO_DIR, ARTIFACTS_DIR } = harness;

  beforeEach(async () => {
    await harness.resetTestRepo();
  });
  afterEach(async () => {
    await harness.cleanupTestRepo();
  });

  it("emits collect_clarifications and never blocks the held dependent", async () => {
    // Phase 0 is paused on an unanswered worker question; phase 1 holds a
    // pending block with no declared edges. The dispatch guard sees phase 1 as
    // dispatchable, so the deferred-clarification round never fires and the
    // prepare throws. Required: the question is asked, and the held dependent
    // stays pending — never mis-blamed as an upstream failure.
    const blocks = [
      block("B1", ["F1"], { phase_ordinal: 0 }),
      block("B2", ["F2"], { phase_ordinal: 1 }),
    ];
    const st = stateWith(blocks, {
      F1: item("F1", "B1", "needs_clarification"),
      F2: item("F2", "B2", "pending"),
    });
    st.clarifications = [
      {
        finding_id: "F1",
        category: "scope_of_fix",
        description: "How far should the boundary refactor reach?",
      },
    ];
    await new StateStore(ARTIFACTS_DIR).saveState(st);
    await harness.acknowledgeResume();
    await harness.writeIntentCheckpoint();

    const step = await decideNextStep({ root: REPO_DIR });

    expect(step.step_kind).toBe("collect_clarifications");
    const finalState = await readState(ARTIFACTS_DIR);
    expect(finalState.items.F2.status).toBe("pending");
    expect(finalState.items.F2.failure_reason).toBeUndefined();
  });
});

// ===========================================================================
// A dangling dependency id dead-ends through triage, never a throw
// ===========================================================================

describe("empty frontier: a dependency id that resolves to no block", () => {
  const harness = createNextStepHarness(".test-empty-frontier-dangling");
  const { REPO_DIR, ARTIFACTS_DIR } = harness;

  beforeEach(async () => {
    await harness.resetTestRepo();
  });
  afterEach(async () => {
    await harness.cleanupTestRepo();
  });

  it("marks the dependent blocked and routes to triage", async () => {
    // The eligibility predicate SKIPS a dependency id that resolves to no
    // block, so the guard dispatches the dependent; the workload builder
    // refuses the same block as permanently ineligible — zero work items, and
    // the prepare throws its classified producer-defect error. Required: the
    // dependent dead-ends with the INV-RS-01 reason and triage gets it.
    const blocks = [block("B2", ["F2"], { dependencies: ["B9"] })];
    const st = stateWith(blocks, {
      F2: item("F2", "B2", "pending", { rework_count: 2 }),
    });
    await new StateStore(ARTIFACTS_DIR).saveState(st);
    await harness.acknowledgeResume();
    await harness.writeIntentCheckpoint();

    let step = await decideNextStep({ root: REPO_DIR });
    let guard = 20;
    while (step.step_kind !== "collect_triage" && guard-- > 0) {
      step = await decideNextStep({ root: REPO_DIR });
    }
    expect(guard).toBeGreaterThan(0);
    expect(step.step_kind).toBe("collect_triage");

    const finalState = await readState(ARTIFACTS_DIR);
    expect(finalState.items.F2.status).toBe("blocked");
    expect(finalState.items.F2.failure_reason ?? "").toMatch(/INV-RS-01/);
  });
});
