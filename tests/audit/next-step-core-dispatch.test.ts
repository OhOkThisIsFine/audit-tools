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
    expect(prompt).toMatch(/provider-neutral workload/i);
    expect(prompt).toMatch(/next-step/);
    const promptWithoutNeutralClaim = prompt.replace(/provider-neutral/gi, "");
    expect(promptWithoutNeutralClaim).not.toMatch(
      /merge-and-ingest|\bprovider\b|\bmodel(?:_id)?\b|\b(?:route|routing)\b|\bquota\b/i,
    );
  });
});
