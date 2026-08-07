// Deferred clarification round: a worker question waits for the END of the
// implement phase instead of freezing the run the moment it is merged.
//
// Two properties, plus the discriminator that makes them safe together:
//  (a) a `needs_clarification` item no longer halts sibling progress — the merge
//      routes back to `implementing` while any work remains, and the very next
//      next-step dispatches the sibling instead of asking the operator;
//  (b) a DEPENDENT of a `needs_clarification` item is NOT marked `blocked` by the
//      dead-end sweep — "awaiting an answer" must never be recorded as "upstream
//      failed". The sweep's discriminator is `dependencyAwaitingClarification`.
//
// `quota_paused` is a SEPARATE mid-phase halt (partial_completion_terminal) and is
// untouched by any of this.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { StateStore } from "../../src/remediate/state/store.js";
import type { RemediationState } from "../../src/remediate/state/store.js";
import type {
  RemediationBlock,
  RemediationItemState,
} from "../../src/remediate/state/types.js";
import { mergeImplementResults } from "../../src/remediate/steps/dispatch.js";
import { decideNextStep } from "../../src/remediate/steps/nextStep.js";
import { dependencyAwaitingClarification } from "../../src/remediate/steps/stepUtils.js";
import {
  REMEDIATION_DISPATCH_PLAN_CONTRACT_VERSION,
  REMEDIATION_WORKER_RESULT_CONTRACT_VERSION,
} from "../../src/remediate/steps/types.js";
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
    item_spec: {
      finding_id: findingId,
      concrete_change: `fix ${findingId}`,
      no_change: false,
      touched_files: [`src/${findingId}.ts`],
      tests_to_write: [],
      not_applicable_steps: [],
    },
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

describe("dependencyAwaitingClarification: awaiting-an-answer vs upstream-failed", () => {
  const blocks = [block("B1", ["F1"]), block("B2", ["F2"], ["B1"])];

  it("holds a dependent whose prerequisite is awaiting a clarification answer", () => {
    const st = stateWith(blocks, {
      F1: item("F1", "B1", "needs_clarification"),
      F2: item("F2", "B2", "pending"),
    });
    expect(dependencyAwaitingClarification(blocks[1], st, new Set())).toBe(true);
  });

  it("does NOT hold a dependent whose prerequisite was skipped or blocked", () => {
    for (const failed of ["ignored", "deemed_inappropriate", "blocked"] as const) {
      const st = stateWith(blocks, {
        F1: item("F1", "B1", failed),
        F2: item("F2", "B2", "pending"),
      });
      expect(dependencyAwaitingClarification(blocks[1], st, new Set())).toBe(false);
    }
  });

  it("propagates transitively down a chain (A→B→C, C awaiting)", () => {
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
    expect(dependencyAwaitingClarification(chain[2], st, new Set())).toBe(true);
  });

  it("reports a cyclic edge as NOT awaiting, so cycles still dead-end", () => {
    const cyclic = [block("B1", ["F1"], ["B2"]), block("B2", ["F2"], ["B1"])];
    const st = stateWith(cyclic, {
      F1: item("F1", "B1", "pending"),
      F2: item("F2", "B2", "pending"),
    });
    expect(dependencyAwaitingClarification(cyclic[0], st, new Set())).toBe(false);
  });

  it("a verified-complete prerequisite is simply satisfied, never 'awaiting'", () => {
    const st = stateWith(blocks, {
      F1: item("F1", "B1", "resolved"),
      F2: item("F2", "B2", "pending"),
    });
    expect(dependencyAwaitingClarification(blocks[1], st, new Set())).toBe(false);
  });
});

// ===========================================================================
// (a) a needs_clarification item does not halt sibling progress
// ===========================================================================

