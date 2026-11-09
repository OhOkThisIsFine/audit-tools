// sites-pinned: tests/audit/gate-submit.test.ts, tests/audit/charter-clarification-submit.test.ts, tests/audit/contract-gate-submit.test.ts
import { ClarificationAnswersSubmissionSchema, writeJsonFile } from "audit-tools/shared";
import { GATE_LANES, laneSubmissionPath } from "./laneSubmissions.js";
import { laneSubmissionValidator, parseSubmissionArrayItems, unwrapSubmissionArray } from "./laneValidators.js";
import { decodeAuditReviewSubmission, ReviewUnavailableError } from "./reviewSubmission.js";
import { loadArtifactBundle } from "../io/artifacts.js";
import { deriveIntentEquivalenceStatus, type IntentEquivalenceVerdictSubmission } from "../orchestrator/intentEquivalenceExecutor.js";
import { refuseUnaskedRequestIds } from "../orchestrator/charterClarificationExecutor.js";
import { charterClarificationOmits } from "../orchestrator/obligationPolicy.js";
import { designReviewInputRevision } from "../orchestrator/designReviewProjection.js";
import { SubmittedDesignFindingSchema } from "../types/conceptualAdjudication.js";
import { withArtifactTreeHold } from "../../shared/io/artifactTreeHold.js";

/** Lanes with complete admission checks; other lanes retain their existing routes. */
export const SUPPORTED_GATE_SUBMISSIONS = [GATE_LANES.synthesis_narrative, GATE_LANES.critical_flow_fallback, GATE_LANES.intent_equivalence, GATE_LANES.edge_reasoning, GATE_LANES.charter_clarification, GATE_LANES.design_review_contract] as const;

async function submitContractReview(artifactsDir: string, raw: unknown) {
  const lane = GATE_LANES.design_review_contract;
  return withArtifactTreeHold(artifactsDir, undefined, async assertOwnership => {
    let decoded;
    try {
      decoded = await decodeAuditReviewSubmission(artifactsDir, lane, raw,
        async () => designReviewInputRevision(await loadArtifactBundle(artifactsDir)));
    } catch (error) {
      if (!(error instanceof ReviewUnavailableError)) throw error;
      return { written: false, issues: [{ code: "review_unavailable", message: error.message }] };
    }
    if (!decoded.ok) return { written: false, issues: [{ code: decoded.code, message: decoded.issue }] };
    const unwrapped = unwrapSubmissionArray(decoded.result);
    const parsed = unwrapped.ok ? parseSubmissionArrayItems(unwrapped.array, SubmittedDesignFindingSchema) : unwrapped;
    if (!parsed.ok) return { written: false, issues: [{ code: "submission_contract_invalid", message: parsed.reason }] };
    // Store the full envelope unchanged. Consumption rechecks the binding and
    // live inputs and owns normalization, grounding and workflow advancement.
    const path = laneSubmissionPath(artifactsDir, lane);
    await assertOwnership();
    await writeJsonFile(path, raw);
    return { written: true, path, issues: [] };
  });
}

export async function submitGateResult(params: { artifactsDir: string; lane: string; source: string }) {
  if (!SUPPORTED_GATE_SUBMISSIONS.some(lane => lane === params.lane)) {
    return { written: false, issues: [{ code: "unsupported_lane", message: `Only ${SUPPORTED_GATE_SUBMISSIONS.join(", ")} gate submissions are supported.` }] };
  }
  let value: unknown;
  try { value = JSON.parse(params.source); }
  catch { return { written: false, issues: [{ code: "invalid_json", message: "Gate result must be valid JSON." }] }; }
  if (params.lane === GATE_LANES.design_review_contract) return submitContractReview(params.artifactsDir, value);
  const validate = laneSubmissionValidator(params.lane, { repoFiles: new Set() });
  if (!validate) throw new Error(`No submission validator for ${params.lane}`);
  const issue = validate(value);
  if (issue) return { written: false, issues: [issue] };
  if (params.lane === GATE_LANES.charter_clarification) {
    const bundle = await loadArtifactBundle(params.artifactsDir);
    const register = bundle.charter_clarification;
    if (charterClarificationOmits(bundle) || !bundle.charter_register || bundle.charter_register.status === "omitted" ||
      !register || register.status === "omitted" || !register.asked.some(question => question.answer === undefined)) {
      return { written: false, issues: [{ code: "charter_clarification_not_pending", message: "No interactive charter clarification is pending; obtain the current clarification step." }] };
    }
    try {
      // Apply schema defaults for validation, but preserve the original file
      // shape below. The executor remains the authority when consuming it.
      refuseUnaskedRequestIds(ClarificationAnswersSubmissionSchema.parse(value), register.asked);
    } catch (error) {
      return { written: false, issues: [{ code: "invalid_charter_clarification", message: error instanceof Error ? error.message : String(error) }] };
    }
  }
  if (params.lane === GATE_LANES.intent_equivalence) {
    const status = deriveIntentEquivalenceStatus(await loadArtifactBundle(params.artifactsDir));
    if (status.kind !== "prose_judgment_pending") {
      return { written: false, issues: [{ code: "intent_judgment_not_pending", message: `No prose intent judgment is pending (${status.kind}).` }] };
    }
    const verdict = value as IntentEquivalenceVerdictSubmission; // Validated by the lane's shared schema above.
    if (verdict.judged_pair.prior_hash !== status.prior_hash || verdict.judged_pair.new_hash !== status.new_hash) {
      return { written: false, issues: [{ code: "stale_intent_pair", message: "Intent verdict does not judge the current pair; obtain the current intent-equivalence step." }] };
    }
    // Admission stores a submission, not a resolution. The executor rechecks the
    // live pair at consumption, including changes after this preflight.
  }
  const path = laneSubmissionPath(params.artifactsDir, params.lane);
  await writeJsonFile(path, value);
  return { written: true, path, issues: [] };
}
