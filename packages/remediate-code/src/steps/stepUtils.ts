import type { Finding, ItemSpec, RemediationBlock } from "../state/types.js";
import type { RemediationState } from "../state/store.js";

export type FindingRiskTier = "safe" | "substantive" | "context_dependent";

/** One-line explanation of why the risk rule matched, shown to the reviewing LLM. */
export interface FindingClassification {
  tier: FindingRiskTier;
  reason: string;
}

export const NO_CHANGE_RE = /\b(already correct|no.?op|no change|nothing to (change|do|fix)|code is correct)\b/i;

const TERMINAL_STATUSES = ["resolved", "resolved_no_change", "ignored", "deemed_inappropriate"];

/** Whether an item status is terminal — no further implement work, and a worker result must never resurrect it. */
export function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/**
 * A block is ready to implement only once every dependency block is fully
 * resolved (all of its items terminal). Host-dispatched workers edit the main
 * tree, so a dependent dispatched before its prerequisite would build on stale
 * code — dependency-ordered blocks must land in separate waves. A `blocked`
 * dependency item is NOT terminal here, so a failed prerequisite correctly
 * leaves its dependents un-ready (they are marked blocked downstream).
 */
export function dependenciesSatisfied(
  block: RemediationBlock,
  state: RemediationState,
): boolean {
  for (const depId of block.dependencies ?? []) {
    const depBlock = state.plan?.blocks.find((b) => b.block_id === depId);
    if (!depBlock) continue; // unknown dependency: don't wait on it forever
    for (const findingId of depBlock.items) {
      const status = state.items?.[findingId]?.status;
      if (!status || !TERMINAL_STATUSES.includes(status)) return false;
    }
  }
  return true;
}

/**
 * Decide whether an item spec represents a no-op (no source changes planned).
 *
 * The structured `no_change` flag is authoritative when the worker set it
 * explicitly: an explicit `false` must win even when `concrete_change` happens
 * to mention a no-change phrase about a sub-part (e.g. "no change is required in
 * constants.ts" inside a finding that does change other files). The heuristic
 * regex over the free-text spec is only a fallback for when `no_change` is
 * unspecified.
 */
export function specIndicatesNoChange(
  spec: { no_change?: boolean; concrete_change?: string } | undefined,
): boolean {
  if (spec?.no_change === true) return true;
  if (spec?.no_change === false) return false;
  return NO_CHANGE_RE.test(spec?.concrete_change ?? "");
}

/**
 * A line of worker evidence that proves behavior with an EXECUTABLE assertion —
 * a test/build/check command or a test-result count — rather than prose.
 */
export const EXECUTABLE_EVIDENCE_RE =
  /\b(?:npm|npx|pnpm|yarn|vitest|tsc|node)\b[^\n]*\b(?:test|run|check|build|--test|--import)\b|\b\d+\s+(?:pass(?:ed)?|fail(?:ed)?|tests?)\b|\btests?\s+pass(?:ed|ing)?\b|\b\d+\s*\/\s*\d+\s+(?:pass|green)\b/i;

/**
 * Whether worker evidence carries an executable verification signal (see
 * EXECUTABLE_EVIDENCE_RE) rather than prose only. A "verified-already-satisfied"
 * (no-change) closure must prove the behavior with an executable assertion; prose
 * claiming "already correct" is not sufficient proof and must route to triage
 * rather than silently closing the obligation.
 */
export function hasExecutableEvidence(
  evidence: readonly string[] | undefined,
): boolean {
  if (!evidence || evidence.length === 0) return false;
  return evidence.some((line) => EXECUTABLE_EVIDENCE_RE.test(line));
}

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
