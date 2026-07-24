// dispatchAttempted.ts — run-scoped sidecar recording which packets a round
// ACTUALLY handed to a worker, as distinct from which it planned.
//
// `prepareDispatchArtifacts` writes the dispatch result-map for the WHOLE
// packetized plan, but only a subset is dispatched: on the host path admission
// grants an affordable prefix and the dispatch prompt instructs the host to run
// "exactly the entries whose packet_id is in admission.granted_packet_ids — no
// more, no fewer"; on the in-process path the rolling engine drives the plan but
// strands packets it cannot place on any pool. Either way a planned-but-
// unattempted task carries a result-map entry with no result file — on disk,
// indistinguishable from a worker that ran and produced nothing.
//
// Merge needs that distinction to classify honestly (see
// `partitionUnattemptedMissing`), and it cannot be recovered later: claim state
// only says "claimed within the lease" (claims are taken at PLAN time, for the
// whole candidate set), and inferring in-flight work from it defers genuine
// failures. So the dispatching side records it at the one point that knows.
//
// A leaf module by construction — `mergeAndIngestCommand.ts` imports
// `dispatch.ts`, so a helper both need cannot live in either (the same cycle
// constraint that put the backend-identity projections in their own module).
import { join } from "node:path";
import { readJsonFile, writeJsonFile } from "audit-tools/shared";

/** Filename of the run-scoped attempted-packets sidecar. */
export const DISPATCH_ATTEMPTED_FILENAME = "dispatch-attempted.json";

/**
 * Record packets this round attempted, UNIONED with what the run already
 * recorded. Written by whichever side dispatched: `prepareDispatchArtifacts`
 * records the admission grant (host path), and the rolling driver records the
 * packets the engine actually drove (in-process path), so a stranded packet is
 * absent from both.
 *
 * The union is load-bearing, not defensive. A run id outlives a single
 * prepare/dispatch/merge round — `semanticReviewStep` prepares against a
 * PERSISTED `activeReviewRun.run_id`, so a later next-step re-runs
 * `prepareDispatchArtifacts` under the same id with a NEW grant. Last-write-wins
 * would then erase round 1's attempts, and a packet that round 1 dispatched and
 * that failed would read as never-attempted at the next merge — deferred instead
 * of failed, with no retry-dispatch entry and no surfaced failure. "Was this
 * packet ever handed to a worker during this run" is the question merge actually
 * asks, and it is monotonic: an attempt is a fact that a later round cannot undo.
 */
export async function recordAttemptedPackets(
  runDir: string,
  attemptedPacketIds: readonly string[],
): Promise<void> {
  const prior = (await readAttemptedPackets(runDir)) ?? new Set<string>();
  for (const id of attemptedPacketIds) prior.add(id);
  await writeJsonFile(join(runDir, DISPATCH_ATTEMPTED_FILENAME), {
    contract_version: "audit-code-dispatch-attempted/v1alpha1",
    // Sorted so the artifact's content is stable across rounds regardless of
    // grant ordering (INV stable, content-derived array order).
    attempted_packet_ids: [...prior].sort(),
  });
}

/**
 * Read the attempted-packet set. `null` when the round recorded none (a missing
 * or malformed sidecar) — the caller must then defer nothing and keep the
 * pre-sidecar classification, so an unrecorded round never silently swallows
 * failures.
 */
export async function readAttemptedPackets(runDir: string): Promise<Set<string> | null> {
  try {
    const doc = await readJsonFile<{ attempted_packet_ids?: unknown }>(
      join(runDir, DISPATCH_ATTEMPTED_FILENAME),
    );
    if (!Array.isArray(doc.attempted_packet_ids)) return null;
    return new Set(doc.attempted_packet_ids.filter((id): id is string => typeof id === "string"));
  } catch {
    return null;
  }
}
