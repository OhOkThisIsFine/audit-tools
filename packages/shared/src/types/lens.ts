// Canonical audit-lens vocabulary and the runtime validation Sets derived from
// it. Single source of truth so the auditor's validators, the remediator, and
// any future consumer all agree on the valid lens / severity / confidence
// values — previously each package hand-copied these lists, which drifted (a
// copy omitting "observability" once caused it to be wrongly rejected).
//
// The `Lens` type, `LENSES` array, and `VALID_LENSES` Set are all derived from
// the same literal tuple, so adding a lens in one place updates all three.

import type { FindingSeverity, FindingConfidence } from "./finding.js";

/** The canonical ordered tuple every other lens artifact derives from. */
export const LENSES = [
  "correctness",
  "architecture",
  "maintainability",
  "security",
  "reliability",
  "performance",
  "data_integrity",
  "tests",
  "operability",
  "config_deployment",
  "observability",
] as const;

/** Audit lens: one analytical perspective an audit task covers a unit under. */
export type Lens = (typeof LENSES)[number];

/** Runtime membership test set for {@link Lens}. */
export const VALID_LENSES: ReadonlySet<string> = new Set(LENSES);

export function isLens(value: unknown): value is Lens {
  return typeof value === "string" && VALID_LENSES.has(value);
}

/** The canonical ordered tuple of finding severities. */
export const SEVERITIES = [
  "critical",
  "high",
  "medium",
  "low",
  "info",
] as const satisfies readonly FindingSeverity[];

/** Runtime membership test set for {@link FindingSeverity}. */
export const VALID_SEVERITIES: ReadonlySet<string> = new Set(SEVERITIES);

/** The canonical ordered tuple of finding confidence levels. */
export const CONFIDENCES = [
  "high",
  "medium",
  "low",
] as const satisfies readonly FindingConfidence[];

/** Runtime membership test set for {@link FindingConfidence}. */
export const VALID_CONFIDENCES: ReadonlySet<string> = new Set(CONFIDENCES);

// ── Severity / confidence ranking ─────────────────────────────────────────────
// Single source of truth for "how severe / how confident is this, numerically".
// Both orchestrators previously hand-copied a `SEVERITY_RANK`/`CONFIDENCE_RANK`
// table (audit findingRanks.ts, selectiveDeepening, dispatch, crossLensDedup,
// intake, agentReflections), and the copies drifted: some were 0-based, some
// 1-based, and intake's ordering was inverted. These functions are DERIVED from
// the canonical ordered tuples above so a new severity/confidence level updates
// every consumer at once and the scale can never diverge.
//
// Convention: higher rank == more severe / more confident. The most-severe
// level (`critical`) gets the largest rank (= SEVERITIES.length, i.e. 5) and the
// least-severe (`info`) gets 1; confidence ranks high=3, medium=2, low=1. The
// 1-based scale is load-bearing — e.g. remediate dispatch tiering compares the
// rank against literal thresholds (critical === 5, low <= 2).

/**
 * Numeric severity rank: `critical`=5, `high`=4, `medium`=3, `low`=2, `info`=1.
 * Higher == more severe. Derived from {@link SEVERITIES} so it never drifts.
 */
export function severityRank(severity: FindingSeverity): number {
  // SEVERITIES is ordered most-severe-first, so invert the index to a 1-based
  // "higher is worse" scale.
  return SEVERITIES.length - SEVERITIES.indexOf(severity);
}

/**
 * Numeric confidence rank: `high`=3, `medium`=2, `low`=1. Higher == more
 * confident. Derived from {@link CONFIDENCES} so it never drifts.
 */
export function confidenceRank(confidence: FindingConfidence): number {
  return CONFIDENCES.length - CONFIDENCES.indexOf(confidence);
}

/**
 * Comparator that orders severities **most-severe-first** (`critical` before
 * `info`). Returns a negative number when `a` is more severe than `b`, so
 * `findings.sort((x, y) => severityCompare(x.severity, y.severity))` puts the
 * most-severe finding first. Single-sources the "critical-first" sort direction
 * that intake previously open-coded with an inverted ad-hoc table.
 */
export function severityCompare(a: FindingSeverity, b: FindingSeverity): number {
  return severityRank(b) - severityRank(a);
}
