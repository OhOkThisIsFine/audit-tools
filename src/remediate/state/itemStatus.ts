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
import type { PerFindingDisposition } from "./disposition.js";

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

// ── Exhaustive per-axis partition Records ───────────────────────────────────
//
// INV-ISC-1: every RemediationItemStatus belongs to exactly one classification
// under an exhaustive Record<RemediationItemStatus, …> for EACH partition axis
// below, so adding a new status to ITEM_STATUSES is a `npm run check` compile
// error at every unhandled axis — a missing key on an object-literal Record is
// a TS2741/TS2739 error — rather than a silently-permissive Set membership
// test that just returns `false` for anything unlisted. Each Record is
// independently exhaustive; a status may (and several do) score `true` on more
// than one axis — `abandoned` is both `unsuccessful_end` and (via the terminal
// axis) closes the run, `blocked`/`needs_clarification` are `unsuccessful_end`
// without being terminal. The FOUR predicates isInProgressStatus /
// isVerifiedCompleteStatus / isSkipStatus / isUnsuccessfulEndStatus are,
// however, mutually exclusive and jointly exhaustive over all twelve statuses
// (each status scores `true` on exactly one of the four) — the coherence a
// caller may rely on when auditing "is this status handled anywhere".

/**
 * Statuses an item holds while still being worked. An item left in one of these
 * at close was force-closed mid-flight (no terminal disposition was reached), so
 * the close phase records it as a failed outcome and preserves the original
 * state — it is NOT a legitimate run-ending status.
 */
const IN_PROGRESS_STATUS: Record<RemediationItemStatus, boolean> = {
  pending: true,
  tested: true,
  tested_successfully: true,
  refactored: true,
  verified: true,
  resolved: false,
  resolved_no_change: false,
  blocked: false,
  needs_clarification: false,
  deemed_inappropriate: false,
  ignored: false,
  abandoned: false,
};

/** Whether the item is still mid-flight (see {@link IN_PROGRESS_STATUS}). */
export function isInProgressStatus(status: string): boolean {
  return IN_PROGRESS_STATUS[status as RemediationItemStatus] ?? false;
}

// ── Terminal / verified-complete / skip partitions ───────────────────────────

/**
 * Statuses that legitimately END a run with no further implement work: the two
 * success states, the two settled-no-act (SKIP) states, and `abandoned` (the
 * tool gave up — retry bound exhausted, final gate red, or operator halt).
 * `blocked` and `needs_clarification` are deliberately NOT terminal — triage
 * retries `blocked`, an answer resolves `needs_clarification` — so either
 * leaves the run non-terminal rather than closing. The force-close backstop
 * converts both to `abandoned` precisely so the run can end without either
 * livelocking or leaving a non-terminal item to be rendered as a partial
 * completion (INV-ISC-CLOSE-PHASE-PRECONDITION).
 */
const TERMINAL_STATUS: Record<RemediationItemStatus, boolean> = {
  resolved: true,
  resolved_no_change: true,
  ignored: true,
  deemed_inappropriate: true,
  abandoned: true,
  blocked: false,
  needs_clarification: false,
  pending: false,
  tested: false,
  tested_successfully: false,
  refactored: false,
  verified: false,
};

/**
 * The subset of terminal statuses where the node produced AND verified its
 * declared output (`resolved` / `resolved_no_change`). A SKIP
 * (`ignored` / `deemed_inappropriate`) and a `blocked` node are explicitly NOT
 * verified-complete — INV-RS-01: a SKIP disposition never satisfies a dependency
 * edge, so a dependent of a skipped/blocked node stays ineligible.
 */
const VERIFIED_COMPLETE_STATUS: Record<RemediationItemStatus, boolean> = {
  resolved: true,
  resolved_no_change: true,
  ignored: false,
  deemed_inappropriate: false,
  abandoned: false,
  blocked: false,
  needs_clarification: false,
  pending: false,
  tested: false,
  tested_successfully: false,
  refactored: false,
  verified: false,
};

/** Settled decisions not to act on a finding (`ignored` / `deemed_inappropriate`). */
const SKIP_STATUS: Record<RemediationItemStatus, boolean> = {
  ignored: true,
  deemed_inappropriate: true,
  resolved: false,
  resolved_no_change: false,
  abandoned: false,
  blocked: false,
  needs_clarification: false,
  pending: false,
  tested: false,
  tested_successfully: false,
  refactored: false,
  verified: false,
};

/**
 * Statuses where the item ended WITHOUT succeeding and without a settled
 * decision not to act: `blocked` (triage exhausted, still non-terminal),
 * `needs_clarification` (an unanswered clarification — an unanswered question
 * is precisely the "run did not fully succeed" case this predicate exists to
 * catch, so it must count toward a close's `anyBlocked` exactly like `blocked`/
 * `abandoned`), or `abandoned` (the force-close backstop gave up). Any of the
 * three means the run did not fully succeed, so it must never be "landed
 * green" with its artifacts deleted as if complete.
 */
