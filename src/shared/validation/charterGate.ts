// Hard gates for the conceptual/design-review charter spine (design of record:
// spec/conceptual-design-review-design.md §"The True charter needs hard gates" and
// §"Tag each charter with confidence"). These are the tool-enforced guards against
// the approach's central failure mode: a confident-but-wrong finding sourced from a
// bad charter. They run deterministically over the charter data model — no LLM.

import type { Charter, CharterDelta } from "../types/charter.js";

/**
 * The True-charter gate: a `true` charter is nominatable-never-assertable and
 * falsifiable-or-drop. It survives ONLY if it names BOTH a concrete alternative and
 * a concrete cost the user seems to pay unaware; an un-falsifiable "what you truly
 * want is elegance" nomination is slop and is dropped. Non-`true` charters are never
 * dropped by this gate (their confidence is handled by charterReviewDisposition).
 *
 * Returns the surviving charters plus a record of what was dropped and why, so the
 * caller can surface the drop as a validation issue rather than silently discarding.
 */
export function applyTrueCharterGate(charters: Charter[]): {
  kept: Charter[];
  dropped: Array<{ charter_id: string; reason: string }>;
} {
  const kept: Charter[] = [];
  const dropped: Array<{ charter_id: string; reason: string }> = [];
  for (const charter of charters) {
    if (charter.kind !== "true") {
      kept.push(charter);
      continue;
    }
    const hasAlternative = Boolean(charter.nominated_alternative?.trim());
    const hasCost = Boolean(charter.nominated_cost?.trim());
    if (hasAlternative && hasCost) {
      kept.push(charter);
    } else {
      const missing = [
        hasAlternative ? null : "nominated_alternative",
        hasCost ? null : "nominated_cost",
      ]
        .filter((m): m is string => m !== null)
        .join(" + ");
      dropped.push({
        charter_id: charter.charter_id,
        reason: `true charter is not falsifiable — missing ${missing} (must name a concrete alternative AND a concrete cost)`,
      });
    }
  }
  return { kept, dropped };
}

/**
 * Whether a review that depends on this charter may OPINE or must only FLAG for
 * human intent input. A low-confidence charter (sparse or ambiguous source) is the
 * central failure mode's source, so any dependent review is downgraded to
 * "flag for human, never opine." This is the general guard of which the True-charter
 * gate above is the strictest instance.
 */
export function charterReviewDisposition(
  charter: Charter,
): "opine" | "flag_for_human" {
  return charter.confidence === "low" ? "flag_for_human" : "opine";
}

/**
 * Route a charter delta to the human channel when either charter it references is
 * low-confidence — a delta between two attributable sides is only adjudicable if
 * both sides are trustworthy; if one is shaky, the tool must not opine (route it to
 * the human) regardless of the delta's nominal `kind`. The delta is returned
 * unchanged when both sides are confident (or a side is absent from `charters`).
 *
 * `pair` holds charter KINDS (symmetric), so we match against the charters present
 * of those kinds; a low-confidence charter of a referenced kind trips the downgrade.
 */
export function gateCharterDelta(
  delta: CharterDelta,
  charters: Charter[],
): CharterDelta {
  const referencedKinds = new Set(delta.pair);
  const anyLowConfidence = charters.some(
    (charter) =>
      referencedKinds.has(charter.kind) &&
      charterReviewDisposition(charter) === "flag_for_human",
  );
  if (anyLowConfidence && delta.routed_to !== "human") {
    return { ...delta, routed_to: "human" };
  }
  return delta;
}
