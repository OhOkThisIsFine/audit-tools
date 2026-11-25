// sites-pinned: tests/remediate/item-status.test.ts
/**
 * The single authority for the `RemediationItem` status lifecycle.
 *
 * `RemediationItemState.status` is the canonical state of a remediation item;
 * every classification of it (terminal? skip? in-progress?) and every mapping
 * derived from it (coverage disposition, outcomes-contract status) is defined
 * HERE and imported elsewhere. Nothing outside this module may re-enumerate the
 * status values: the exhaustive lifecycle table makes adding an unclassified
 * status a compile error rather than a silent drift across consumers.
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
 * retry bound or is halted by the operator still has to end (a red final gate
 * pauses the run instead and leaves item statuses unchanged), and a no-human
 * host must never livelock waiting for a triage that will not come. Before it existed, such items were left in a non-terminal status and
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

// A phase is assigned once per status (INV-ISC-1). Its projections are NOT
// interchangeable: a skip ends work but never satisfies a dependency, and
// blocked/needs_clarification prevent green close but do not end work. Only
// abandoned is both unsuccessful and terminal.
type ItemPhase = "in_progress" | "verified_complete" | "skip" | "interrupted" | "abandoned";

const ITEM_LIFECYCLE = {
  pending: ["in_progress", "abandoned"],
  tested: ["in_progress", "abandoned"],
  tested_successfully: ["in_progress", "abandoned"],
  refactored: ["in_progress", "abandoned"],
  verified: ["in_progress", "abandoned"],
  resolved: ["verified_complete", "resolved"],
  resolved_no_change: ["verified_complete", "resolved_no_change"],
  blocked: ["interrupted", "abandoned"],
  needs_clarification: ["interrupted", "abandoned"],
  deemed_inappropriate: ["skip", "deemed_inappropriate"],
  ignored: ["skip", "ignored"],
  abandoned: ["abandoned", "abandoned"],
} as const satisfies Record<RemediationItemStatus, readonly [phase: ItemPhase, disposition: PerFindingDisposition]>;

function itemLifecycle(status: string | undefined) {
  if (status === undefined || !Object.hasOwn(ITEM_LIFECYCLE, status)) return undefined;
  return ITEM_LIFECYCLE[status as RemediationItemStatus];
}

/** Whether the item is still mid-flight (never a legitimate run-ending status). */
export function isInProgressStatus(status: string): boolean {
  return itemLifecycle(status)?.[0] === "in_progress";
}

/** Whether no implement work is owed. Blocked and clarification items can resume. */
export function isTerminalStatus(status: string): boolean {
  const phase = itemLifecycle(status)?.[0];
  return phase === "verified_complete" || phase === "skip" || phase === "abandoned";
}

/** Whether the item verified its declared output and can satisfy a dependency (INV-RS-01). */
export function isVerifiedCompleteStatus(status: string | undefined): boolean {
  return itemLifecycle(status)?.[0] === "verified_complete";
}

/** Whether a decision not to act settled the item without verifying it. */
export function isSkipStatus(status: string): boolean {
  return itemLifecycle(status)?.[0] === "skip";
}

/** Whether the item prevents a green close, even if it can still resume. */
export function isUnsuccessfulEndStatus(status: string): boolean {
  const phase = itemLifecycle(status)?.[0];
  return phase === "interrupted" || phase === "abandoned";
}

/** Nonterminal items at close are non-clean, not a partial-progress disposition. */
export function statusToDisposition(status: string): PerFindingDisposition {
  return itemLifecycle(status)?.[1] ?? "abandoned";
}

/**
 * Resolve a finding's real disposition: the module-recorded `override` when
 * present (CDC-25/26 — a producing module's own-phase record that this
 * finding's true disposition is `verified_already_fixed` or `refuted`, not the
 * generic status-derived one), otherwise the ordinary {@link statusToDisposition}
 * derivation. `RemediationItemState.status` stays a closed 12-member enum with
 * no `verified_already_fixed`/`refuted` values of its own — the two new
 * disposition members are reached ONLY through an explicit override, never
 * inferred from status, so `statusToDisposition`'s lifecycle mapping (and
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
 * (`PER_FINDING_DISPOSITIONS` in `src/remediate/state/disposition.ts`), because this Record is exhaustive
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
