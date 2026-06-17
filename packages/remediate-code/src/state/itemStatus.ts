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

// ── Terminal / verified-complete / skip partitions ───────────────────────────

/**
 * Statuses that legitimately END a run with no further implement work: the two
 * success states plus the two settled-no-act (SKIP) states. `blocked` is
 * deliberately NOT terminal — triage retries it — so a blocked item leaves the
 * run non-terminal and routes to triage rather than closing.
 */
const TERMINAL_STATUSES = new Set<RemediationItemStatus>([
  "resolved",
  "resolved_no_change",
  "ignored",
  "deemed_inappropriate",
]);

/**
 * The subset of terminal statuses where the node produced AND verified its
 * declared output (`resolved` / `resolved_no_change`). A SKIP
 * (`ignored` / `deemed_inappropriate`) and a `blocked` node are explicitly NOT
 * verified-complete — INV-RS-01: a SKIP disposition never satisfies a dependency
 * edge, so a dependent of a skipped/blocked node stays ineligible.
 */
const VERIFIED_COMPLETE_STATUSES = new Set<RemediationItemStatus>([
  "resolved",
  "resolved_no_change",
]);

/** Settled decisions not to act on a finding (`ignored` / `deemed_inappropriate`). */
const SKIP_STATUSES = new Set<RemediationItemStatus>([
  "ignored",
  "deemed_inappropriate",
]);

/** Whether a status is terminal — no further implement work, and a worker result must never resurrect it. `blocked` is NOT terminal. */
export function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status as RemediationItemStatus);
}

/**
 * Whether a status is VERIFIED-COMPLETE: the node produced and verified its
 * declared output (`resolved` / `resolved_no_change`). A skipped node
 * (`ignored` / `deemed_inappropriate`) and a `blocked` node are explicitly NOT
 * verified-complete — INV-RS-01: a SKIP disposition never satisfies a dependency
 * edge, so a dependent of a skipped/blocked node stays ineligible.
 */
export function isVerifiedCompleteStatus(status: string | undefined): boolean {
  return (
    status !== undefined &&
    VERIFIED_COMPLETE_STATUSES.has(status as RemediationItemStatus)
  );
}

/** Whether a status is a SKIP — a settled decision not to act (terminal but never verified-complete, INV-RS-01). */
export function isSkipStatus(status: string): boolean {
  return SKIP_STATUSES.has(status as RemediationItemStatus);
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
