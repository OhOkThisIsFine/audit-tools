/**
 * Amendment claim routing for the ownership-gated affected_files protocol.
 *
 * When a worker discovers a necessary edit outside its declared contract scope,
 * it submits the candidate paths to `routeAmendmentRequest`. Unowned paths are
 * granted unilaterally; owned or contended paths are routed back through the
 * seam detect+resolve protocol.
 *
 * Grant-time disjointness (INV-SOO-06 / CE-001): `registry.claimAmendment`
 * additionally refuses a scope-widening grant onto a file another node holds as a
 * live in-flight scheduling claim, so the in-flight owned-file union can never
 * become non-disjoint via a post-admission amendment. Such a path is routed as a
 * `contended` seam (queued until the holder's file frees), exactly like a
 * sibling-amendment contention.
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
      const entry: AmendmentClaimResult = { outcome: "owned", path, owner_node_id };
      seam_routed.push({ path, reason: entry });
      process.stderr.write(
        JSON.stringify({
          level: "warn",
          event: "amendment_seam_routed",
          node_id: nodeId,
          path,
          outcome: "owned",
          owner_node_id,
          ts: new Date().toISOString(),
        }) + "\n",
      );
      continue;
    }

    // contended
    const sibling_node_id = registry.amendmentClaimant(path) ?? "unknown";
    const entry: AmendmentClaimResult = { outcome: "contended", path, sibling_node_id };
    seam_routed.push({ path, reason: entry });
    process.stderr.write(
      JSON.stringify({
        level: "warn",
        event: "amendment_seam_routed",
        node_id: nodeId,
        path,
        outcome: "contended",
        sibling_node_id,
        ts: new Date().toISOString(),
      }) + "\n",
    );
  }

  return { granted, seam_routed };
}
