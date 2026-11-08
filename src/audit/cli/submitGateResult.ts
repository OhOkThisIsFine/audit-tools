// sites-pinned: tests/audit/gate-submit.test.ts
import { writeJsonFile } from "audit-tools/shared";
import { GATE_LANES, laneSubmissionPath } from "./laneSubmissions.js";
import { laneSubmissionValidator } from "./laneValidators.js";
import { auditLaneReviewRequirement } from "./reviewSubmission.js";

/** Only these schema-only ordinary lanes are supported; other lanes retain their existing routes. */
export const SUPPORTED_GATE_SUBMISSIONS = [GATE_LANES.synthesis_narrative, GATE_LANES.critical_flow_fallback] as const;

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
  const path = laneSubmissionPath(params.artifactsDir, params.lane);
  await writeJsonFile(path, value);
  return { written: true, path, issues: [] };
}
