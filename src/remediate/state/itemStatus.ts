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

import type { RemediationOutcomeStatus } from "audit-tools/shared";
import type { PerFindingDisposition } from "./types.js";

// ── Canonical status enum ───────────────────────────────────────────────────

/**
 * Every status a remediation item can hold, in lifecycle order: the in-progress
 * states (`pending`…`verified`), the success states (`resolved`,
 * `resolved_no_change`), the failure state (`blocked`), the awaiting-answer state
 * (`needs_clarification` — a worker hit scoping/judgment ambiguity mid-run and
 * paused the item for a clarification round rather than blocking it), the
 * settled-no-act states (`deemed_inappropriate`, `ignored`), and the
 * tool-gave-up state (`abandoned`).
 *
 * `abandoned` exists so that EVERY item ends terminal. A run that exhausts its
 * retry bound, fails its final gate, or is halted by the operator still has to
 * end, and a no-human host must never livelock waiting for a triage that will
 * not come. Before it existed, such items were left in a non-terminal status and
 * the close phase rendered them as a partial-completion outcome — which silently
 * broke the invariant that remediation ends binary. It is deliberately DISTINCT
 * from `ignored`: `ignored` is a settled human decision not to act, `abandoned`
 * is the tool giving up. Collapsing them would erase which one happened. WHY the
 * run ended non-clean is recorded once, at run level, in `closing_context` —
 * not smeared across every item.
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
  "needs_clarification",
  "deemed_inappropriate",
  "ignored",
  "abandoned",
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
 * success states, the two settled-no-act (SKIP) states, and `abandoned` (the
 * tool gave up — retry bound exhausted, final gate red, or operator halt).
 * `blocked` is deliberately NOT terminal — triage retries it — so a blocked item
 * leaves the run non-terminal and routes to triage rather than closing. The
 * force-close backstop converts blocked→abandoned precisely so the run can end
 * without either livelocking or leaving a non-terminal item to be rendered as a
 * partial completion.
 */
const TERMINAL_STATUSES = new Set<RemediationItemStatus>([
  "resolved",
  "resolved_no_change",
  "ignored",
  "deemed_inappropriate",
  "abandoned",
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

/**
 * Whether an item ended WITHOUT succeeding and without a settled decision not to
 * act — `blocked` (triage exhausted, still non-terminal) or `abandoned` (the
 * force-close backstop gave up). Either means the run did not fully succeed, so
 * it must never be "landed green" with its artifacts deleted as if complete.
 *
 * Single-sourced because the green-close guard previously tested the `blocked`
 * literal directly: when the force-close seam moved to `abandoned`, a literal
 * test would have silently stopped matching and let a force-closed run land green.
 */
export function isUnsuccessfulEndStatus(status: string): boolean {
  return status === "blocked" || status === "abandoned";
}

// ── Status → coverage disposition (PerFindingDisposition) ────────────────────

/**
 * The one status→disposition map. Exhaustive over the status enum.
 *
 * Every status maps to a REAL disposition. There is deliberately no
 * "force-closed" disposition: an item that the tool gave up on reaches the
 * terminal `abandoned` status at the force-close seam, so by the time a
 * disposition is derived the item has genuinely ended. A non-terminal status
 * arriving here means close ran while an item was still mid-flight — a bug in
 * the caller, not a disposition to be named — so it maps to `abandoned` and the
 * run is reported non-clean rather than silently rendered as partial progress.
 */
const STATUS_TO_DISPOSITION: Record<RemediationItemStatus, PerFindingDisposition> = {
  resolved: "resolved",
  resolved_no_change: "resolved_no_change",
  ignored: "ignored",
  deemed_inappropriate: "deemed_inappropriate",
  abandoned: "abandoned",
  // Non-terminal statuses should have been converted at the force-close seam.
  blocked: "abandoned",
  needs_clarification: "abandoned",
  pending: "abandoned",
  tested: "abandoned",
  tested_successfully: "abandoned",
  refactored: "abandoned",
  verified: "abandoned",
};

/** Map an item status to its per-finding coverage disposition. */
export function statusToDisposition(status: string): PerFindingDisposition {
  return STATUS_TO_DISPOSITION[status as RemediationItemStatus] ?? "abandoned";
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
  abandoned: "blocked",
};

/** Map a coverage disposition to its outcomes-contract status. */
export function dispositionToOutcomeStatus(
  disposition: PerFindingDisposition,
): RemediationOutcomeStatus {
  return DISPOSITION_TO_OUTCOME_STATUS[disposition];
}
