import type { Finding } from "../state/types.js";

export type FindingRiskTier = "safe" | "substantive" | "context_dependent";

/** One-line explanation of why the risk rule matched, shown to the reviewing LLM. */
export interface FindingClassification {
  tier: FindingRiskTier;
  reason: string;
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

/**
 * Classify a finding's risk tier deterministically. The destructive-verb signal
 * reads the FINDING's own prose. It previously read a per-item
 * `ItemSpec.concrete_change`; no production code ever produced an ItemSpec, so
 * the sole live caller always synthesized a stub from exactly these three
 * fields — the derivation is folded in here rather than restated at the call
 * site.
 */
export function classifyFindingRisk(finding: Finding): FindingClassification {
  const lens = finding.lens.toLowerCase();
  const change = [finding.title, finding.summary, finding.impact ?? ""]
    .join(" \n ")
    .toLowerCase();

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
    return { tier: "context_dependent", reason: "the finding describes a removal or disabling change" };
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
