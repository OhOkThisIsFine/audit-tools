// sites-pinned: tests/remediate/gate-submit.test.ts, tests/remediate/clarification-submit.test.ts
import { join } from "node:path";
import { isRecord, writeJsonFile } from "audit-tools/shared";
import { StateStore } from "../state/store.js";
import { validateTriageResolution } from "../validation/remediationState.js";
import { parsePlanClarificationResolutions, planClarificationRefusal, pausedClarifications } from "./clarificationResolution.js";

export const SUPPORTED_REMEDIATION_GATE_SUBMISSIONS = ["triage", "clarification"] as const;

/** Admission only: the existing phase owns decision application and revalidation. */
export async function submitRemediationGateResult(params: { artifactsDir: string; lane: string; source: string }) {
  const refuse = (code: string, message: string) => ({ written: false, issues: [{ code, message }] });
  if (params.lane !== "triage" && params.lane !== "clarification") {
    return refuse("unsupported_lane", "Only triage and clarification gate submissions are supported.");
  }
  let value: unknown;
  try { value = JSON.parse(params.source); }
  catch { return refuse("invalid_json", "Gate result must be valid JSON."); }
  const state = await new StateStore(params.artifactsDir).loadState();
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
