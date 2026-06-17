/**
 * The single authority for the `RemediationItem` status lifecycle.
 *
 * `RemediationItemState.status` is the canonical state of a remediation item;
 * every classification of it (terminal? skip? in-progress?) and every mapping
 * derived from it (coverage disposition, outcomes-contract status) is defined
 * HERE and imported elsewhere. Nothing outside this module may re-enumerate the
 * status values: the exhaustive `Record<RemediationItemStatus, …>` maps below
 * make adding a status a compile error at each unhandled mapping rather than a
 * silent drift across the close / coverage / dispatch code paths.
 */

import type { RemediationOutcomeStatus } from "@audit-tools/shared";
import type { PerFindingDisposition } from "./types.js";

// ── Canonical status enum ───────────────────────────────────────────────────

/**
 * Every status a remediation item can hold, in lifecycle order: the in-progress
 * states (`pending`…`verified`), the success states (`resolved`,
 * `resolved_no_change`), the failure state (`blocked`), and the settled-no-act
 * states (`deemed_inappropriate`, `ignored`).
 */
export const ITEM_STATUSES = [
  "pending",
  "tested",
  "tested_successfully",
  "refactored",
  "verified",
  "resolved",
  "resolved_no_change",
  "blocked",
  "deemed_inappropriate",
  "ignored",
] as const;

export type RemediationItemStatus = (typeof ITEM_STATUSES)[number];

// ── In-progress partition ───────────────────────────────────────────────────

/**
 * Statuses an item holds while still being worked. An item left in one of these
 * at close was force-closed mid-flight (no terminal disposition was reached), so
 * the close phase records it as a failed outcome and preserves the original
 * state — it is NOT a legitimate run-ending status.
 */
const IN_PROGRESS_STATUSES = new Set<RemediationItemStatus>([
  "pending",
  "tested",
  "tested_successfully",
  "refactored",
  "verified",
]);

/** Whether the item is still mid-flight (see {@link IN_PROGRESS_STATUSES}). */
export function isInProgressStatus(status: string): boolean {
  return IN_PROGRESS_STATUSES.has(status as RemediationItemStatus);
}

// ── Status → coverage disposition (PerFindingDisposition) ────────────────────

/**
 * The one status→disposition map (INV-CL-05). Exhaustive over the status enum.
 * Non-terminal statuses map to `force_closed_unresolved` so a force-closed item
 * is surfaced in the coverage ledger rather than silently dropped.
 */
const STATUS_TO_DISPOSITION: Record<RemediationItemStatus, PerFindingDisposition> = {
  resolved: "resolved",
  resolved_no_change: "resolved_no_change",
  ignored: "ignored",
  deemed_inappropriate: "deemed_inappropriate",
  // Non-terminal (blocked + in-progress) → surfaced, not dropped.
  blocked: "force_closed_unresolved",
  pending: "force_closed_unresolved",
  tested: "force_closed_unresolved",
  tested_successfully: "force_closed_unresolved",
  refactored: "force_closed_unresolved",
  verified: "force_closed_unresolved",
};

/** Map an item status to its per-finding coverage disposition. */
export function statusToDisposition(status: string): PerFindingDisposition {
  return (
    STATUS_TO_DISPOSITION[status as RemediationItemStatus] ?? "force_closed_unresolved"
  );
}

// ── Coverage disposition → outcomes-contract status ──────────────────────────

/**
 * The one disposition→outcome map. `RemediationOutcomeStatus` (the shared
 * outcomes wire contract) is a strict function of the coverage disposition, so
 * the close phase derives the outcome from {@link statusToDisposition} rather
 * than keeping its own parallel status→outcome table.
 */
const DISPOSITION_TO_OUTCOME_STATUS: Record<PerFindingDisposition, RemediationOutcomeStatus> = {
  resolved: "resolved",
  resolved_no_change: "verified_no_change",
  ignored: "ignored",
  deemed_inappropriate: "inappropriate",
  force_closed_unresolved: "blocked",
};

/** Map a coverage disposition to its outcomes-contract status. */
export function dispositionToOutcomeStatus(
  disposition: PerFindingDisposition,
): RemediationOutcomeStatus {
  return DISPOSITION_TO_OUTCOME_STATUS[disposition];
}
