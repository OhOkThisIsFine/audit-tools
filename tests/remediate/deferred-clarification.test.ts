import { canonicalPlanFixture, canonicalUnitFixture, writeApprovedPlanFixture } from "./helpers/canonicalPlanFixture.js";
// Deferred clarification round: an implementation question waits for the END
// of the implement phase instead of freezing dependency-state progression.
//
// A DEPENDENT of a `needs_clarification` item is NOT marked `blocked` by the
// dead-end sweep — "awaiting an answer" must never be recorded as "upstream
// failed". The sweep's discriminator is the workload boundary's liveness
// analysis, `permanentlyDeadPendingUnits`.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { StateStore } from "../../src/remediate/state/store.js";
import type { RemediationState } from "../../src/remediate/state/store.js";
import type {
  ExecutionUnit,
  RemediationItemState,
} from "../../src/remediate/state/types.js";
import { decideNextStep } from "../../src/remediate/steps/nextStep.js";
import { assertApprovedRuntimePlan } from "../../src/remediate/contractPipeline/runtimePlanAuthority.js";
import { permanentlyDeadPendingUnits } from "../../src/remediate/steps/dispatch/hostHandoff.js";
import { createNextStepHarness } from "./helpers/nextStepHarness.js";

// ---------------------------------------------------------------------------
// State builders
// ---------------------------------------------------------------------------

function block(
  id: string,
  items: string[],
  dependencies: string[] = [],
): ExecutionUnit {
  return canonicalUnitFixture(id, { source_finding_ids: items, dependencies, allowed_files: [] });
}

function item(
  _findingId: string,
  blockId: string,
  status: RemediationItemState["status"],
): RemediationItemState {
  return {
    unit_id: blockId,
    status,
    // The state store refuses a paused item without its question.
    ...(status === "needs_clarification"
      ? {
          clarification_question: {
            category: "scope_of_fix" as const,
            description: "How far should the boundary refactor reach?",
          },
        }
      : {}),
  };
}

