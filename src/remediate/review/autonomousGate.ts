// Autonomous (unattended) review-approval gate.
//
// When SessionConfig.autonomous_mode is set, the review-approval gate must
// produce a review_decision.json WITHOUT halting for a human. This module owns
// the deterministic, fail-closed selection rule that decides which findings may
// be auto-approved in that mode.
//
// The rule is ambiguity-only (NO cost / severity / run-budget gate): a finding
// is auto-approved iff
//   (1) its ambiguity tier is "safe" (classifyFindingRiskTier), AND
//   (2) its change-kind is POSITIVELY on the fail-closed ALLOWLIST of
//       enumerated, provably-safe change-kinds (additive / localized /
//       reversible).
//
// Everything else — including a tier-"safe" but in-place semantic edit to an
// auth check / rate cap / default value, and any deletion that rests on the
// unsound edge-topology dead-code signal (INV-DA-5 deletion_candidate) — is
// EXCLUDED and left as an ordinary LIVE finding. There is NO durable rejection:
// leftovers are never written to a declined / ignored disposition. They are
// re-emitted as a standard, re-consumable audit deliverable pair so the next
// nightly run re-evaluates them fresh (a leftover that drifted across the
// "safe" boundary is re-checked, not permanently parked).
//
// Fail-closed everywhere: any classifier ambiguity resolves to NOT auto-approved.

import type { Finding } from "audit-tools/shared";
import type { ItemSpec } from "../state/types.js";
import { classifyFindingRisk, type FindingRiskTier } from "../steps/stepUtils.js";

/**
 * The enumerated change-kinds. Only the kinds in {@link SAFE_CHANGE_KINDS} are
 * auto-approvable. The list is a CLOSED enumeration: anything that does not
 * positively classify into one of the allowlisted kinds is `unknown` and
 * therefore excluded (fail-closed).
 */
export type ChangeKind =
  // ── allowlisted: additive / localized / reversible ──
  | "add_test"
  | "add_doc"
  | "additive_config_key"
  | "narrowly_localized_reversible_edit"
  // ── excluded: never auto-approved ──
  | "inplace_semantic_edit"
  | "deletion"
  | "unknown";

/**
 * Fail-closed ALLOWLIST of provably-safe change-kinds — enumerated as an
 * explicit positive set, not a denylist. A change-kind is auto-approvable ONLY
 * if it is a member of this set; the membership test is `SAFE_CHANGE_KINDS.has(kind)`,
 * so a future change-kind added to the `ChangeKind` union is excluded by default
 * until it is deliberately added here.
 *
 * Why these four:
 *  - `add_test`   — adds a new test; no existing behavior to regress.
 *  - `add_doc`    — adds documentation/comments; no runtime behavior at all.
 *  - `additive_config_key` — introduces a NEW config key with a default; does
 *    not change the value of an existing key.
 *  - `narrowly_localized_reversible_edit` — a small, single-site, additive guard
 *    (e.g. a null/bounds check added before existing logic) that does not rewrite
 *    an existing semantic decision and is trivially revertible.
 */
export const SAFE_CHANGE_KINDS: ReadonlySet<ChangeKind> = new Set<ChangeKind>([
  "add_test",
  "add_doc",
  "additive_config_key",
  "narrowly_localized_reversible_edit",
]);

/** A change-kind classification carrying the matched kind and a deterministic reason. */
export interface ChangeKindClassification {
  change_kind: ChangeKind;
  /** Whether the kind is positively on the fail-closed allowlist. */
  allowlisted: boolean;
  reason: string;
}

// ── Signal patterns (deterministic, over finding/spec text) ────────────────────

/**
 * In-place SEMANTIC edits to a sensitive decision — auth checks, rate/quota
 * caps, default values, timeouts, permission/policy gates. These are tier-"safe"
 * traps: a high-confidence low-severity finding can still ask to FLIP an existing
 * security-relevant value. Always excluded.
 */
const INPLACE_SEMANTIC_RE =
  /\b(auth(?:enticat|oriz)?|permission|access\s*control|rate[\s-]?(?:limit|cap)|quota|throttle|default\s*(?:value|to|s)?|timeout|retry|policy|credential|token\s*(?:check|valid)|password|secret|cors|csrf|privilege)\b/i;

