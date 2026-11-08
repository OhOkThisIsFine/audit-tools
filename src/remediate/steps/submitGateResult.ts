// sites-pinned: tests/remediate/gate-submit.test.ts, tests/remediate/clarification-submit.test.ts
import { join } from "node:path";
import { contentSha256, isRecord, readSubmissionDocument, writeJsonFile } from "audit-tools/shared";
import { StateStore } from "../state/store.js";
import { isTerminalStatus } from "../state/itemStatus.js";
import { validateTriageResolution } from "../validation/remediationState.js";
import { parsePlanClarificationResolutions, planClarificationRefusal, pausedClarifications } from "./clarificationResolution.js";
import { conformanceObligationsMatch, conformanceReviewPaths, parseConformanceResponse } from "./dispatch/contractConformanceReview.js";

export const SUPPORTED_REMEDIATION_GATE_SUBMISSIONS = ["triage", "clarification", "conformance_review"] as const;

/** Admission only: the existing phase owns decision application and revalidation. */
export async function submitRemediationGateResult(params: { artifactsDir: string; lane: string; source: string; workItemId?: string }) {
  const refuse = (code: string, message: string) => ({ written: false, issues: [{ code, message }] });
  if (!SUPPORTED_REMEDIATION_GATE_SUBMISSIONS.some(lane => lane === params.lane)) {
    return refuse("unsupported_lane", `Only ${SUPPORTED_REMEDIATION_GATE_SUBMISSIONS.join(", ")} gate submissions are supported.`);
  }
  let value: unknown;
  try { value = JSON.parse(params.source); }
  catch { return refuse("invalid_json", "Gate result must be valid JSON."); }
  const state = await new StateStore(params.artifactsDir).loadState();
  if (params.lane === "conformance_review") {
    const unit = state?.plan?.units.find(unit => unit.id === params.workItemId);
    if (!unit || !state?.plan || !state.items?.[unit.id] || !state.conformance_review?.enabled ||
      state.conformance_review.run_id !== state.plan.plan_id || state.status === "complete" || isTerminalStatus(state.items[unit.id].status)) {
      return refuse("conformance_not_pending", "An enabled current run and its work_item_id are required.");
    }
    const paths = conformanceReviewPaths(params.artifactsDir, state.plan.plan_id, unit.id);
    const document = await readSubmissionDocument(paths.request);
    const request = document.kind === "value" && isRecord(document.value) ? document.value : null;
    const content = request && isRecord(request.content) ? request.content : null;
    const context = content && isRecord(content.context) ? content.context : content;
    if (!request || request.schema_version !== "contract-conformance-request/v1" ||
      request.review_requirement !== "independent" || !content || !context ||
      context.run_id !== state.plan.plan_id || context.work_item_id !== unit.id ||
      context.review_revision_sha256 !== state.plan.review_revision_sha256 ||
      typeof request.binding !== "string" || request.binding !== contentSha256(content)) {
      return refuse("conformance_request_invalid", "No matching current conformance request exists; obtain the next review step.");
    }
    const review = parseConformanceResponse(value, request.binding);
    if (!review || !conformanceObligationsMatch(review, unit.requirement_ids)) {
      return refuse("invalid_conformance_review", "Review must match the request binding and assess every obligation exactly once.");
    }
    // Negative reviews are useful feedback, not acceptance. The file consumer
    // retains independence, verdict, source freshness and history ownership.
    await writeJsonFile(paths.response, value);
    return { written: true, path: paths.response, issues: [] };
  }
  if (params.lane === "clarification") {
    const pending = state ? pausedClarifications(state) : [];
    if (!state?.plan || !state.items || state.status !== "waiting_for_clarification" || pending.length === 0) {
      return refuse("clarification_not_pending", "No operator clarification is pending in this run.");
    }
    const parsed = parsePlanClarificationResolutions(value);
    const refusal = planClarificationRefusal(parsed, new Set(pending.map(question => question.unit_id)), "not waiting for a clarification");
    if (refusal !== null) return refuse("invalid_clarification", refusal);
    const path = join(params.artifactsDir, "clarification_resolution.json");
    await writeJsonFile(path, value);
    return { written: true, path, issues: [] };
  }
  if (!state?.plan || !state.items ||
    (state.status !== "triage" && state.status !== "waiting_for_triage") ||
    !Object.values(state.items).some(item => item.status === "blocked")) {
    return refuse("triage_not_pending", "No operator triage is pending in this run.");
  }
  const issues = validateTriageResolution(value, undefined, new Set(Object.keys(state.items)));
  if (issues.some(issue => issue.severity === "error")) return { written: false, issues };
  // Match the file consumer's optional correlation. Admission never archives a
  // previous submission or applies a decision; consumption checks the live plan.
  if (isRecord(value) && typeof value.plan_id === "string" && value.plan_id !== state.plan.plan_id) {
    return refuse("stale_triage_plan", "Triage decisions do not name the live plan; obtain the current triage step.");
  }
  const path = join(params.artifactsDir, "triage_resolution.json");
  await writeJsonFile(path, value);
  return { written: true, path, issues: [] };
}
