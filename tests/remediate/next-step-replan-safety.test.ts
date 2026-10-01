import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { join } from "node:path";
import { readOptionalJsonFile, writeJsonFile } from "../../src/shared/index.js";
import { buildNextContractPipelineStep } from "../../src/remediate/steps/contractPipeline.js";
import { changeOperatorLifecycle, decideNextStep } from "../../src/remediate/steps/nextStep.js";
import { executionPlanPaths, ingestExecutionPlan, readCanonicalPlan, readApprovedExecutionPlan } from "../../src/remediate/contractPipeline/executionPlan.js";
import { StateStore } from "../../src/remediate/state/store.js";
import { createNextStepHarness } from "./helpers/nextStepHarness.js";

const h = createNextStepHarness(".test-replan-owner-decisions");
const options = { root: h.REPO_DIR, artifactsDir: h.ARTIFACTS_DIR, finalGateRunner: h.finalGateRunner };
beforeEach(async () => { await h.resetTestRepo(); await h.writeIntentCheckpoint(); });
afterEach(h.cleanupTestRepo);

describe("reviewed replanning preserves owner choices", () => {
  test.each(["pending", "resolved_no_change"] as const)("replanning applies current owner choices once while preserving %s history", async status => {
    await h.writeApprovedExecutionPlan();
    await decideNextStep({ ...options, planOnly: true });
    const store = new StateStore(h.ARTIFACTS_DIR);
    const previous = (await store.loadState())!;
    const canonical = (await readCanonicalPlan(h.ARTIFACTS_DIR))!;
    const original = canonical.plan.units[0]!;
    const originalItem = status === "pending" ? { unit_id: original.id, status, rework_count: 2 } : {
      unit_id: original.id, status, host_result_evidence: ["Accepted source observation proves no change is needed"],
      completed_at: "2026-09-30T00:00:00.000Z",
    };
    previous.items![original.id] = originalItem;
    await store.saveState(previous);
    await changeOperatorLifecycle({ ...options, action: "resume" });
    await h.acknowledgeResume();

    const second = { ...original, id: "CP-follow-up", title: "Add follow-up coverage", description: "Extend the reviewed acceptance coverage" };
    const revised = { ...canonical.plan, objective: "Preserve the accepted auth work and add follow-up coverage", units: [original, second] };
    const paths = executionPlanPaths(h.ARTIFACTS_DIR);
    await writeJsonFile(paths.submission, { base_revision_sha256: canonical.revision_sha256, plan: revised, retired_requirements: [] });
    expect((await ingestExecutionPlan(options)).issues).toEqual([]);
    const revision = (await readCanonicalPlan(h.ARTIFACTS_DIR))!.revision_sha256;
    await writeJsonFile(join(paths.directory, "owner-decision.json"), {
      revision_sha256: revision, confirmed_by: "host", approved_unit_ids: [second.id],
      declined_units: [{ id: original.id, reason: "Only implement the newly requested follow-up" }],
    });
    const reviewOptions = { ...options, runId: revised.plan_id };
    for (const role of ["critique", "critic", "judge"] as const) {
      await buildNextContractPipelineStep(reviewOptions);
      const request = (await readOptionalJsonFile<{ prompt_sha256: string }>(paths.review(role).request))!;
      const result = role === "critique" ? { verdict: "approved", issues: [] } : role === "critic" ? { counterexamples: [] } : {
        verdict: "approved", classifications: [], disposition_assessments: [],
        requirement_assessments: revised.requirements.map(requirement => ({ requirement_id: requirement.id, verdict: "satisfied", evidence: ["Reviewed scope and acceptance assertions"] })),
      };
      await writeJsonFile(paths.review(role).submission, { contract_version: "review-submission/v1", prompt_sha256: request.prompt_sha256,
        review: { mode: "independent", reason: "Independent fixture review of the revised executable plan" }, result });
    }
    expect(await buildNextContractPipelineStep(reviewOptions)).toBeNull();
    expect(await readApprovedExecutionPlan(h.ARTIFACTS_DIR)).toBeDefined();

    // Enter through real next-step activation, including its replan preamble.
    await decideNextStep({ ...options, forceReplan: true, planOnly: true });
    const activated = (await store.loadState())!;
    expect(activated.plan!.review_revision_sha256).toBe(revision);
    if (status === "pending") {
      expect(activated.items![original.id]!.status).toBe("ignored");
      expect(activated.items![original.id]!.failure_reason).toBe("Only implement the newly requested follow-up");
    } else {
      expect(activated.items![original.id]).toEqual(originalItem);
    }
    expect(activated.items![second.id]!.status).toBe("pending");

    await changeOperatorLifecycle({ ...options, action: "resume" });
    const step = await decideNextStep(options);
    expect(step.step_kind).toBe("dispatch_implement");
    const workload = await readOptionalJsonFile<{ work_items: Array<{ id: string }> }>(step.artifact_paths.host_workload!);
    expect(workload!.work_items.map(item => item.id)).toEqual([second.id]);
  });
});