/** Verbs that signal an in-place change to existing behavior rather than an addition. */
const INPLACE_CHANGE_VERB_RE =
  /\b(change[sd]?|modif(?:y|ies|ied)|replace[sd]?|rewrit|update[sd]?\s+the\s+(?:value|default|check|logic)|flip[s]?|invert[s]?|switch[es]?|toggle[s]?|adjust[s]?\s+the)\b/i;

/** Deletion / removal signals — including the unsound dead-code (INV-DA-5) signal. */
const DELETION_RE =
  /\b(delete[sd]?|remov(?:e|es|ed|al)|drop[s]?|dead[\s-]?code|unused|unreachable|deletion[\s_-]?candidate|prune[sd]?|strip[s]?\s+out|eliminat)\b/i;

/** Additive test signals. */
const ADD_TEST_RE =
  /\b(add(?:s|ing)?\s+(?:a\s+)?(?:test|tests|coverage|spec|unit\s+test|regression\s+test)|write\s+(?:a\s+)?test|missing\s+test|test\s+coverage|new\s+test)\b/i;

/** Additive documentation signals. */
const ADD_DOC_RE =
  /\b(add(?:s|ing)?\s+(?:a\s+)?(?:doc|docs|documentation|comment|comments|jsdoc|docstring|readme)|document\s+the|missing\s+(?:doc|documentation|comment))\b/i;

/** Additive (new) config key signals — NOT a change to an existing key's value. */
const ADD_CONFIG_KEY_RE =
  /\b(?:add(?:s|ing)?|introduce[s]?)\s+(?:a\s+)?(?:new\s+)?(?:config(?:uration)?\s+)?(?:key|option|flag|field|setting|env\s*var|parameter)\b/i;

/** Narrowly-localized additive guard signals (a guard/check ADDED before logic). */
const ADD_GUARD_RE =
  /\b(add(?:s|ing)?\s+(?:a\s+)?(?:null|nil|undefined|bounds|range|length|empty|guard|sanity|input|defensive)\s*(?:check|guard|validation)|guard\s+against|add(?:s|ing)?\s+(?:a\s+)?(?:missing\s+)?(?:return|early\s+return))\b/i;

function changeText(finding: Finding, spec?: ItemSpec): string {
  // At the review gate there is no ItemSpec yet, so the finding's own prose is
  // the authority. When a spec exists (later phases / tests), its concrete_change
  // is the most precise signal and is included.
  return [
    finding.title,
    finding.summary,
    finding.category,
    finding.impact ?? "",
    spec?.concrete_change ?? "",
  ]
    .join(" \n ")
    .toLowerCase();
}

/**
 * Classify a finding's change-kind deterministically (fail-closed). The order
 * matters: any deletion or in-place-semantic signal disqualifies the finding
 * BEFORE the additive kinds are considered, so a finding that both "adds a test"
 * and "removes the legacy parser" classifies as `deletion`, never `add_test`.
 */
export function classifyChangeKind(
  finding: Finding,
  spec?: ItemSpec,
): ChangeKindClassification {
  const text = changeText(finding, spec);

  // 1. Disqualifying signals first (deletion, then in-place semantic edit).
  if (DELETION_RE.test(text)) {
    return {
      change_kind: "deletion",
      allowlisted: false,
      reason:
        "change describes a deletion/removal (incl. the unsound INV-DA-5 dead-code signal) — never auto-approved",
    };
  }
  const touchesSensitive = INPLACE_SEMANTIC_RE.test(text);
  const inPlaceVerb = INPLACE_CHANGE_VERB_RE.test(text);
  if (touchesSensitive && inPlaceVerb) {
    return {
      change_kind: "inplace_semantic_edit",
      allowlisted: false,
      reason:
        "in-place semantic edit to a sensitive decision (auth/cap/default/policy) — never auto-approved",
    };
  }

  // 2. Positive allowlist classification (additive / localized / reversible).
  if (ADD_TEST_RE.test(text)) {
    return { change_kind: "add_test", allowlisted: true, reason: "adds a new test (no existing behavior to regress)" };
  }
  if (ADD_DOC_RE.test(text)) {
    return { change_kind: "add_doc", allowlisted: true, reason: "adds documentation/comments (no runtime behavior)" };
  }
  if (ADD_CONFIG_KEY_RE.test(text)) {
    return {
      change_kind: "additive_config_key",
      allowlisted: true,
      reason: "introduces a new config key with a default (no existing key value changed)",
    };
  }
  if (ADD_GUARD_RE.test(text)) {
    return {
      change_kind: "narrowly_localized_reversible_edit",
      allowlisted: true,
      reason: "adds a narrowly-localized, reversible guard/check before existing logic",
    };
  }

  // 3. Fail-closed: anything unrecognized is `unknown` and excluded.
  return {
    change_kind: "unknown",
    allowlisted: false,
    reason: "change-kind did not positively match any allowlisted provably-safe kind — excluded (fail-closed)",
  };
}

