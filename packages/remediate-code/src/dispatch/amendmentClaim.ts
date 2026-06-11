/**
 * Amendment claim routing for the ownership-gated affected_files protocol.
 *
 * When a worker discovers a necessary edit outside its declared contract scope,
 * it submits the candidate paths to `routeAmendmentRequest`. Unowned paths are
 * granted unilaterally; owned or contended paths are routed back through the
 * seam detect+resolve protocol.
 */

import type { OwnershipRegistry } from "./ownershipRegistry.js";

/** Discriminated union for the outcome of a single amendment claim attempt. */
export type AmendmentClaimResult =
  | { outcome: "granted"; path: string }
  | { outcome: "owned"; path: string; owner_node_id: string }
  | { outcome: "contended"; path: string; sibling_node_id: string };

/**
 * Route a worker's requested amendment paths into granted vs seam-routed.
 *
 * - Granted paths: unowned and uncontended — added to the node's scope for
 *   targeted verification before committing to main.
 * - Seam-routed paths: owned by another node's contract scope or contended by
 *   a live parallel sibling — must be resolved via the seam detect+resolve
 *   protocol (re-scope contracts or serialize the nodes) before merging.
 *
 * Each path appears in exactly one of the two output lists.
 */
export function routeAmendmentRequest(
  registry: OwnershipRegistry,
  nodeId: string,
  candidatePaths: string[],
): {
  granted: string[];
  seam_routed: Array<{ path: string; reason: AmendmentClaimResult }>;
} {
  const granted: string[] = [];
  const seam_routed: Array<{ path: string; reason: AmendmentClaimResult }> = [];

  for (const path of candidatePaths) {
    const outcome = registry.claimAmendment(nodeId, path);

    if (outcome === "granted") {
      granted.push(path);
      continue;
    }

    if (outcome === "owned") {
      const owner_node_id = registry.contractOwner(path) ?? "unknown";
      seam_routed.push({
        path,
        reason: { outcome: "owned", path, owner_node_id },
      });
      continue;
    }

    // contended
    const sibling_node_id = registry.amendmentClaimant(path) ?? "unknown";
    seam_routed.push({
      path,
      reason: { outcome: "contended", path, sibling_node_id },
    });
  }

  return { granted, seam_routed };
}
