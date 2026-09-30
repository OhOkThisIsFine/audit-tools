import { expect, test } from "vitest";
import { buildRemediationOutcomesReport } from "../../src/remediate/phases/close.js";
import { RemediationOutcomesReportSchema } from "../../src/shared/types/remediationOutcome.js";
import type { RemediationState } from "../../src/remediate/state/store.js";
const receipt = { requirement: "independent", binding: "b".repeat(64), review: { mode: "independent", reason: "Fresh independent context" }, summary: "The obligation evidence satisfies the carried contracts" } as const;
const contractReviews = [{ artifact: "judge_report", role: "judge", requirement: "independent", prompt_sha256: "a".repeat(64), review: { mode: "independent", reason: "Separate adjudicator context" }, reviewed_content_hash: "c".repeat(32) }];
const item = { finding_id: "F", block_id: "B", status: "resolved" as const, conformance_review: receipt };
const state: RemediationState = { status: "complete", items: { F: item } };
const closing = { contract_version: "remediate-code-closing-result/v1alpha1", action: "none", status: "skipped", commands: [] } as const;
test("machine outcomes retain both accepted contract and result review provenance", () => {
  const report = Reflect.apply(buildRemediationOutcomesReport, undefined, [state, closing, undefined, undefined, contractReviews]);
  expect(report).toHaveProperty("contract_reviews", contractReviews);
  expect(report.outcomes[0]).toHaveProperty("conformance_review", receipt);
  const parsed = RemediationOutcomesReportSchema.parse(report);
  expect(parsed).toHaveProperty("contract_reviews", contractReviews);
  expect(parsed.outcomes[0]).toHaveProperty("conformance_review", receipt);
});
test("legacy and default-off outcomes do not fabricate reviewed success", () => {
  const report = Reflect.apply(buildRemediationOutcomesReport, undefined, [{ status: "complete", items: { F: { finding_id: "F", block_id: "B", status: "resolved" } } }, closing]);
  expect(report).not.toHaveProperty("contract_reviews");
  expect(report.outcomes[0]).not.toHaveProperty("conformance_review");
});

import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runClosePhase } from "../../src/remediate/phases/close.js";
import { writeContractArtifact } from "../../src/remediate/contractPipeline/artifactStore.js";
import { CONTRACT_PIPELINE_JUDGE_REPORT_VERSION } from "../../src/shared/types/contractPipeline/obligations.js";

test("successful cleanup retains review evidence in machine outcomes and declared-context human report", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-outcome-close-"));
  const artifactsDir = join(root, ".audit-tools", "remediation");
  try {
    await mkdir(artifactsDir, { recursive: true });
    await writeContractArtifact(artifactsDir, "judge_report", { contract_version: CONTRACT_PIPELINE_JUDGE_REPORT_VERSION, goal_id: "G", verdict: "approved", classifications: [], created_at: "2026-01-01T00:00:00Z" }, {
      requirement: "independent", prompt_sha256: "a".repeat(64), review: { mode: "independent", reason: "Separate adjudicator context" },
    });
    const closingState: RemediationState = { ...state, status: "closing", plan: { plan_id: "P", findings: [], blocks: [], project_type: "unknown", candidate_closing_actions: ["none"] }, closing_plan: { action: "none" } };
    await runClosePhase(closingState, { root, artifactsDir });
    const report = RemediationOutcomesReportSchema.parse(JSON.parse(await readFile(join(root, ".audit-tools", "remediation-outcomes.json"), "utf8")));
    expect(report).toHaveProperty("contract_reviews.0.role", "judge");
    expect(report.outcomes[0]).toHaveProperty("conformance_review.binding", receipt.binding);
    const markdown = await readFile(join(root, ".audit-tools", "remediation-report.md"), "utf8");
    expect(markdown).toContain("Declared Review Context");
    expect(markdown).toContain("not verified reviewer identities");
    expect(existsSync(artifactsDir)).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
