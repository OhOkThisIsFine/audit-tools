import type { AccessMemory, AccessTouchEvent } from "audit-tools/shared";
import { deriveAccessMemoryFromEvents } from "audit-tools/shared";
import type { RemediationState } from "./store.js";

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
