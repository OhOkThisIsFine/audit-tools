// sites-pinned: tests/remediate/close-plan-authority.test.ts, tests/remediate/execution-unit-runtime.test.ts, tests/remediate/executable-plan-safety.test.ts
import { stableStringify } from "audit-tools/shared";
import { errorMessage } from "../../shared/io/json.js";
import { ExecutableChangePlanSchema } from "../../shared/types/executionPlan.js";
import type { RemediationState } from "../state/store.js";
import { executionPlanRevision, readApprovedExecutionPlan, readPendingReplan } from "./executionPlan.js";

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
  let pending: Awaited<ReturnType<typeof readPendingReplan>>;
  try { pending = await readPendingReplan(artifactsDir); }
  catch (error) {
    throw new RemediationPlanAuthorityError(`The pending replan marker cannot be verified: ${errorMessage(error)}`);
  }
  if (pending) throw new RemediationPlanAuthorityError(
    "A same-source replacement is pending. Resume revision and approval before dispatch, acceptance or closing.",
  );
  return verifyPersistedRuntimePlan(artifactsDir, state);
}

/** Exact readback for next-step's activation recovery; this does not grant execution. */
export async function verifyPersistedRuntimePlan(artifactsDir: string, state: RemediationState) {
  try {
    const approved = await readApprovedExecutionPlan(artifactsDir);
    const plan = state.plan;
    if (!approved || !plan) throw new RemediationPlanAuthorityError(
      "No current independently approved executable plan exists. Restore or renew the reviewed authority before continuing.",
    );
    const semantic = ExecutableChangePlanSchema.strip().parse(plan);
    const { history } = approved;
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
      `The current reviewed plan authority cannot be verified: ${errorMessage(error)}`,
    );
  }
}