describe("(a) a worker question does not freeze its siblings", () => {
  const harness = createNextStepHarness(".test-deferred-clarification-siblings");
  const { REPO_DIR, ARTIFACTS_DIR } = harness;
  const runId = "PLAN-DC";

  beforeEach(async () => {
    await harness.resetTestRepo();
  });
  afterEach(async () => {
    await harness.cleanupTestRepo();
  });

  /** Merge a worker result that reports `needs_clarification` for F1 only. */
  async function mergeQuestionForF1(): Promise<RemediationState> {
    const resultDir = join(ARTIFACTS_DIR, "runs", runId, "implement");
    await mkdir(resultDir, { recursive: true });
    const resultPath = join(resultDir, "implement-B1.result.json");
    await writeFile(
      join(resultDir, "dispatch-plan.json"),
      JSON.stringify({
        contract_version: REMEDIATION_DISPATCH_PLAN_CONTRACT_VERSION,
        phase: "implement",
        run_id: runId,
        repo_root: REPO_DIR,
        artifacts_dir: ARTIFACTS_DIR,
        items: [
          {
            task_id: "implement-B1",
            block_id: "B1",
            prompt_path: join(resultDir, "implement-B1.md"),
            result_path: resultPath,
          },
        ],
      }),
    );
    await writeFile(
      resultPath,
      JSON.stringify({
        contract_version: REMEDIATION_WORKER_RESULT_CONTRACT_VERSION,
        phase: "implement",
        item_results: [
          {
            finding_id: "F1",
            status: "needs_clarification",
            clarification_question: "How far should the boundary refactor reach?",
          },
        ],
      }),
    );
    return mergeImplementResults(
      { root: REPO_DIR, artifactsDir: ARTIFACTS_DIR },
      runId,
    );
  }

  it("the merge keeps the run implementing while an independent sibling is pending", async () => {
    // B1 (question) and B2 (independent, still pending, never dispatched).
    const st = stateWith([block("B1", ["F1"]), block("B2", ["F2"])], {
      F1: item("F1", "B1", "pending"),
      F2: item("F2", "B2", "pending"),
    });
    await new StateStore(ARTIFACTS_DIR).saveState(st);

    const merged = await mergeQuestionForF1();

    // The question is recorded and the item paused...
    expect(merged.items?.F1.status).toBe("needs_clarification");
    expect(merged.clarifications?.[0]).toMatchObject({ finding_id: "F1" });
    // ...but the run is NOT frozen: the sibling's remaining work outranks it.
    expect(merged.status).toBe("implementing");
    expect(merged.items?.F2.status).toBe("pending");
  });

  it("the next step dispatches the sibling instead of asking the operator", async () => {
    const st = stateWith([block("B1", ["F1"]), block("B2", ["F2"])], {
      F1: item("F1", "B1", "pending"),
      F2: item("F2", "B2", "pending"),
    });
    await new StateStore(ARTIFACTS_DIR).saveState(st);
    await harness.acknowledgeResume();
    await harness.writeIntentCheckpoint();

    await mergeQuestionForF1();

    const step = await decideNextStep({
      root: REPO_DIR,
      hostCanDispatchSubagents: false,
    });

    expect(step.step_kind).toBe("implement_rolling_sequential");
    const plan = JSON.parse(
      await readFile(step.artifact_paths!.dispatch_plan as string, "utf8"),
    );
    expect(plan.items.map((i: { block_id: string }) => i.block_id)).toEqual(["B2"]);
  });

  it("the deferred question IS asked once the implement frontier drains", async () => {
    // Same shape, but the sibling already finished: nothing is left to dispatch,
    // so the batched clarification round fires at the phase boundary.
    const st = stateWith([block("B1", ["F1"]), block("B2", ["F2"])], {
      F1: item("F1", "B1", "pending"),
      F2: item("F2", "B2", "resolved"),
    });
    await new StateStore(ARTIFACTS_DIR).saveState(st);
    await harness.acknowledgeResume();
    await harness.writeIntentCheckpoint();

    const merged = await mergeQuestionForF1();
    expect(merged.status).toBe("waiting_for_clarification");

    const step = await decideNextStep({ root: REPO_DIR });
    expect(step.step_kind).toBe("collect_clarifications");
  });
});

// ===========================================================================
// (b) a dependent of a needs_clarification item is not dead-ended
// ===========================================================================

