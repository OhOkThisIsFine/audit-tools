import { test, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { readQuestionWorkload } from "./helpers/question-completion-harness.js";
import {
  advancePastDesignReview,
  withTempRepo,
} from "./helpers/next-step-harness.js";

test.concurrent("next-step publishes a provider-neutral bound question workload", async () => {
  await withTempRepo(async (root) => {
    const step = await advancePastDesignReview(root);
    const currentStep = JSON.parse(
      await readFile(join(root, ".audit-tools/audit", "steps", "current-step.json"), "utf8"),
    );
    const prompt = await readFile(step.prompt_path, "utf8");

    expect(step.step_kind).toBe("dispatch_review");
    expect(currentStep.step_kind).toBe("dispatch_review");
    expect(step.run_id).toBeTruthy();
    expect(step.artifact_paths.host_workload).toMatch(/host-workload\.json$/);
    expect(step.artifact_paths.host_result_map).toBeUndefined();
    expect(currentStep.artifact_paths.host_workload).toBe(step.artifact_paths.host_workload);
    const workload = await readQuestionWorkload(step);
    expect(workload.run_id).toBe(step.run_id);
    const resultDir = join(root, ".audit-tools", "audit", "runs", workload.run_id, "host-results");
    const destinations = new Set(workload.work_items.map(item => resolve(root, item.result_path)));
    expect(destinations.size).toBe(workload.work_items.length);
    for (const { binding: { assignment, question }, result_path } of workload.work_items) {
      expect(assignment).toMatchObject({
        question_id: question.question_id,
        revision_id: question.revision_id,
        snapshot_id: question.snapshot_id,
      });
      expect(assignment.assignment_id).toMatch(/^review-/);
      expect(dirname(resolve(root, result_path))).toBe(resultDir);
    }
    expect(prompt).toMatch(/Read only the routing metadata at:/);
    expect(step.artifact_paths.review_routing).toMatch(/review-routing\.json$/u);
    expect(prompt).toMatch(/next-step/);
    // The PROPERTY is the absence of execution vocabulary, not the presence of
    // the words "provider-neutral". The prompt used to carry that label and the
    // assertion then had to strip it back out before it could check for the word
    // "provider" — a wording assertion guarding itself. Owner review of prompt
    // 13, 2026-09-17: the host needs the path, not the architecture label.
    expect(prompt).not.toMatch(
      /merge-and-ingest|\bprovider\b|\bmodel(?:_id)?\b|\broute\b|\bquota\b/i,
    );
  });
});
