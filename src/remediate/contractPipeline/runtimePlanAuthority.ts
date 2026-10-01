// sites-pinned: tests/remediate/close-plan-authority.test.ts, tests/remediate/execution-unit-runtime.test.ts, tests/remediate/executable-plan-safety.test.ts
import { stableStringify } from "audit-tools/shared";
import { ExecutableChangePlanSchema } from "../../shared/types/executionPlan.js";
import type { RemediationState } from "../state/store.js";
import { executionPlanRevision, readApprovedExecutionPlan, readPlanReviewHistory } from "./executionPlan.js";

/** A recoverable authority failure; it never invalidates or deletes accepted evidence. */
export class RemediationPlanAuthorityError extends Error {
  readonly code = "plan_repair_required" as const;
  constructor(message: string) {
    super(message);
    this.name = "RemediationPlanAuthorityError";
  }
}

/** The immutable reviewed record, not a runtime-supplied digest, grants work and closing. */
export async function assertApprovedRuntimePlan(artifactsDir: string, state: RemediationState) {
  try {
    const approved = await readApprovedExecutionPlan(artifactsDir);
    const plan = state.plan;
    if (!approved || !plan) throw new RemediationPlanAuthorityError(
      "No current independently approved executable plan exists. Restore or renew the reviewed authority before continuing.",
    );
    const semantic = ExecutableChangePlanSchema.strip().parse(plan);
    const history = await readPlanReviewHistory(artifactsDir);
    const referenced = new Set(plan.units.flatMap(unit => unit.addresses_counterexample_ids));
    const counterexamples = history.counterexamples.filter(example => referenced.has(example.id));
    if (approved.canonical.revision_sha256 !== plan.review_revision_sha256 ||
        executionPlanRevision(semantic, approved.canonical.source_sha256, approved.canonical.context_files) !== approved.canonical.revision_sha256 ||
        stableStringify(plan.findings) !== stableStringify(approved.source.findings) ||
        stableStringify(plan.request ?? null) !== stableStringify(approved.source.request ?? null) ||
        stableStringify(plan.audit_read ?? null) !== stableStringify(approved.source.audit_read) ||
        counterexamples.length !== referenced.size ||
        stableStringify(plan.review_counterexamples ?? []) !== stableStringify(counterexamples)) {
      throw new RemediationPlanAuthorityError(
        "The runtime plan or source provenance does not match the current independently approved revision. Restore the reviewed plan or submit and review the change before dispatch, acceptance or closing.",
      );
    }
    return approved;
  } catch (error) {
    if (error instanceof RemediationPlanAuthorityError) throw error;
    throw new RemediationPlanAuthorityError(
      `The current reviewed plan authority cannot be verified: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