describe("(b) the dead-end sweep does not blame an unanswered question", () => {
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
// (c) a consumed `clarified` answer retires the stale question result
// (accept/reverify cluster defect 6): the worker's needs_clarification result
// file survives at the block's constant result_path, so a re-entered merge
// re-reads it, flips the answered item BACK to needs_clarification, and
// re-asks the operator the same question.
// ===========================================================================

describe("(c) a consumed clarified answer retires the stale question result", () => {
  const harness = createNextStepHarness(".test-deferred-clarification-stale");
  const { REPO_DIR, ARTIFACTS_DIR } = harness;
  const runId = "PLAN-DC";

  beforeEach(async () => {
    await harness.resetTestRepo();
  });
  afterEach(async () => {
    await harness.cleanupTestRepo();
  });

  it("archives the needs_clarification result on consume; a re-merge does not re-ask", async () => {
    const st = stateWith([block("B1", ["F1"]), block("B2", ["F2"])], {
      F1: item("F1", "B1", "pending"),
      F2: item("F2", "B2", "resolved"),
    });
    await new StateStore(ARTIFACTS_DIR).saveState(st);
    await harness.acknowledgeResume();
    await harness.writeIntentCheckpoint();

    const resultDir = join(ARTIFACTS_DIR, "runs", runId, "implement");
    await mkdir(resultDir, { recursive: true });
    const resultPath = join(resultDir, "implement-B1.result.json");
    await writeFile(
      join(resultDir, "dispatch-plan.json"),
      JSON.stringify({
        contract_version: REMEDIATION_DISPATCH_PLAN_CONTRACT_VERSION,
        phase: "implement",
        run_id: runId,
        repo_root: REPO_DIR,
        artifacts_dir: ARTIFACTS_DIR,
        items: [
          {
            task_id: "implement-B1",
            block_id: "B1",
            prompt_path: join(resultDir, "implement-B1.md"),
            result_path: resultPath,
          },
        ],
      }),
    );
    await writeFile(
      resultPath,
      JSON.stringify({
        contract_version: REMEDIATION_WORKER_RESULT_CONTRACT_VERSION,
        phase: "implement",
        item_results: [
          {
            finding_id: "F1",
            status: "needs_clarification",
            clarification_question: "How far should the boundary refactor reach?",
          },
        ],
      }),
    );
    const merged = await mergeImplementResults(
      { root: REPO_DIR, artifactsDir: ARTIFACTS_DIR },
      runId,
    );
    expect(merged.status).toBe("waiting_for_clarification");

    // The operator answers `clarified` — the item re-opens pending.
    await writeFile(
      join(ARTIFACTS_DIR, "clarification_resolution.json"),
      JSON.stringify({
        resolutions: [
          { finding_id: "F1", action: "clarified", rationale: "Reach only the module boundary." },
        ],
      }),
      "utf8",
    );
    // The consume persists state BEFORE the drain moves on to re-dispatching the
    // re-opened item; the minimal harness repo cannot host that dispatch (no git
    // worktree), which is irrelevant to the property under test.
    await decideNextStep({ root: REPO_DIR, hostCanDispatchSubagents: false }).catch(
      () => undefined,
    );

    const afterConsume = JSON.parse(
      await readFile(join(ARTIFACTS_DIR, "state.json"), "utf8"),
    );
    expect(afterConsume.items.F1.status).toBe("pending");
    // The stale question result is ARCHIVED at consume time — absent means
    // "worker hasn't run yet → re-dispatch from scratch", the benign branch.
    expect(existsSync(resultPath)).toBe(false);

    // A re-entered merge (crash-recovery / reverify re-finalize) must NOT
    // resurrect the consumed question from the stale file.
    const remerged = await mergeImplementResults(
      { root: REPO_DIR, artifactsDir: ARTIFACTS_DIR },
      runId,
    );
    expect(remerged.items?.F1.status).not.toBe("needs_clarification");
    expect(remerged.clarifications ?? []).toEqual([]);
  });
});
