// sites-pinned: tests/shared/charter-gate.test.ts
// Hard gates for the conceptual/design-review charter spine (design of record:
// spec/conceptual-design-review-design.md §"The True charter needs hard gates" and
// §"Blast radius — the ranking and the risk gate"). Tool-enforced guards against
// the approach's central failure mode: a confident-but-wrong finding sourced from a
// bad charter. They run deterministically over the charter data model — no LLM.

import type {
  Charter,
  CharterDifferenceQuestion,
  LaneGoalNode,
} from "../types/charter.js";

/**
 * The True-charter gate: a `true` charter is nominatable-never-assertable and
 * falsifiable-or-drop. It survives ONLY if it names BOTH a concrete alternative and
 * a concrete cost the user seems to pay unaware; an un-falsifiable "what you truly
 * want is elegance" nomination is slop and is dropped. Non-`true` charters are never
 * dropped by this gate.
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
 * Whether a review that depends on this goal node may OPINE or must only FLAG for
 * human intent input. A low-confidence node (sparse or ambiguous source) is the
 * central failure mode's source, so any dependent review is downgraded to
 * "flag for human, never opine." This is the general guard of which the fidelity
 * lane and the True-charter gate are the strict instances.
 */
export function charterReviewDisposition(
  node: Pick<Charter, "confidence"> | Pick<LaneGoalNode, "confidence">,
): "opine" | "flag_for_human" {
  return node.confidence === "low" ? "flag_for_human" : "opine";
}

/**
 * The blast-radius RISK GATE (Phase D; design §"Blast radius — the ranking and the
 * risk gate"). Blast radius is simultaneously priority (high-blast = high-value)
 * AND risk: acting on a WRONG high-blast finding is catastrophic, so it must clear
 * a MUCH higher bar of independent adversarial refutation before it is actionable.
 * A question whose blast radius is at/above `highBlastThreshold` may only reach the
 * interactive human channel if it has cleared `requiredRefutations` rounds of
 * independent refutation; otherwise it is `finding_only`.
 *
 * Pure + deterministic; `observedRefutations` is supplied by the caller.
 */
export function riskGateClarification(
  request: CharterDifferenceQuestion,
  observedRefutations: number,
  opts: { highBlastThreshold: number; requiredRefutations: number },
): CharterDifferenceQuestion["disposition"] {
  const isHighBlast = request.value.blast_radius >= opts.highBlastThreshold;
  if (!isHighBlast) return "interactive";
  return observedRefutations >= opts.requiredRefutations
    ? "interactive"
    : "finding_only";
}
