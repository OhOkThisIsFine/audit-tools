// sites-pinned: tests/remediate/review-outcome-provenance.test.ts
import { ContractReviewOutcomeSchema, type ContractReviewOutcome } from "../../shared/types/reviewIndependence.js";
import { readContractArtifact } from "../contractPipeline/artifactStore.js";
import { PHASE_TO_ARTIFACT } from "../steps/contractPipelinePrompts.js";

/** Export only accepted canonical receipts, never raw worker responses. */
export async function readContractReviewOutcomes(artifactsDir: string): Promise<ContractReviewOutcome[]> {
  const reviews: ContractReviewOutcome[] = [];
  for (const [role, artifact] of Object.entries(PHASE_TO_ARTIFACT)) {
    const accepted = await readContractArtifact(artifactsDir, artifact);
    if (accepted?.review_provenance) {
      reviews.push(ContractReviewOutcomeSchema.parse({ artifact, role, ...accepted.review_provenance }));
    }
  }
  return reviews;
}
