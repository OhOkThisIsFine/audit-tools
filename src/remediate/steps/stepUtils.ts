import type { Finding, ItemSpec, RemediationBlock } from "../state/types.js";
import type { RemediationState } from "../state/store.js";
import {
  isInProgressStatus,
  isVerifiedCompleteStatus,
} from "../state/itemStatus.js";

export type FindingRiskTier = "safe" | "substantive" | "context_dependent";

/** One-line explanation of why the risk rule matched, shown to the reviewing LLM. */
export interface FindingClassification {
  tier: FindingRiskTier;
  reason: string;
}

/**
 * Host-handoff eligibility (INV-RS-01): a block is eligible only when EVERY
 * dependency reached a VERIFIED-COMPLETE disposition — every dependency item is
 * `resolved` / `resolved_no_change`. A SKIP (`ignored` /
 * `deemed_inappropriate`) or `blocked` dependency never satisfies the edge, so
 * its dependent stays outside the emitted host workload and is later marked
 * blocked rather than applied against a missing upstream surface.
 *
 * An unknown dependency id is not waited on forever: a dangling edge cannot
 * strand the whole DAG.
 */
export function dependencyVerifiedComplete(
  block: RemediationBlock,
  state: RemediationState,
): boolean {
  for (const depId of block.dependencies ?? []) {
    const depBlock = state.plan?.blocks.find((b) => b.block_id === depId);
    if (!depBlock) continue; // unknown dependency: don't strand the DAG on it
    for (const findingId of depBlock.items) {
      const status = state.items?.[findingId]?.status;
      if (!isVerifiedCompleteStatus(status)) return false;
    }
  }
  return true;
}

/**
 * Whether every unsatisfied dependency edge of `block` traces to an item that is
 * merely AWAITING A CLARIFICATION ANSWER, rather than to one that genuinely
 * failed. This is the discriminator the dead-end sweep needs.
 *
 * {@link dependencyVerifiedComplete} answers only "may this block be handed off now",
 * and a `needs_clarification` prerequisite fails it exactly the way a skipped or
 * blocked one does. Conflating them is safe only while an unanswered question
 * freezes the entire run. Once the question is DEFERRED to the end of the
 * implement phase (so siblings keep working), the dead-end sweep reaches the
 * dependents of an unanswered question and would mark them `blocked` — silently
 * converting "awaiting an answer" into "upstream failed", a worse bug than the
 * freeze. A node this predicate accepts is left `pending` instead and re-decided
 * after the batched clarification round: an answer that re-opens the upstream
 * makes the node eligible; an answer that disposes the upstream (a SKIP) makes
 * this predicate false, so the ordinary sweep dead-ends the node then, with the
 * accurate reason.
 *
 * Transitive, because the hold propagates down a chain (A→B→C with C awaiting
 * leaves both B and A held), and cycle-guarded, so a cyclic edge is never
 * reported as awaiting and still dead-ends exactly as it does today.
 */
export function dependencyAwaitingClarification(
  block: RemediationBlock,
  state: RemediationState,
  seen: ReadonlySet<string> = new Set(),
): boolean {
  if (seen.has(block.block_id)) return false; // cycle: not awaiting, dead-end it
  const guard = new Set(seen).add(block.block_id);
  let awaiting = false;
  for (const depId of block.dependencies ?? []) {
    const depBlock = state.plan?.blocks.find((b) => b.block_id === depId);
    if (!depBlock) continue; // dangling edge: never waited on (mirrors the predicates above)
    for (const findingId of depBlock.items) {
      const status = state.items?.[findingId]?.status;
      if (isVerifiedCompleteStatus(status)) continue; // this edge is satisfied
      if (status === "needs_clarification") {
        awaiting = true;
        continue;
      }
      // A dependency still mid-flight counts as awaiting only when IT is itself
      // held by a question further upstream. Anything else — blocked, a SKIP, a
      // missing item, an eligible-but-undispatched node — is not an awaited
      // answer, so the node is left to the ordinary dead-end sweep.
      if (
        status !== undefined &&
        isInProgressStatus(status) &&
        dependencyAwaitingClarification(depBlock, state, guard)
      ) {
        awaiting = true;
        continue;
      }
      return false;
    }
  }
  return awaiting;
}

/**
 * Determine whether free-form triage rationale requests another attempt.
 */
export function rationaleAsksForRetry(rationale: string | undefined): boolean {
  if (!rationale) return false;
  return /\b(deferred?|retry|rerun|requeue|later|dedicated pass|follow-?up|after .*lands?|depends on|blocked)\b/i.test(
    rationale,
  );
}

export function classifyFindingRisk(finding: Finding, spec: ItemSpec): FindingClassification {
  const lens = finding.lens.toLowerCase();
  const change = spec.concrete_change.toLowerCase();

  // Context-dependent: low confidence, breaking/compat/removal signals.
  const lensIsBreaking = /\b(compat|api[-_]?break|interface|breaking|deprecat|remov)\b/.test(lens);
  const changeIsDestructive =
    /\b(removes?|deletes?|disables?|no longer|replaces?.*incompatible|breaks?)\b/.test(change);

  if (finding.confidence === "low") {
    return { tier: "context_dependent", reason: "confidence is low" };
  }
  if (lensIsBreaking) {
    return { tier: "context_dependent", reason: `lens "${finding.lens}" signals a breaking/compat concern` };
  }
  if (changeIsDestructive) {
    return { tier: "context_dependent", reason: "concrete_change contains a removal or disabling verb" };
  }

  // Safe: style / formatting / cosmetic / low-severity config with high confidence.
  const lensIsSafe = /\b(style|format|lint|typo|whitespace|cosmetic|config)\b/.test(lens);
  const lowRisk =
    (finding.severity === "low" || finding.severity === "info") &&
    finding.confidence === "high";

  if (lensIsSafe) {
    return { tier: "safe", reason: `lens "${finding.lens}" is a style/format/config lens` };
  }
  if (lowRisk) {
    return { tier: "safe", reason: `severity=${finding.severity} + confidence=high indicates minimal risk` };
  }

  return { tier: "substantive", reason: `lens "${finding.lens}", severity=${finding.severity} — no safe/breaking signal matched` };
}
