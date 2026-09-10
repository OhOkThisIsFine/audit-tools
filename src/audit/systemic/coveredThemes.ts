// Phase E — the COVERED-THEMES digest of the adversary loop.
//
// The loop's round prompt renders every banked improvement in full (an adversary
// cannot avoid repeating what it cannot see), but a flat list answers "what was
// said", not "what has been covered". Round 3 of the 2026-08-21 lap re-raised
// round 2's `mapWithConcurrency` item under a fresh id — the list was there and
// the lane still could not see the GROUND it had already walked. This digest is
// that ground, stated in aggregate: which lenses and categories the banked set
// already occupies, and which components it already implicates. A round that
// wants to be new can name the axis it is departing on.
//
// Deterministic and content-derived: every array is ordered by a stable key, so
// the digest never churns the register's content hash on iteration order (the
// repo's extractor-ordering invariant). PURE: no IO, no LLM.

import type { Finding } from "../types.js";
import { compareCodeUnits } from "audit-tools/shared";

/** One counted value in the digest — an abstract label plus how often it occurs. */
export interface CoveredThemeCount {
  value: string;
  count: number;
}

/**
 * What the banked improvements already cover, in aggregate. Recorded on the
 * register and rendered into the next round's prompt as the variation bar's
 * factual half.
 */
export interface SystemicCoveredThemes {
  /** Distinct lenses the banked set already occupies, path-sorted. */
  by_lens: CoveredThemeCount[];
  /** Distinct categories the banked set already occupies, path-sorted. */
  by_category: CoveredThemeCount[];
  /** Every component a banked improvement already implicates, path-sorted. */
  files: string[];
  /** How many distinct improvements are banked (the digest's own denominator). */
  finding_count: number;
}

function countBy(
  findings: readonly Finding[],
  select: (finding: Finding) => string | undefined,
): CoveredThemeCount[] {
  const counts = new Map<string, number>();
  for (const finding of findings) {
    const value = select(finding)?.trim();
    if (!value) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => compareCodeUnits(a.value, b.value));
}

/**
 * Summarize the banked findings into the covered-themes digest. An empty bank
 * yields an empty digest, never a fabricated one — the first round has covered
 * nothing and the prompt says so.
 */
export function summarizeCoveredThemes(
  findings: readonly Finding[],
): SystemicCoveredThemes {
  if (findings.length === 0) {
    return { by_lens: [], by_category: [], files: [], finding_count: 0 };
  }
  const files = new Set<string>();
  for (const finding of findings) {
    for (const file of finding.affected_files ?? []) {
      const path = file?.path?.trim();
      if (path) files.add(path);
    }
  }
  return {
    by_lens: countBy(findings, (finding) => finding.lens),
    by_category: countBy(findings, (finding) => finding.category),
    files: [...files].sort(compareCodeUnits),
    finding_count: findings.length,
  };
}
