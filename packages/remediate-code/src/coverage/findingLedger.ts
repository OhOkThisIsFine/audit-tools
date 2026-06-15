/**
 * Per-finding / per-node coverage ledger (N-coverage-ledger).
 *
 * Source_type-aware denominator (INV-CL-05):
 *   - structured_audit → finding-enumeration denominator (every finding id
 *     from finding-enumeration.json must reach a terminal disposition)
 *   - document / non-enumerable → DAG-node denominator (every promoted
 *     implementation-DAG node must reach a terminal disposition)
 *
 * A 0/0 ledger is INCOMPLETE (fail-closed) — zero denominator never counts as
 * vacuously complete (INV-CL-05).
 *
 * Terminal dispositions: resolved, resolved_no_change, ignored,
 *   deemed_inappropriate, force_closed_unresolved.
 *
 * Non-terminal item statuses (blocked, pending, tested, refactored, verified,
 *   tested_successfully) map to force_closed_unresolved so that the ledger is
 *   always fully populated after build.
 */

import type {
  PerFindingCoverageLedger,
  PerFindingDenominatorKind,
  PerFindingDisposition,
  PerFindingLedgerEntry,
  RemediationItemState,
} from "../state/types.js";

// ── Terminal status map ───────────────────────────────────────────────────────

/**
 * Exhaustive mapping from every known RemediationItemState.status value to
 * a PerFindingDisposition.  Non-terminal statuses map to
 * `force_closed_unresolved` so a finding/node that never reached a terminal
 * status is surfaced in the ledger rather than silently dropped.
 */
const STATUS_TO_DISPOSITION: Record<string, PerFindingDisposition> = {
  resolved: "resolved",
  resolved_no_change: "resolved_no_change",
  ignored: "ignored",
  deemed_inappropriate: "deemed_inappropriate",
  // Non-terminal statuses — all map to force_closed_unresolved
  blocked: "force_closed_unresolved",
  pending: "force_closed_unresolved",
  tested: "force_closed_unresolved",
  tested_successfully: "force_closed_unresolved",
  refactored: "force_closed_unresolved",
  verified: "force_closed_unresolved",
};

/** Whether a PerFindingDisposition is terminal (contributes to coverage). */
const TERMINAL_DISPOSITIONS = new Set<PerFindingDisposition>([
  "resolved",
  "resolved_no_change",
  "ignored",
  "deemed_inappropriate",
  "force_closed_unresolved",
]);

function dispositionIsTerminal(d: PerFindingDisposition): boolean {
  return TERMINAL_DISPOSITIONS.has(d);
}

function statusToDisposition(status: string): PerFindingDisposition {
  return STATUS_TO_DISPOSITION[status] ?? "force_closed_unresolved";
}

// ── Build ─────────────────────────────────────────────────────────────────────

/**
 * Parameters for building the per-finding ledger.
 *
 * For `structured_audit` sources pass `enumeratedIds` — the complete list of
 * finding ids from `finding-enumeration.json`.  For document / non-enumerable
 * sources pass `promotedNodeIds` — the ids of all promoted implementation-DAG
 * nodes.
 *
 * `items` is the `RemediationState.items` record: finding_id → state.
 */
export interface BuildPerFindingLedgerParams {
  /** "finding_enumeration" for structured_audit; "dag_node" for document sources. */
  denominatorKind: PerFindingDenominatorKind;
  /**
   * The authoritative denominator set.
   *
   * - structured_audit: every id from finding-enumeration.json (all findings).
   * - document: every promoted implementation-DAG node id.
   */
  denominatorIds: readonly string[];
  /** The current `RemediationState.items` (may be undefined when state is pre-plan). */
  items: Record<string, RemediationItemState> | undefined;
}

/**
 * Build a `PerFindingCoverageLedger` from the authoritative denominator set
 * and the current item state.
 *
 * Every id in `denominatorIds` produces exactly one entry.  Ids present in
 * `items` are mapped via `statusToDisposition`; ids absent from `items`
 * (never reached the implement phase) produce `force_closed_unresolved`.
 */
export function buildPerFindingLedger(
  params: BuildPerFindingLedgerParams,
): PerFindingCoverageLedger {
  const { denominatorKind, denominatorIds, items } = params;

  const entries: PerFindingLedgerEntry[] = denominatorIds.map((id) => {
    const stateItem = items?.[id];
    const disposition: PerFindingDisposition = stateItem
      ? statusToDisposition(stateItem.status)
      : "force_closed_unresolved";
    return { id, disposition };
  });

  const covered = entries.filter((e) => dispositionIsTerminal(e.disposition)).length;

  return {
    denominator_kind: denominatorKind,
    denominator: denominatorIds.length,
    covered,
    entries,
  };
}

// ── Assert ────────────────────────────────────────────────────────────────────

/** Result returned by `assertLedgerComplete`. */
export interface LedgerCompletenessResult {
  /** True only when every denominator id has a terminal disposition AND denominator > 0. */
  complete: boolean;
  /**
   * Ids that appear in the denominator but have no terminal disposition
   * (i.e. missing from entries or mapped to a non-terminal disposition).
   *
   * In the current implementation all non-terminal statuses map to
   * `force_closed_unresolved` (which IS terminal), so `missing` contains ids
   * that are absent from `entries` altogether — which cannot happen after
   * `buildPerFindingLedger` runs.  This field is retained for callers that
   * construct ledgers manually or via partial merges.
   */
  missing: string[];
  /**
   * Ids that appear more than once in `entries`.  Duplicate entries indicate
   * a merge/build defect (two workers claimed the same finding).
   */
  duplicated: string[];
  /** How the denominator was derived (pass-through from the ledger). */
  denominator_kind: PerFindingDenominatorKind;
}

/**
 * Assert that a `PerFindingCoverageLedger` is complete.
 *
 * Completeness rules (INV-CL-05):
 * 1. `denominator` must be > 0. A 0/0 ledger is INCOMPLETE (fail-closed).
 * 2. Every entry must have a terminal disposition.
 * 3. No id may appear more than once in `entries` (no duplicates).
 * 4. The number of terminal entries must equal `denominator`.
 *
 * Returns `{complete: true, missing: [], duplicated: [], denominator_kind}`
 * when all rules are satisfied; otherwise `{complete: false, missing, duplicated, ...}`.
 */
export function assertLedgerComplete(
  ledger: PerFindingCoverageLedger,
): LedgerCompletenessResult {
  const { denominator, entries, denominator_kind } = ledger;

  // Rule 1: fail-closed on zero denominator.
  if (denominator === 0) {
    return { complete: false, missing: [], duplicated: [], denominator_kind };
  }

  // Detect duplicates
  const seen = new Map<string, number>();
  for (const entry of entries) {
    seen.set(entry.id, (seen.get(entry.id) ?? 0) + 1);
  }
  const duplicated = [...seen.entries()]
    .filter(([, count]) => count > 1)
    .map(([id]) => id);

  // Ids with non-terminal disposition
  const nonTerminal = entries
    .filter((e) => !dispositionIsTerminal(e.disposition))
    .map((e) => e.id);

  // Ids missing from entries entirely (if someone built a partial ledger)
  // We detect this by checking covered vs denominator via the entries array.
  const terminalCount = entries.filter((e) =>
    dispositionIsTerminal(e.disposition),
  ).length;

  const missing = nonTerminal; // non-terminal entries = still missing a real closure

  const complete =
    duplicated.length === 0 &&
    missing.length === 0 &&
    terminalCount === denominator;

  return { complete, missing, duplicated, denominator_kind };
}
