// sites-pinned: tests/remediate/review-outcome-provenance.test.ts
import { ContractReviewOutcomeSchema, type ContractReviewOutcome } from "../../shared/types/reviewIndependence.js";
import { PLAN_REVIEW_ROLES, readCanonicalPlan, readPlanReview } from "../contractPipeline/executionPlan.js";

/** Report only accepted receipts bound to the canonical executable revision. */
export async function readContractReviewOutcomes(artifactsDir: string): Promise<ContractReviewOutcome[]> {
  const canonical = await readCanonicalPlan(artifactsDir);
  if (!canonical) return [];
  const reviews: ContractReviewOutcome[] = [];
  for (const role of PLAN_REVIEW_ROLES) {
    const receipt = await readPlanReview(artifactsDir, role, canonical.revision_sha256);
    if (receipt) reviews.push(ContractReviewOutcomeSchema.parse({ artifact: "execution_plan", role, ...receipt.provenance }));
  }
  return reviews;
}
