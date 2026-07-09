import { join } from "node:path";
import type { AccessMemory, AccessTouchEvent } from "audit-tools/shared";
import {
  deriveAccessMemoryFromEvents,
  readOptionalJsonFile,
  AccessMemorySchema,
  computeContinuityScores,
  continuityMassForPaths,
} from "audit-tools/shared";
import type { RemediationState } from "./store.js";
import type { RemediationBlock } from "./types.js";

/**
 * Remediate-side parity of the audit access-memory harvest (context-efficiency
 * track, increment 2c): populate `access_memory.edited_count` from the files
 * remediation landed edits on, so continuity works in both orchestrators.
 *
 * Attribution is per-ITEM and restricted to `resolved` items — the only status
 * that lands an actual diff. `resolved_no_change` (verified but zero diff), skips
 * (`ignored`/`deemed_inappropriate`) and `blocked` items edit nothing and are
 * excluded. Each resolved item's edited surface is its `item_spec.touched_files`
 * (the declared surface of that specific item), falling back to its block's
 * `touched_files` only when the item carries no per-item surface. This is the
 * DECLARED edit surface, not a live git diff: it's the only CUMULATIVE,
 * git-independent source (worktree branches for earlier waves are already
 * merged/gone), and the ownership-disjoint scheduler + post-merge attribution hold
 * an item to that surface, so declared ≈ actual by construction. Re-derived fresh
 * from state each merge (no read-modify-write, no double-count, idempotent).
 *
 * Recency lives in STEP-ORDINAL space, never wall-clock: blocks are ordered
 * deterministically by `(phase_ordinal, block_id)` — the foundations→consumers
 * execution order — and an item's ordinal is its block's index in that order.
 * `total_ordinals` is the full block count, so recency (`last_ordinal /
 * total_ordinals`) is stable as more blocks complete. Pure + deterministic: same
 * state → byte-identical record.
 */
export function deriveRemediationAccessMemory(
  state: RemediationState,
): AccessMemory {
  const blocks = [...(state.plan?.blocks ?? [])].sort((a, b) => {
    const phaseDelta = (a.phase_ordinal ?? 0) - (b.phase_ordinal ?? 0);
    if (phaseDelta !== 0) return phaseDelta;
    return a.block_id < b.block_id ? -1 : a.block_id > b.block_id ? 1 : 0;
  });
  const ordinalByBlock = new Map(blocks.map((block, index) => [block.block_id, index]));
  const blockById = new Map(blocks.map((block) => [block.block_id, block]));

  // Sort items by finding_id so the (already path-sorted) core sees a stable
  // stream regardless of state.items key insertion order.
  const items = Object.values(state.items ?? {}).sort((a, b) =>
    a.finding_id < b.finding_id ? -1 : a.finding_id > b.finding_id ? 1 : 0,
  );

  const events: AccessTouchEvent[] = [];
  for (const item of items) {
    if (item.status !== "resolved") continue; // only an actual diff counts as an edit
    const ordinal = ordinalByBlock.get(item.block_id) ?? 0;
    const surface =
      item.item_spec?.touched_files ??
      blockById.get(item.block_id)?.touched_files ??
      [];
    for (const path of new Set(surface)) {
      if (!path) continue;
      events.push({ path, edited: true, ordinal });
    }
  }

  return deriveAccessMemoryFromEvents(events, {
    totalOrdinals: blocks.length,
    runId: state.plan?.plan_id,
  });
}

/** Canonical on-disk name of the per-run access-memory record (both orchestrators). */
const ACCESS_MEMORY_FILENAME = "access_memory.json";

/**
 * Read the remediation `access_memory.json` (written at the artifacts root by the
 * merge — see {@link deriveRemediationAccessMemory}) back for the continuity
 * consumer. Absent (first dispatch pass, before any merge) OR malformed ⇒
 * `undefined` = no bias, matching the scorer's empty-map contract. Never throws —
 * a bad record degrades silently rather than failing dispatch (enforce-in-tooling,
 * crash-safe like the graph/extractor read path).
 */
export async function readRemediationAccessMemory(
  artifactsDir: string,
): Promise<AccessMemory | undefined> {
  let raw: unknown;
  try {
    raw = await readOptionalJsonFile<unknown>(join(artifactsDir, ACCESS_MEMORY_FILENAME));
  } catch {
    return undefined; // unreadable / invalid JSON → no bias
  }
  if (raw === undefined) return undefined;
  const parsed = AccessMemorySchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Remediate-side continuity CONSUMER (context-efficiency track, increment 2d) —
 * the mirror of audit's `orderReviewPackets` bias. Turns the harvested
 * `access_memory` into a per-BLOCK continuity mass that biases file-ownership
 * sub-wave admission (`ownershipSubWaves`, via `OwnershipSchedulerNode.continuity`)
 * toward blocks whose files earlier waves already touched.
 *
 * Remediate has NO dependency graph at dispatch, so the shared scorer runs in its
 * seed-only mode (`graphBundle: undefined`) — a pure recency×frequency ordering
 * (edited-weighted), which is the valid weaker signal for a graphless consumer.
 * Each block's mass is the single-sourced {@link continuityMassForPaths} reducer
 * over its declared file surface, keyed by `block_id`. Returns an empty map when
 * there is no signal yet (no/empty access-memory) ⇒ the scheduler falls back to
 * its pure `block_id` ordering, byte-identical to pre-2d.
 */
export function computeBlockContinuityScores(
  accessMemory: AccessMemory | undefined,
  blocks: readonly RemediationBlock[],
  scopeForBlock: (block: RemediationBlock) => readonly string[],
): Map<string, number> {
  const scores = computeContinuityScores(accessMemory, undefined);
  if (scores.size === 0) return new Map();
  const byBlock = new Map<string, number>();
  for (const block of blocks) {
    const mass = continuityMassForPaths(scopeForBlock(block), scores);
    if (mass > 0) byBlock.set(block.block_id, mass);
  }
  return byBlock;
}
