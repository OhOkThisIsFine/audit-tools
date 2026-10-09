import { designReviewInputRevision, type DesignReviewBundle } from "../../../src/audit/orchestrator/designReviewProjection.js";
import { writeFile } from "node:fs/promises";
import { readAuditReviewBinding } from "../../../src/audit/cli/auditReviewBindings.js";
import { auditReviewBinding } from "../../../src/audit/cli/reviewSubmission.js";
import { laneSubmissionPath, GATE_LANES } from "../../../src/audit/cli/laneSubmissions.js";

/** Simulate a host copying the real emitted binding; never invent or bypass a missing request. */
export async function writeBoundReviewFixture(artifactsDir: string, lane: string, result: unknown): Promise<void> {
  const binding = await auditReviewBinding(artifactsDir, lane);
  if (binding.requirement !== "ordinary" && !binding.promptSha256) throw new Error(`Fixture has no emitted review binding for ${lane}`);
  const value = binding.requirement === "ordinary" ? result : {
    contract_version: "review-submission/v1", prompt_sha256: binding.promptSha256,
    review: { mode: "independent", reason: "Fixture models a reviewer context separate from the author." }, result,
  };
  const active = binding.requirement === "ordinary" ? undefined : await readAuditReviewBinding(artifactsDir, lane);
  await writeFile(laneSubmissionPath(artifactsDir, lane, active?.runId), JSON.stringify(value), "utf8");
}

/** Emit from the actual carried review context; transport-only tests pass an explicit empty context. */
export async function emitAndWriteReviewFixture(artifactsDir: string, lane: string, result: unknown, reviewedBundle: DesignReviewBundle): Promise<void> {
  if ((await auditReviewBinding(artifactsDir, lane)).requirement === "ordinary") {
    await writeBoundReviewFixture(artifactsDir, lane, result);
    return;
  }
  const { materializeFanoutLanes } = await import("../../../src/audit/cli/fanoutLanes.js");
  const { AUDIT_GATE_SUBMISSION_SCOPE } = await import("../../../src/audit/cli/laneSubmissions.js");
  await materializeFanoutLanes({
    artifactsDir,
    sourceRoot: artifactsDir, runId: AUDIT_GATE_SUBMISSION_SCOPE,
    lanes: [{ id: lane, label: "Fixture reviewer", promptFilename: `${lane}.md`,
      promptText: "Review the fixture's supplied domain result independently of its author.",
      semanticInputRevision: designReviewInputRevision(reviewedBundle, lane === GATE_LANES.design_review_contract ? "contract" : "conceptual"),
      fileCount: 1, riskScore: 0.8, semanticComplexity: "deep" }],
  });
  await writeBoundReviewFixture(artifactsDir, lane, result);
}
