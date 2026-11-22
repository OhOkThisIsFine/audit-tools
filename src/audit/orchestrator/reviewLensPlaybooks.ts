// sites-pinned: tests/audit/intent-checkpoint.test.ts
import type { BuiltInReviewLens } from "../../shared/types/reviewQuestion.js";

/** One home for the seven assignment/result questions; no additional lens minimum. */
export const REVIEW_LENS_PLAYBOOKS = {
  behavior: "Establish the supported outcome and resulting state. Check ordinary execution, meaningful interruption and retry, and state preservation against an independent expectation.",
  security: "Trace the caller and input through the authority decision to the protected action or data. Use static evidence and authorized synthetic defensive tests, not live probing.",
  architecture: "Compare the current design and local maintainability with the goal and a concrete alternative. Explain unnecessary dependencies or duplicated decisions; distinguish opportunities from demonstrated defects.",
  performance: "Choose a representative workload and resource; distinguish measured cost from a source hypothesis and identify work worth removing.",
  operability: "Compare observable outcomes and advice with actual state. Determine whether an operator can distinguish wait, retry, continue, and stop when applicable.",
  config_deployment: "Trace supported runtime configuration, including for libraries and CLIs, or a real install, release, or rollback transition. Bind checks to the candidate they actually qualify.",
  tests: "Trace the product contract into actual fixtures and assertions. Identify the regression caught, important gaps, and material execution or maintenance cost.",
} satisfies Record<BuiltInReviewLens, string>;
