import type { Lens } from "../types.js";
import { LENS_REGISTRY, isLens } from "../types.js";
import type { CriticalFlowManifest } from "audit-tools/shared";

/**
 * The FLOW-LENS POLICY — one source, three call sites.
 *
 * A flow's declared `concerns` are free strings; the policy says which of them
 * are lenses a flow may be PLANNED against (here), marked REQUIRED for coverage
 * against (`buildFlowCoverage`), and REQUEUED against (`buildFlowRequeueTasks`).
 * All three must answer identically or a flow can be required under a lens
 * planning refuses to schedule.
 *
 * They did not, and the divergence was the defect: this module hand-copied a
 * seven-entry lens array (security, reliability, correctness, data_integrity,
 * operability, performance, observability) while coverage and requeue both
 * admitted every canonical lens through `isLens`. A flow whose only concern was
 * maintainability, architecture, tests, or config_deployment therefore got zero
 * planning blocks while coverage still marked that lens required — the flow
 * could never reach status `complete` via the planning path and was only
 * rescued by the requeue fallback, which over-produces one task per
 * (flow, lens, path) instead of the single claimed block planning would emit.
 *
 * The policy is now drawn, by all three, from the ONE lens registry in
 * `src/audit/types.ts`: membership is `isLens` (derived from `ALL_LENSES`) and
 * ordering is `order_weight` (`LENS_REGISTRY`). Adding a lens to that registry
 * reaches flow planning with no edit here.
 */
const FLOW_LENS_ORDER: ReadonlyMap<string, number> = new Map(
  LENS_REGISTRY.map((definition) => [definition.id, definition.order_weight]),
);

/**
 * Select the reviewable lenses from a flow's declared concerns — the single
 * membership draw shared by planning, coverage, and requeue. A concern that is
 * not a canonical lens is SKIPPED rather than thrown on, consistent with the
 * filter-based guards elsewhere in the orchestrator: one stray non-canonical
 * concern must not abort a whole flow's planning or requeue.
 */
export function selectFlowLenses(concerns: readonly unknown[]): Lens[] {
  return concerns.filter((concern): concern is Lens => isLens(concern));
}

/**
 * Task-ordering priority for a claimed flow block — lower sorts earlier.
 * Derived from {@link LENS_REGISTRY}'s `order_weight` so no second hand-copied
 * lens list backs the ordering. A non-canonical lens (which the membership draw
 * above already excludes) sorts last.
 */
export function flowLensPriority(lens: string): number {
  return FLOW_LENS_ORDER.get(lens) ?? Number.MAX_SAFE_INTEGER;
}

export interface FlowReviewBlock {
  flow_id: string;
  lens: string;
  file_paths: string[];
}

/**
 * `artifact:flow-claim-contract` — what a claim RETURNS beyond the blocks.
 *
 * `claimFlowReviewBlocks` reports the post-claim state alongside the claimed
 * blocks: `assigned` is the caller's assigned set plus every newly claimed
 * `lens:path` key, and `pending` is the caller's pending map with every claimed
 * path removed. Both are computed from the arguments and are independent of the
 * in-place mutation the call still performs (see the DEFERRED note on
 * {@link claimFlowReviewBlocks}), so retiring that mutation does not change a
 * single returned value.
 *
 * The contract rides ON the returned array as non-enumerable properties, so
 * every consumer that iterates the result as `FlowReviewBlock[]` is unchanged.
 */
export interface FlowClaimContract {
  readonly blocks: readonly FlowReviewBlock[];
  readonly pending: ReadonlyMap<string, ReadonlySet<string>>;
  readonly assigned: ReadonlySet<string>;
}

export type FlowClaimResult = FlowReviewBlock[] & FlowClaimContract;

function lensPathKey(lens: string, path: string): string {
  return `${lens}:${path}`;
}

function attachClaimContract(
  blocks: FlowReviewBlock[],
  pending: ReadonlyMap<string, ReadonlySet<string>>,
  assigned: ReadonlySet<string>,
): FlowClaimResult {
  return Object.defineProperties(blocks, {
    blocks: { value: blocks, enumerable: false },
    pending: { value: pending, enumerable: false },
    assigned: { value: assigned, enumerable: false },
  }) as FlowClaimResult;
}

/**
 * Claim the highest-priority critical-flow review blocks out of the pending
 * work set.
 *
 * PRECONDITION (seam audit-coverage-path-keyspace → here, caller to callee):
 * every path in `criticalFlows`, in `pendingByLens`, and in the `lens:path`
 * keys of `assigned` is already normalized into ONE key space by the caller.
 * This module does no normalizing of its own — an unnormalized path simply
 * fails to intersect and the flow is silently under-claimed.
 *
 * DEFERRED (CP-NODE-9): the call still ALSO mutates the caller-supplied
 * `assigned` set in place. `taskBuilder`'s planning pass reads that set after
 * the call to build its remainder blocks; cutting the mutation over to the
 * returned {@link FlowClaimContract} lands with that caller's adoption.
 */
export function claimFlowReviewBlocks(
  criticalFlows: CriticalFlowManifest,
  pendingByLens: Map<string, Set<string>>,
  assigned: Set<string>,
): FlowClaimResult {
  const candidates: FlowReviewBlock[] = [];

  for (const flow of criticalFlows.flows) {
    const flowPaths = [...new Set(flow.paths)].sort((a, b) =>
      a.localeCompare(b),
    );
    const desiredLenses = selectFlowLenses(flow.concerns).sort(
      (a, b) => flowLensPriority(a) - flowLensPriority(b),
    );

    for (const lens of desiredLenses) {
      const pendingPaths = pendingByLens.get(lens);
      if (!pendingPaths || pendingPaths.size === 0) {
        continue;
      }

      const filePaths = flowPaths.filter((path) => pendingPaths.has(path));
      if (filePaths.length === 0) {
        continue;
      }

      candidates.push({
        flow_id: flow.id,
        lens,
        file_paths: filePaths,
      });
    }
  }

  candidates.sort((a, b) => {
    const sizeDelta = b.file_paths.length - a.file_paths.length;
    if (sizeDelta !== 0) return sizeDelta;
    const lensDelta = flowLensPriority(a.lens) - flowLensPriority(b.lens);
    if (lensDelta !== 0) return lensDelta;
    return a.flow_id.localeCompare(b.flow_id);
  });

  // Post-claim state, derived from the arguments rather than from the mutation.
  const claimedKeys = new Set<string>(assigned);
  const remainingPending = new Map<string, Set<string>>(
    [...pendingByLens].map(([lens, paths]) => [lens, new Set(paths)]),
  );

  const blocks: FlowReviewBlock[] = [];
  for (const candidate of candidates) {
    const unclaimedPaths = candidate.file_paths.filter(
      (path) => !claimedKeys.has(lensPathKey(candidate.lens, path)),
    );
    if (unclaimedPaths.length === 0) {
      continue;
    }

    for (const path of unclaimedPaths) {
      const key = lensPathKey(candidate.lens, path);
      claimedKeys.add(key);
      remainingPending.get(candidate.lens)?.delete(path);
      // DEFERRED (CP-NODE-9): retire with the caller's adoption of the contract.
      assigned.add(key);
    }

    blocks.push({
      ...candidate,
      file_paths: unclaimedPaths,
    });
  }

  return attachClaimContract(blocks, remainingPending, claimedKeys);
}