/**
 * Whether a single finding is auto-approvable in autonomous mode: tier "safe"
 * AND a positively-allowlisted change-kind. Both are necessary; the
 * change-kind allowlist is the hard, fail-closed non-destructiveness gate.
 */
export interface AutonomousFindingVerdict {
  finding_id: string;
  approved: boolean;
  tier: FindingRiskTier;
  change_kind: ChangeKind;
  reason: string;
}

export function evaluateAutonomousFinding(
  finding: Finding,
  spec?: ItemSpec,
): AutonomousFindingVerdict {
  // classifyFindingRisk needs an ItemSpec; at the gate we have none, so derive a
  // minimal spec whose concrete_change is the finding prose (so the destructive-
  // verb / breaking-lens / low-confidence signals still fire).
  const effectiveSpec: ItemSpec =
    spec ?? {
      finding_id: finding.id,
      concrete_change: [finding.title, finding.summary, finding.impact ?? ""].join(" \n "),
      tests_to_write: [],
      not_applicable_steps: [],
    };
  const tier = classifyFindingRisk(finding, effectiveSpec).tier;
  const kind = classifyChangeKind(finding, spec);
  const tierSafe = tier === "safe";
  const approved = tierSafe && kind.allowlisted && SAFE_CHANGE_KINDS.has(kind.change_kind);
  let reason: string;
  if (approved) {
    reason = `auto-approved: tier=safe + change-kind="${kind.change_kind}" (${kind.reason})`;
  } else if (!tierSafe) {
    reason = `left live: ambiguity tier is "${tier}", not "safe"`;
  } else {
    reason = `left live: ${kind.reason}`;
  }
  return { finding_id: finding.id, approved, tier, change_kind: kind.change_kind, reason };
}

export interface AutonomousReviewDecision {
  /** Findings auto-approved to proceed to implementation. */
  approved_ids: string[];
  /** Findings left LIVE (re-emitted as a deliverable; never durably rejected). */
  leftover_ids: string[];
  /** Full per-finding verdicts, for the durable record + diagnostics. */
  verdicts: AutonomousFindingVerdict[];
}

/**
 * Build the autonomous review decision over the survivor finding set. Pure and
 * deterministic — the same findings always yield the same split. Re-evaluated
 * FRESH each call (no memory of a prior run's verdict), so a leftover that
 * drifted across the "safe" boundary is re-checked on the next nightly run.
 *
 * `specs` is an optional map from finding id to its documented ItemSpec; when a
 * spec is present it sharpens the classification, but the decision works without
 * any specs (the gate fires before the document phase).
 */
export function buildAutonomousReviewDecision(
  survivors: readonly Finding[],
  specs?: ReadonlyMap<string, ItemSpec>,
): AutonomousReviewDecision {
  const verdicts = survivors.map((f) => evaluateAutonomousFinding(f, specs?.get(f.id)));
  return {
    approved_ids: verdicts.filter((v) => v.approved).map((v) => v.finding_id),
    leftover_ids: verdicts.filter((v) => !v.approved).map((v) => v.finding_id),
    verdicts,
  };
}
