import { test, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { HEAVY_AUDIT_TEST_TIMEOUT_MS } from "../helpers/heavy-timeout.mjs";
import {
  advancePastDesignReview,
  withTempRepo,
} from "./helpers/next-step-harness.js";

test.concurrent("next-step publishes a provider-neutral semantic-review workload", { timeout: HEAVY_AUDIT_TEST_TIMEOUT_MS }, async () => {
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
    expect(step.artifact_paths.host_result_map).toMatch(/host-result-map\.json$/);
    expect(prompt).toMatch(/Read the workload at:/);
    expect(prompt).toMatch(/next-step/);
    // The PROPERTY is the absence of execution vocabulary, not the presence of
    // the words "provider-neutral". The prompt used to carry that label and the
    // assertion then had to strip it back out before it could check for the word
    // "provider" — a wording assertion guarding itself. Owner review of prompt
    // 13, 2026-09-17: the host needs the path, not the architecture label.
    expect(prompt).not.toMatch(
      /merge-and-ingest|\bprovider\b|\bmodel(?:_id)?\b|\b(?:route|routing)\b|\bquota\b/i,
    );
  });
});
