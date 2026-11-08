// sites-pinned: tests/audit/gate-submit.test.ts
import { writeJsonFile } from "audit-tools/shared";
import { GATE_LANES, laneSubmissionPath } from "./laneSubmissions.js";
import { laneSubmissionValidator } from "./laneValidators.js";
import { auditLaneReviewRequirement } from "./reviewSubmission.js";
import { loadArtifactBundle } from "../io/artifacts.js";
import { deriveIntentEquivalenceStatus, type IntentEquivalenceVerdictSubmission } from "../orchestrator/intentEquivalenceExecutor.js";

/** Ordinary lanes with complete admission checks; other lanes retain their existing routes. */
export const SUPPORTED_GATE_SUBMISSIONS = [GATE_LANES.synthesis_narrative, GATE_LANES.critical_flow_fallback, GATE_LANES.intent_equivalence, GATE_LANES.edge_reasoning] as const;

export async function submitGateResult(params: { artifactsDir: string; lane: string; source: string }) {
  if (!SUPPORTED_GATE_SUBMISSIONS.some(lane => lane === params.lane) || auditLaneReviewRequirement(params.lane) !== "ordinary") {
    return { written: false, issues: [{ code: "unsupported_lane", message: `Only ${SUPPORTED_GATE_SUBMISSIONS.join(", ")} gate submissions are supported.` }] };
  }
  let value: unknown;
  try { value = JSON.parse(params.source); }
  catch { return { written: false, issues: [{ code: "invalid_json", message: "Gate result must be valid JSON." }] }; }
  const validate = laneSubmissionValidator(params.lane, { repoFiles: new Set() });
  if (!validate) throw new Error(`No submission validator for ${params.lane}`);
  const issue = validate(value);
  if (issue) return { written: false, issues: [issue] };
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
