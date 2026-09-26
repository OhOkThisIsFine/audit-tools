// sites-pinned: tests/remediate/host-handoff-corroboration.test.ts
import { compareCodeUnits } from "audit-tools/shared";
import type { CurrentRemediationHostState } from "./internal.js";

/**
 * The FRONTIER a recovery verdict table describes, as a comparable identity.
 *
 * The recovery verb splits into an unlocked phase that runs the required tests
 * and a locked phase that ingests their verdicts, and it used to bind the two
 * by HEAD alone. HEAD says the TREE has not moved; it says nothing about whether
 * the RUN's own state changed underneath those unlocked spawns — and a
 * concurrent state writer can settle items without touching a single commit.
 * The verdict table phase 1 computed is keyed on which findings were PENDING
 * (`precomputeRecoveryTestVerdicts` filters on exactly that), so once the
 * frontier moves, a command the table no longer covers reads as
 * `required_test_failed` — a bookkeeping race reported as the host's work being
 * wrong. Both halves of the comparison degrade safely: a mismatch refuses.
 *
 * So the identity carries three things, and each catches a writer the others
 * cannot:
 *
 *  - the binding record's own parts (run, baseline, workload digest, item ids),
 *    which the ordinary workload-integrity check would also catch — kept here so
 *    this guard is the one place that says "the frontier moved";
 *  - the sorted set of work items with at least one still-PENDING finding, which
 *    is what the verdict table is actually keyed on. This is the residual's real
 *    shape, and no digest in the state tracks it.
 *
 * `null` means "no binding", which is itself a distinct identity: a phase-1
 * snapshot with no handoff and a phase-2 read that grew one describe different
 * runs.
 */
export function workloadBindingIdentity(
  state: CurrentRemediationHostState,
): string | null {
  const record = state.host_handoff;
  if (!record) return JSON.stringify([null, state.conformance_review_policy ?? null]);
  const pendingWorkItemIds = unresolvedFrontierWorkItemIds(state, record);
  return JSON.stringify([
    record.run_id,
    record.baseline_commit,
    record.workload_sha256,
    [...record.work_item_ids].sort(compareCodeUnits),
    pendingWorkItemIds,
    state.conformance_review_policy ?? null,
  ]);
}

/**
 * The bound work item ids with at least one finding still `pending`, sorted.
 *
 * Derived from the STATE alone — the workload document is not read, because the
 * caller may be comparing a snapshot whose workload file is no longer on disk
 * (which is one of the situations this guard exists to refuse). A finding with
 * no item record is NOT counted: the state is corrupt in that case, and the
 * ingest's own parse refuses it with a better message than this guard could.
 */
export function unresolvedFrontierWorkItemIds(
  state: CurrentRemediationHostState,
  record: { readonly work_item_ids: readonly string[] },
): readonly string[] {
  const items = state.items as Record<
    string,
    { readonly block_id?: string; readonly status?: string } | undefined
  >;
  const pendingBlockIds = new Set(
    Object.values(items)
      .filter((item) => item?.status === "pending")
      .map((item) => item!.block_id),
  );
  return [...record.work_item_ids]
    .filter((id) => pendingBlockIds.has(id))
    .sort(compareCodeUnits);
}
