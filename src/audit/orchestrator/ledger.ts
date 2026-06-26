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
 * base result. (O3 — a base result whose task content DRIFTED from its baseline
 * is re-keyed `emit_source: 'redispatch'` with an attempt counter by the
 * ingestion path; that persisted `emit_source` is read first here.)
 */
export function emitSourceFor(result: AuditResult): ResultEmitSource {
  if (result.emit_source) return result.emit_source;
  const taskId = result.task_id ?? "";
  if (taskId.startsWith("steward:")) return "steward";
  if (taskId.startsWith("deepening:")) return "deepening";
  return "base";
}

/**
 * The attempt ordinal within a task's base lineage: a base result is attempt 0; a re-dispatch
 * carries its 1-based `attempt`. A redispatch record with no stamped attempt is
 * treated as attempt 1 (fail-forward; the keying authority always stamps one).
 */
function attemptOf(result: AuditResult): number {
  if (emitSourceFor(result) === "redispatch") {
    return typeof result.attempt === "number" && result.attempt >= 1
      ? result.attempt
      : 1;
  }
  return 0;
}

/**
 * The highest re-dispatch attempt already recorded for a task's base lineage,
 * keyed by `task_id` — NOT identity_key, which is deliberately one-to-many (file-
 * split sibling tasks of one unit+lens share {unit_id,lens,pass_id} but have
 * distinct task_ids, so identity-keying would conflate them). A re-dispatch
 * supersedes the SAME task's earlier result. 0 when the task has only its base
 * record (or none) — so the next attempt is always `maxRedispatchAttempt + 1`.
 */
export function maxRedispatchAttempt(
  ledger: readonly AuditResult[],
  task_id: string,
): number {
  let max = 0;
  for (const record of ledger) {
    if (record.task_id !== task_id) continue;
    if (emitSourceFor(record) !== "redispatch") continue;
    const attempt = attemptOf(record);
    if (attempt > max) max = attempt;
  }
  return max;
}

/**
 * Resolve the ledger to its CURRENT records (O3 supersession): within each
 * `task_id` the highest-attempt record wins, so a re-dispatched
 * result's fresh findings supersede the stale base record they replaced and the
 * superseded findings never reach synthesis. Keyed on `task_id` (unique per task),
 * never identity_key (one-to-many over split siblings) so distinct tasks are never
 * collapsed; `deepening:`/`steward:` results have their own task_ids. Stamped on
 * read (a pre-O2 ledger still resolves). The append-only ledger on disk is never
 * mutated — this is a pure read-time projection.
 */
export function selectCurrentResults(
  ledger: readonly AuditResult[],
): AuditResult[] {
  const current = new Map<string, AuditResult>();
  for (const raw of ledger) {
    const record = stampLedgerKeys(raw);
    const key = record.task_id;
    const existing = current.get(key);
    if (!existing || attemptOf(record) > attemptOf(existing)) {
      current.set(key, record);
    }
  }
  return [...current.values()];
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
        // Only consulted for `redispatch`; ignored for base/deepening/steward.
        attempt: result.attempt,
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