const UNSUCCESSFUL_END_STATUS: Record<RemediationItemStatus, boolean> = {
  blocked: true,
  needs_clarification: true,
  abandoned: true,
  resolved: false,
  resolved_no_change: false,
  ignored: false,
  deemed_inappropriate: false,
  pending: false,
  tested: false,
  tested_successfully: false,
  refactored: false,
  verified: false,
};

/** Whether a status is terminal — no further implement work, and a worker result must never resurrect it. `blocked` and `needs_clarification` are NOT terminal. */
export function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUS[status as RemediationItemStatus] ?? false;
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
    (VERIFIED_COMPLETE_STATUS[status as RemediationItemStatus] ?? false)
  );
}

/** Whether a status is a SKIP — a settled decision not to act (terminal but never verified-complete, INV-RS-01). */
export function isSkipStatus(status: string): boolean {
  return SKIP_STATUS[status as RemediationItemStatus] ?? false;
}

/**
 * Whether an item ended WITHOUT succeeding and without a settled decision not to
 * act — `blocked` (triage exhausted, still non-terminal), `needs_clarification`
 * (unanswered), or `abandoned` (the force-close backstop gave up). Any of the
 * three means the run did not fully succeed, so it must never be "landed green"
 * with its artifacts deleted as if complete.
 *
 * Single-sourced because the green-close guard previously tested the `blocked`
 * literal directly: when the force-close seam moved to `abandoned`, a literal
 * test would have silently stopped matching and let a force-closed run land
 * green — and `needs_clarification` was absent from every partition entirely,
 * so a run stuck on an unanswered clarification could compute `anyBlocked` as
 * `false` and land green over an unanswered question (COR-d518cd60).
 */
export function isUnsuccessfulEndStatus(status: string): boolean {
  return UNSUCCESSFUL_END_STATUS[status as RemediationItemStatus] ?? false;
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

/**
 * Resolve a finding's real disposition: the module-recorded `override` when
 * present (CDC-25/26 — a producing module's own-phase record that this
 * finding's true disposition is `verified_already_fixed` or `refuted`, not the
 * generic status-derived one), otherwise the ordinary {@link statusToDisposition}
 * derivation. `RemediationItemState.status` stays a closed 12-member enum with
 * no `verified_already_fixed`/`refuted` values of its own — the two new
 * disposition members are reached ONLY through an explicit override, never
 * inferred from status, so `statusToDisposition`'s existing 12-key table (and
 * every caller that reads it directly) is unaffected by this widening.
 */
export function resolveDisposition(
  status: string,
  override?: PerFindingDisposition,
): PerFindingDisposition {
  return override ?? statusToDisposition(status);
}

/**
 * Whether `disposition` is one of the two CDC-25 members whose distinction
 * from an ordinary `resolved`/`resolved_no_change` close depends on recorded
 * evidence rather than the item-status enum — `verified_already_fixed` and
 * `refuted` REQUIRE a complete verification-evidence triple
 * (INV-ISC-EVIDENCE-EMITTED) before the writer may emit them as a terminal
 * disposition; the original five never carried that requirement and keep not
 * carrying it, so this predicate scopes the new gate to exactly the two
 * dispositions that need it.
 */
export function requiresVerificationEvidence(
  disposition: PerFindingDisposition,
): boolean {
  return disposition === "verified_already_fixed" || disposition === "refuted";
}

// ── Coverage disposition → outcomes-contract status ──────────────────────────

/**
 * The one disposition→outcome map. `RemediationOutcomeStatus` (the shared
 * outcomes wire contract) is a strict function of the coverage disposition, so
 * the close phase derives the outcome from {@link statusToDisposition} rather
 * than keeping its own parallel status→outcome table.
 *
 * `verified_already_fixed` and `refuted` (CDC-25) map to their OWN, identically
 * named `RemediationOutcomeStatus` members — landed in the SAME commit as that
 * widening (`src/shared/types/remediationOutcome.ts`) and the matching
 * `PerFindingDisposition` union widening at its declaration
 * (`src/remediate/state/disposition.ts:16`), because this Record is exhaustive
 * over `PerFindingDisposition`: a partial landing across the three files is a
 * `npm run check` compile error, never a silent gap.
 */
const DISPOSITION_TO_OUTCOME_STATUS: Record<PerFindingDisposition, RemediationOutcomeStatus> = {
  resolved: "resolved",
  resolved_no_change: "verified_no_change",
  ignored: "ignored",
  deemed_inappropriate: "inappropriate",
  abandoned: "blocked",
  verified_already_fixed: "verified_already_fixed",
  refuted: "refuted",
};

/** Map a coverage disposition to its outcomes-contract status. */
export function dispositionToOutcomeStatus(
  disposition: PerFindingDisposition,
): RemediationOutcomeStatus {
  return DISPOSITION_TO_OUTCOME_STATUS[disposition];
}