function stateWith(
  blocks: ExecutionUnit[],
  items: Record<string, RemediationItemState>,
): RemediationState {
  return {
    status: "implementing",
    plan: canonicalPlanFixture({
      plan_id: "PLAN-DC",
      findings: blocks.flatMap((b) =>
        b.source_finding_ids.map((id) => ({
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
      units: blocks,
      requirements: blocks.map(unit => ({ id: unit.requirement_ids[0]!, description: unit.description, source_finding_ids: [...unit.source_finding_ids], change_kind: "structural", assertions: [], inapplicable_reason: "Fixture exercises runtime lifecycle only" })),
      project_type: "unknown",
      candidate_closing_actions: ["none"],
    }),
    items: Object.fromEntries(Object.values(items).map(item => [item.unit_id, item])),
    closing_plan: { action: "none" },
  } as RemediationState;
}

// ===========================================================================
// The discriminator itself: awaiting an answer vs. a genuinely failed upstream
// ===========================================================================

describe("permanentlyDeadPendingUnits: awaiting-an-answer vs upstream-failed", () => {
  const blocks = [block("B1", ["F1"]), block("B2", ["F2"], ["B1"])];
  const deadIds = (st: RemediationState): string[] =>
    permanentlyDeadPendingUnits(st).map((b) => b.id);

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
    await harness.writeIntentCheckpoint();
    await writeApprovedPlanFixture(ARTIFACTS_DIR, st);
    await new StateStore(ARTIFACTS_DIR).saveState(st);
    await harness.acknowledgeResume();

    const step = await decideNextStep({ root: REPO_DIR });

    const finalState = JSON.parse(
      await readFile(join(ARTIFACTS_DIR, "state.json"), "utf8"),
    );
    // The dependent is HELD, never mis-reported as an upstream failure...
    expect(finalState.items.B2.status).toBe("pending");
    expect(finalState.items.B2.failure_reason).toBeUndefined();
    expect(finalState.items.B1.status).toBe("needs_clarification");
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
    await harness.writeIntentCheckpoint();
    await writeApprovedPlanFixture(ARTIFACTS_DIR, st);
    await new StateStore(ARTIFACTS_DIR).saveState(st);
    await harness.acknowledgeResume();
    await writeFile(
      join(ARTIFACTS_DIR, "clarification_resolution.json"),
      JSON.stringify([
          {
            unit_id: "B1",
            action: "reject_finding",
            rationale: "Not a real issue.",
          },
      ]),
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
    expect(finalState.items.B1.status).toBe("deemed_inappropriate");
    expect(finalState.items.B2.status).toBe("blocked");
    expect(finalState.items.B2.failure_reason ?? "").toMatch(
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
    st.host_handoff = {
      contract_version: "remediation-host-handoff-record/v1alpha2",
      scope_semantics: "explicit-directory-markers/v1",
      // The run id is the plan id (stateRunId), so the record belongs to THIS
      // run — the failure under test is the digest mismatch, not a foreign run.
      run_id: "PLAN-DC",
      baseline_commit: "a".repeat(40),
      workload_sha256: "b".repeat(64),
      work_item_ids: ["B1"],
    };
    await harness.writeIntentCheckpoint();
    await writeApprovedPlanFixture(ARTIFACTS_DIR, st);
    await new StateStore(ARTIFACTS_DIR).saveState(st);
    await harness.acknowledgeResume();
    await writeFile(
      join(ARTIFACTS_DIR, "clarification_resolution.json"),
      JSON.stringify([
          {
            unit_id: "B1",
            action: "clarified",
            rationale: "Narrow the fix to the module boundary.",
          },
      ]),
      "utf8",
    );

    await decideNextStep({ root: REPO_DIR });

    const finalState = JSON.parse(
      await readFile(join(ARTIFACTS_DIR, "state.json"), "utf8"),
    );
    // The answer landed (and the prepare above did not throw on the stale
    // record)...
    expect(finalState.items.B1.status).toBe("pending");
    expect(finalState.items.B1.clarification_context).toBe(
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

describe("clarification scope delta preserves reviewed execution authority", () => {
  const harness = createNextStepHarness(".test-clarification-scope-delta");
  const { REPO_DIR, ARTIFACTS_DIR } = harness;

  beforeEach(async () => {
    await harness.resetTestRepo();
  });
  afterEach(async () => {
    await harness.cleanupTestRepo();
  });

  function needsClarificationState() {
    const blocks = [{ ...block("B1", ["F1"]), allowed_files: ["src/F1.ts"] }];
    return stateWith(blocks, { F1: item("F1", "B1", "needs_clarification") });
  }

  it("a clarification cannot widen a unit without a newly reviewed semantic revision", async () => {
    const st = needsClarificationState();
    st.host_handoff = {
      contract_version: "remediation-host-handoff-record/v1alpha2",
      scope_semantics: "explicit-directory-markers/v1",
      run_id: "PLAN-DC",
      baseline_commit: "a".repeat(40),
      workload_sha256: "b".repeat(64),
      work_item_ids: ["B1"],
    };
    await harness.writeIntentCheckpoint();
    await writeApprovedPlanFixture(ARTIFACTS_DIR, st);
    await new StateStore(ARTIFACTS_DIR).saveState(st);
    await harness.acknowledgeResume();
    await writeFile(
      join(ARTIFACTS_DIR, "clarification_resolution.json"),
      JSON.stringify([
          {
            unit_id: "B1",
            action: "clarified",
            rationale: "Also create the pinning test and the shared helper.",
            scope_additions: ["tests/f1-pin.test.ts", "src/shared/f1Helper.ts"],
          },
      ]),
      "utf8",
    );

    await decideNextStep({ root: REPO_DIR });

    const finalState = JSON.parse(
      await readFile(join(ARTIFACTS_DIR, "state.json"), "utf8"),
    );
    expect(finalState.items.B1.status).toBe("needs_clarification");
    expect(finalState.plan.units.find((unit: { id: string }) => unit.id === "B1").allowed_files).toEqual(["src/F1.ts"]);
    expect(finalState.plan.review_revision_sha256).toBe(st.plan!.review_revision_sha256);

  });

  it("an invalid scope delta refuses the WHOLE resolution file and applies nothing", async () => {
    const st = needsClarificationState();
    await harness.writeIntentCheckpoint();
    await writeApprovedPlanFixture(ARTIFACTS_DIR, st);
    await new StateStore(ARTIFACTS_DIR).saveState(st);
    await harness.acknowledgeResume();
    await writeFile(
      join(ARTIFACTS_DIR, "clarification_resolution.json"),
      JSON.stringify([
          {
            unit_id: "B1",
            action: "clarified",
            rationale: "Widen.",
            scope_additions: ["../outside-the-repo.ts"],
          },
      ]),
      "utf8",
    );

    const step = await decideNextStep({ root: REPO_DIR });

    const finalState = JSON.parse(
      await readFile(join(ARTIFACTS_DIR, "state.json"), "utf8"),
    );
    // Nothing applied: the item still awaits its answer; the scope is unchanged.
    expect(finalState.items.B1.status).toBe("needs_clarification");
    const b1 = finalState.plan.units.find(
      (b: { id: string }) => b.id === "B1",
    );
    expect(b1.allowed_files).toEqual(["src/F1.ts"]);
    // The file was refused (renamed away), and the run re-halts on the question.
    expect(existsSync(join(ARTIFACTS_DIR, "clarification_resolution.json"))).toBe(false);
    expect(step.status).toBe("blocked");
  });

  it("a clarification that re-adds an in-scope file leaves the reviewed revision intact, so the run proceeds instead of wedging", async () => {
    const st = stateWith([{ ...block("B1", ["F1"]), allowed_files: ["src/b.ts", "src/a.ts"] }], { F1: item("F1", "B1", "needs_clarification") });
    await mkdir(join(REPO_DIR, "src"), { recursive: true });
    await writeFile(join(REPO_DIR, "src", "a.ts"), "export const a = 1;\n", "utf8");
    await writeFile(join(REPO_DIR, "src", "b.ts"), "export const b = 1;\n", "utf8");
    await harness.writeIntentCheckpoint();
    await writeApprovedPlanFixture(ARTIFACTS_DIR, st);
    await new StateStore(ARTIFACTS_DIR).saveState(st);
    await harness.acknowledgeResume();
    await writeFile(join(ARTIFACTS_DIR, "clarification_resolution.json"), JSON.stringify([
      { unit_id: "B1", action: "clarified", rationale: "Touch a.ts as already planned.", scope_additions: ["src/a.ts"] },
    ]), "utf8");

    const step = await decideNextStep({ root: REPO_DIR });

    const finalState = JSON.parse(await readFile(join(ARTIFACTS_DIR, "state.json"), "utf8")) as RemediationState;
    expect(finalState.items!.B1!.status).not.toBe("needs_clarification");
    expect(finalState.plan!.units.find(unit => unit.id === "B1")!.allowed_files).toEqual(["src/b.ts", "src/a.ts"]);
    await expect(assertApprovedRuntimePlan(ARTIFACTS_DIR, finalState)).resolves.toBeDefined();
    expect(step.stop_condition).not.toMatch(/plan\/review issue/);
    expect(await readFile(step.prompt_path, "utf8")).not.toMatch(/does not match the current independently approved revision/);
  });
});
