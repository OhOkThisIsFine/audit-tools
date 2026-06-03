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
