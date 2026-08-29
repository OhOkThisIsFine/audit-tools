// Deferred clarification round: an implementation question waits for the END
// of the implement phase instead of freezing dependency-state progression.
//
// A DEPENDENT of a `needs_clarification` item is NOT marked `blocked` by the
// dead-end sweep — "awaiting an answer" must never be recorded as "upstream
// failed". The sweep's discriminator is the workload boundary's liveness
// analysis, `permanentlyDeadPendingBlocks`.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { StateStore } from "../../src/remediate/state/store.js";
import type { RemediationState } from "../../src/remediate/state/store.js";
import type {
  RemediationBlock,
  RemediationItemState,
} from "../../src/remediate/state/types.js";
import { decideNextStep } from "../../src/remediate/steps/nextStep.js";
import { permanentlyDeadPendingBlocks } from "../../src/remediate/steps/dispatch/hostHandoff.js";
import { createNextStepHarness } from "./helpers/nextStepHarness.js";

// ---------------------------------------------------------------------------
// State builders
// ---------------------------------------------------------------------------

function block(
  id: string,
  items: string[],
  dependencies: string[] = [],
): RemediationBlock {
  return { block_id: id, items, parallel_safe: true, dependencies, touched_files: [] };
}

function item(
  findingId: string,
  blockId: string,
  status: RemediationItemState["status"],
): RemediationItemState {
  return {
    finding_id: findingId,
    status,
    block_id: blockId,
  };
}

