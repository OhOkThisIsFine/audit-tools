/**
 * O2 — the append-only, instance-keyed, idempotent audit-results ledger.
 *
 * `audit_results.jsonl` is the cumulative store of every accepted AuditResult.
 * This module is the SOLE place the ledger grows, so its three invariants hold
 * by construction (never by a caller remembering them):
 *
 *  - APPEND-ONLY, INSTANCE-KEYED (INV-1 / CE-001 / fail-2): every appended record
 *    carries a fresh per-record `instance_id` minted from the shared seam
 *    (`newInstanceId`). The ledger keys on this, so identity_key / idempotency_key
 *    are grouping/idempotency keys, NEVER primary keys — distinct records are never
 *    merged or last-writer-wins'd.
 *
 *  - IDEMPOTENT ON idempotency_key (INV-2 / CE-001b / fail-4): a record is appended
 *    only when no existing record shares its `idempotency_key`. A replay of the same
 *    logical result is therefore a no-op. Two genuinely-different same-coordinate
 *    results (base vs. deepening / steward / re-dispatch) carry distinct
 *    discriminators → distinct idempotency_keys → both persist (CE-001).
 *
 *  - RETAIN-UNASSIGNED (INV-3): re-association groups records to tasks by
 *    `identity_key` one-to-many and resolves logical identity by `idempotency_key`.
 *    A result whose owning task is absent from the active manifest is NEVER pruned —
 *    it stays in the ledger, just un-associated.
 *
 * All three keys are imported from the single content-key seam
 * (`src/shared/contentKey.ts`); this module never re-derives a key.
 */
import {
  type ResultEmitSource,
  buildResultContentDiscriminator,
  identityKey,
  idempotencyKey,
  newInstanceId,
} from "audit-tools/shared";
import type { AuditResult } from "../types.js";

/**
 * Deterministic, TOOL-OWNED mapping from a result's coordinate to its emit
 * source. The discriminator recipe lives in the seam; the SOURCE selection lives
 * here because it is audit-domain knowledge: selective-deepening / steward tasks
 * are minted with `deepening:` / `steward:` task-id prefixes (see
 * `selectiveDeepening/shared.ts#taskIdFor`), so a deepening or steward result
 * that shares a base result's {unit_id, lens, pass_id} coordinate legitimately
 * gets a DISTINCT idempotency_key and both persist (CE-001). Anything else is a
 * base result. (Re-dispatch attempts are not yet stamped on results; when O3
 * adds an attempt counter it maps to `source: 'redispatch'` here.)
 */
function emitSourceFor(result: AuditResult): ResultEmitSource {
  const taskId = result.task_id ?? "";
  if (taskId.startsWith("steward:")) return "steward";
  if (taskId.startsWith("deepening:")) return "deepening";
  return "base";
}

/**
 * Stamp a result with its seam-derived ledger keys (instance_id, identity_key,
 * idempotency_key) when they are not already present. Idempotent: a record that
 * already carries an idempotency_key keeps its identity/idempotency keys (so a
 * replay hashes identically), and only re-mints an absent instance_id.
 */
export function stampLedgerKeys(result: AuditResult): AuditResult {
  const identity_key =
    result.identity_key ??
    identityKey({
      unit_id: result.unit_id,
      lens: result.lens,
      pass_id: result.pass_id,
    });
  const idempotency_key =
    result.idempotency_key ??
    idempotencyKey({
      unit_id: result.unit_id,
      lens: result.lens,
      pass_id: result.pass_id,
      result_content_discriminator: buildResultContentDiscriminator({
        source: emitSourceFor(result),
      }),
    });
  return {
    ...result,
    instance_id: result.instance_id ?? newInstanceId(),
    identity_key,
    idempotency_key,
  };
}

/**
 * Append incoming results to the existing ledger, append-only and IDEMPOTENT on
 * idempotency_key. Each appended record gets a fresh instance_id; a replay (an
 * incoming result whose idempotency_key already exists in the ledger OR collides
 * with an earlier record in the same batch) is a no-op. Distinct idempotency_keys
 * always both persist — never merged, never last-writer-wins (fail-2).
 *
 * The existing ledger is returned by reference-extended copy; existing records
 * are left untouched (append-only).
 */
export function appendResultsToLedger(
  existing: AuditResult[] | undefined,
  incoming: AuditResult[],
): AuditResult[] {
  const ledger = [...(existing ?? [])];
  const seen = new Set<string>();
  for (const record of ledger) {
    const key = record.idempotency_key;
    if (typeof key === "string") seen.add(key);
  }
  for (const raw of incoming) {
    const stamped = stampLedgerKeys(raw);
    const key = stamped.idempotency_key!;
    if (seen.has(key)) {
      // Replay of an already-ingested logical result — no-op (INV-2).
      continue;
    }
    seen.add(key);
    ledger.push(stamped);
  }
  return ledger;
}

/**
 * Re-associate ledger records to tasks. Groups one-to-many by `identity_key`
 * (multiple distinct results legitimately share a coordinate — base vs. deepening
 * / steward) and resolves logical identity by `idempotency_key`. Records are
 * stamped on read if a legacy entry predates the keys, so a ledger written before
 * O2 still groups correctly. RETAIN-UNASSIGNED: every record appears in exactly
 * one group keyed by its identity_key — none is dropped because its task is
 * absent (INV-3); the caller decides what to do with a group whose task is gone.
 */
export function groupLedgerByIdentity(
  ledger: AuditResult[],
): Map<string, AuditResult[]> {
  const byIdentity = new Map<string, AuditResult[]>();
  for (const raw of ledger) {
    const record = stampLedgerKeys(raw);
    const group = byIdentity.get(record.identity_key!) ?? [];
    group.push(record);
    byIdentity.set(record.identity_key!, group);
  }
  return byIdentity;
}
