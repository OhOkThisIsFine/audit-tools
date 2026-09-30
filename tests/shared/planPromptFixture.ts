import { ExecutableChangePlanSchema } from "../../src/shared/types/executionPlan.js";
import { CanonicalPlanSchema, PlanSourceSchema } from "../../src/remediate/contractPipeline/executionPlan.js";

export const planPromptSource = PlanSourceSchema.parse({ plan_id: "PLAN-fixture", findings: [], audit_read: null, sources: [],
  request: { id: "request-fixture", text: "Preserve API behavior", source_paths: [] } });
export const planPromptCanonical = CanonicalPlanSchema.parse({ contract_version: "remediate-code-executable-plan/v1",
  revision_sha256: "a".repeat(64), source_sha256: "b".repeat(64), context_files: [],
  plan: ExecutableChangePlanSchema.parse({ plan_id: "PLAN-fixture", objective: "Preserve API behavior", non_goals: [], requirements: [], units: [], source_dispositions: [],
    request_disposition: { status: "already_satisfied", reason: "Fixture", evidence: ["Source inspected"] } }) });
export const planPromptHistory = { counterexamples: [], accepted_ids: [], repair_rounds: 0 };