function stateWith(
  blocks: RemediationBlock[],
  items: Record<string, RemediationItemState>,
): RemediationState {
  return {
    status: "implementing",
    plan: {
      plan_id: "PLAN-DC",
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

// ===========================================================================
// The discriminator itself: awaiting an answer vs. a genuinely failed upstream
// ===========================================================================

describe("permanentlyDeadPendingBlocks: awaiting-an-answer vs upstream-failed", () => {
  const blocks = [block("B1", ["F1"]), block("B2", ["F2"], ["B1"])];
  const deadIds = (st: RemediationState): string[] =>
    permanentlyDeadPendingBlocks(st).map((b) => b.block_id);

  it("holds a dependent whose prerequisite is awaiting a clarification answer", () => {
    const st = stateWith(blocks, {
      F1: item("F1", "B1", "needs_clarification"),
      F2: item("F2", "B2", "pending"),
    });
    expect(deadIds(st)).toEqual([]);
  });

  it("dead-ends a dependent whose prerequisite was skipped or blocked", () => {
    for (const failed of ["ignored", "deemed_inappropriate", "blocked"] as const) {
      const st = stateWith(blocks, {
        F1: item("F1", "B1", failed),
        F2: item("F2", "B2", "pending"),
      });
      expect(deadIds(st)).toEqual(["B2"]);
    }
  });

  it("propagates the hold transitively down a chain (A→B→C, C awaiting)", () => {
    const chain = [
      block("B1", ["F1"]),
      block("B2", ["F2"], ["B1"]),
      block("B3", ["F3"], ["B2"]),
    ];
    const st = stateWith(chain, {
      F1: item("F1", "B1", "needs_clarification"),
      F2: item("F2", "B2", "pending"),
      F3: item("F3", "B3", "pending"),
    });
    expect(deadIds(st)).toEqual([]);
  });

  it("dead-ends a dependency cycle — a cycle is never 'awaiting'", () => {
    const cyclic = [block("B1", ["F1"], ["B2"]), block("B2", ["F2"], ["B1"])];
    const st = stateWith(cyclic, {
      F1: item("F1", "B1", "pending"),
      F2: item("F2", "B2", "pending"),
    });
    expect(deadIds(st)).toEqual(["B1", "B2"]);
  });

  it("a verified-complete prerequisite is simply satisfied, never 'awaiting'", () => {
    const st = stateWith(blocks, {
      F1: item("F1", "B1", "resolved"),
      F2: item("F2", "B2", "pending"),
    });
    expect(deadIds(st)).toEqual([]);
  });

  it("holds a dependent behind a phase barrier that is merely still working", () => {
    // A lower phase paused on a question (or simply pending) is NOT a dead
    // barrier: the higher-phase pending block waits, it is never swept.
    const phased = [
      { ...block("B1", ["F1"]), phase_ordinal: 0 },
      { ...block("B2", ["F2"]), phase_ordinal: 1 },
    ];
    for (const waiting of ["pending", "needs_clarification"] as const) {
      const st = stateWith(phased, {
        F1: item("F1", "B1", waiting),
        F2: item("F2", "B2", "pending"),
      });
      expect(deadIds(st)).toEqual([]);
    }
  });

  it("dead-ends a dependent behind a phase barrier a blocked item holds forever", () => {
    const phased = [
      { ...block("B1", ["F1"]), phase_ordinal: 0 },
      { ...block("B2", ["F2"]), phase_ordinal: 1 },
    ];
    const st = stateWith(phased, {
      F1: item("F1", "B1", "blocked"),
      F2: item("F2", "B2", "pending"),
    });
    expect(deadIds(st)).toEqual(["B2"]);
  });

  it("dead-ends a dependent whose declared dependency resolves to no block", () => {
    const dangling = [block("B2", ["F2"], ["B9"])];
    const st = stateWith(dangling, {
      F2: item("F2", "B2", "pending"),
    });
    expect(deadIds(st)).toEqual(["B2"]);
  });
});

// ===========================================================================
// A dependent of a needs_clarification item is not dead-ended
// ===========================================================================

describe("the dead-end sweep does not blame an unanswered question", () => {
  const harness = createNextStepHarness(".test-deferred-clarification-dependent");
  const { REPO_DIR, ARTIFACTS_DIR } = harness;

  beforeEach(async () => {
    await harness.resetTestRepo();
  });
  afterEach(async () => {
    await harness.cleanupTestRepo();
  });

  it("holds the dependent pending and asks the question instead of blocking it", async () => {
    // B2 depends on B1; B1 is paused on an unanswered worker question. B1 is not
    // verified-complete, so B2 is ineligible and reaches the dead-end sweep — but
    // its upstream did not FAIL, it is awaiting an answer.
    const blocks = [block("B1", ["F1"]), block("B2", ["F2"], ["B1"])];
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

    const finalState = JSON.parse(
      await readFile(join(ARTIFACTS_DIR, "state.json"), "utf8"),
    );
    // The dependent is HELD, never mis-reported as an upstream failure...
    expect(finalState.items.F2.status).toBe("pending");
    expect(finalState.items.F2.failure_reason).toBeUndefined();
    expect(finalState.items.F1.status).toBe("needs_clarification");
    // ...and the run asks the deferred question instead of triaging the fallout.
    expect(step.step_kind).toBe("collect_clarifications");
  });

  it("dead-ends the same dependent once the answer disposes its upstream", async () => {
    // The discriminator must not become a permanent shield: an answer that SKIPS
    // the upstream makes the edge genuinely unsatisfiable, and the ordinary sweep
    // blocks the dependent with the accurate reason.
    const blocks = [block("B1", ["F1"]), block("B2", ["F2"], ["B1"])];
    const st = stateWith(blocks, {
      F1: item("F1", "B1", "needs_clarification"),
      F2: item("F2", "B2", "pending"),
    });
    await new StateStore(ARTIFACTS_DIR).saveState(st);
    await harness.acknowledgeResume();
    await harness.writeIntentCheckpoint();
    await writeFile(
      join(ARTIFACTS_DIR, "clarification_resolution.json"),
      JSON.stringify({
        resolutions: [
          {
            finding_id: "F1",
            action: "reject_finding",
            rationale: "Not a real issue.",
          },
        ],
      }),
      "utf8",
    );

    let step = await decideNextStep({ root: REPO_DIR });
    let guard = 20;
    while (
      step.step_kind !== "present_report" &&
      step.step_kind !== "collect_triage" &&
      guard-- > 0
    ) {
      step = await decideNextStep({ root: REPO_DIR });
    }
    expect(guard).toBeGreaterThan(0);

    const finalState = JSON.parse(
      await readFile(join(ARTIFACTS_DIR, "state.json"), "utf8"),
    );
    expect(finalState.items.F1.status).toBe("deemed_inappropriate");
    expect(finalState.items.F2.status).toBe("blocked");
    expect(finalState.items.F2.failure_reason ?? "").toMatch(
      /verified-complete|INV-RS-01|skipped|blocked|cyclic/i,
    );
  });
});

// ===========================================================================
// An applied answer invalidates the persisted host workload binding
// ===========================================================================

describe("an applied clarification answer invalidates the persisted host-handoff binding", () => {
  const harness = createNextStepHarness(".test-clarification-handoff-binding");
  const { REPO_DIR, ARTIFACTS_DIR } = harness;

  beforeEach(async () => {
    await harness.resetTestRepo();
  });
  afterEach(async () => {
    await harness.cleanupTestRepo();
  });

  it("strips host_handoff when a clarified answer re-opens an item", async () => {
    // A `clarified` answer writes clarification_context onto the item, and that
    // context is baked into the dispatch prompt — so the workload the persisted
    // record binds to can no longer be regenerated byte-identical. A surviving
    // record makes the next handoff prepare REFUSE (one of its trusted-binding
    // guards throws) instead of re-emitting a fresh workload for the answered
    // item.
    const blocks = [block("B1", ["F1"])];
    const st = stateWith(blocks, {
      F1: item("F1", "B1", "needs_clarification"),
    });
    st.status = "implementing";
    st.clarifications = [
      {
        finding_id: "F1",
        category: "scope_of_fix",
        description: "How far should the boundary refactor reach?",
      },
    ];
    st.host_handoff = {
      contract_version: "remediation-host-handoff-record/v1alpha1",
      // The run id is the plan id (stateRunId), so the record belongs to THIS
      // run — the failure under test is the digest mismatch, not a foreign run.
      run_id: "PLAN-DC",
      baseline_commit: "a".repeat(40),
      workload_sha256: "b".repeat(64),
      work_item_ids: ["F1"],
    };
    await new StateStore(ARTIFACTS_DIR).saveState(st);
    await harness.acknowledgeResume();
    await harness.writeIntentCheckpoint();
    await writeFile(
      join(ARTIFACTS_DIR, "clarification_resolution.json"),
      JSON.stringify({
        resolutions: [
          {
            finding_id: "F1",
            action: "clarified",
            rationale: "Narrow the fix to the module boundary.",
          },
        ],
      }),
      "utf8",
    );

    await decideNextStep({ root: REPO_DIR });

    const finalState = JSON.parse(
      await readFile(join(ARTIFACTS_DIR, "state.json"), "utf8"),
    );
    // The answer landed (and the prepare above did not throw on the stale
    // record)...
    expect(finalState.items.F1.status).toBe("pending");
    expect(finalState.items.F1.clarification_context).toBe(
      "Narrow the fix to the module boundary.",
    );
    // ...and any binding present now is a freshly regenerated one, never the
    // pre-answer record.
    expect(finalState.host_handoff?.workload_sha256).not.toBe("b".repeat(64));
  });
});

// ===========================================================================
// Clarification scope delta (open-bugs.md:110 / :661)
// ===========================================================================

describe("clarification scope delta widens the owning block in-band", () => {
  const harness = createNextStepHarness(".test-clarification-scope-delta");
  const { REPO_DIR, ARTIFACTS_DIR } = harness;

  beforeEach(async () => {
    await harness.resetTestRepo();
  });
  afterEach(async () => {
    await harness.cleanupTestRepo();
  });

  function needsClarificationState() {
    const blocks = [{ ...block("B1", ["F1"]), touched_files: ["src/F1.ts"] }];
    const st = stateWith(blocks, { F1: item("F1", "B1", "needs_clarification") });
    st.clarifications = [
      {
        finding_id: "F1",
        category: "scope_of_fix",
        description: "Which companion files may the fix touch?",
      },
    ];
    return st;
  }

  it("a clarified resolution's scope_additions widen the owning block and drop the stale binding", async () => {
    const st = needsClarificationState();
    st.host_handoff = {
      contract_version: "remediation-host-handoff-record/v1alpha1",
      run_id: "PLAN-DC",
      baseline_commit: "a".repeat(40),
      workload_sha256: "b".repeat(64),
      work_item_ids: ["F1"],
    };
    await new StateStore(ARTIFACTS_DIR).saveState(st);
    await harness.acknowledgeResume();
    await harness.writeIntentCheckpoint();
    await writeFile(
      join(ARTIFACTS_DIR, "clarification_resolution.json"),
      JSON.stringify({
        resolutions: [
          {
            finding_id: "F1",
            action: "clarified",
            rationale: "Also create the pinning test and the shared helper.",
            scope_additions: ["tests/f1-pin.test.ts", "src/shared/f1Helper.ts"],
          },
        ],
      }),
      "utf8",
    );

    await decideNextStep({ root: REPO_DIR });

    const finalState = JSON.parse(
      await readFile(join(ARTIFACTS_DIR, "state.json"), "utf8"),
    );
    expect(finalState.items.F1.status).toBe("pending");
    const b1 = finalState.plan.blocks.find(
      (b: { block_id: string }) => b.block_id === "B1",
    );
    expect(b1.touched_files).toContain("src/F1.ts");
    expect(b1.touched_files).toContain("tests/f1-pin.test.ts");
    expect(b1.touched_files).toContain("src/shared/f1Helper.ts");
    // The stale workload binding is invalidated and the SAME call re-mints a
    // fresh one over the widened scope (the open-bugs :661 wedge class): any
    // binding present now is a freshly regenerated record, never the
    // pre-answer one.
    expect(finalState.host_handoff?.workload_sha256).not.toBe("b".repeat(64));
  });

  it("an invalid scope delta refuses the WHOLE resolution file and applies nothing", async () => {
    const st = needsClarificationState();
    await new StateStore(ARTIFACTS_DIR).saveState(st);
    await harness.acknowledgeResume();
    await harness.writeIntentCheckpoint();
    await writeFile(
      join(ARTIFACTS_DIR, "clarification_resolution.json"),
      JSON.stringify({
        resolutions: [
          {
            finding_id: "F1",
            action: "clarified",
            rationale: "Widen.",
            scope_additions: ["../outside-the-repo.ts"],
          },
        ],
      }),
      "utf8",
    );

    const step = await decideNextStep({ root: REPO_DIR });

    const finalState = JSON.parse(
      await readFile(join(ARTIFACTS_DIR, "state.json"), "utf8"),
    );
    // Nothing applied: the item still awaits its answer; the scope is unchanged.
    expect(finalState.items.F1.status).toBe("needs_clarification");
    const b1 = finalState.plan.blocks.find(
      (b: { block_id: string }) => b.block_id === "B1",
    );
    expect(b1.touched_files).toEqual(["src/F1.ts"]);
    // The file was refused (renamed away), and the run re-halts on the question.
    expect(existsSync(join(ARTIFACTS_DIR, "clarification_resolution.json"))).toBe(false);
    expect(step.status).toBe("blocked");
  });
});
