// The two non-co-localization findings (Phase B; design of record
// spec/conceptual-design-review-design.md §"The two non-co-localizations are
// first-class findings"). When structure-consensus (behavior) and the
// intent-declared boundaries FAIL to coincide:
//   - behavioral cluster with no coherent purpose → accidental complexity / dead
//     subsystem (a coupling cluster no declared boundary owns).
//   - a purpose with no behavioral cluster → a goal smeared across the codebase,
//     never modularized (often the highest-value refactor).
//
// Deterministic LEADS, not verdicts (confidence: low): they mark where the
// behavior graphs and the human-declared boundaries disagree, for the Phase C
// charter pass to confirm against real charters. blast_radius is left unset
// (Phase C populates goal-graph linkage).

import type { Finding } from "../types.js";
import type { Partition } from "audit-tools/shared";
import { clustersFromPartitions } from "audit-tools/shared";

/** Structural boundary-integrity findings carry the architecture lens. */
const LENS = "architecture";

function createIdGenerator(): () => string {
  let n = 1;
  return () => `SD-${String(n++).padStart(3, "0")}`;
}

/** |subset ∩ group| / |subset|. */
function overlapFraction(subset: string[], group: Set<string>): number {
  if (subset.length === 0) return 0;
  let hit = 0;
  for (const m of subset) if (group.has(m)) hit += 1;
  return hit / subset.length;
}

/** Best fraction of `members` contained in any single group. */
function bestContainment(members: string[], groups: string[][]): number {
  let best = 0;
  for (const group of groups) {
    const set = new Set(group);
    const frac = overlapFraction(members, set);
    if (frac > best) best = frac;
  }
  return best;
}

export interface NonColocalizationInput {
  /** Pooled behavior partitions (every resolution of every behavior source). */
  behaviorPartitions: Partition[];
  /** All intent-declared boundaries (directory + docs + comments groups). */
  intentBoundaries: string[][];
  /** Explicit stated-purpose groups (docs + comments only — not directory). */
  purposeGroups: string[][];
  agreementThreshold?: number;
  overlapThreshold?: number;
  /** Minimum behavior-cluster size to report a no-purpose finding. */
  minClusterSize?: number;
  /** Cap on findings emitted per kind (deterministic top-by-size). */
  maxPerKind?: number;
}

const DEFAULT_AGREEMENT = 0.5;
const DEFAULT_OVERLAP = 0.6;
const DEFAULT_MIN_CLUSTER = 3;
const DEFAULT_MAX_PER_KIND = 20;

/**
 * Emit the two non-co-localization finding kinds. Deterministic: clusters/groups
 * are processed largest-first (ties by first member), and ids are a stable
 * instance-scoped SD-### sequence.
 */
export function detectNonColocalization(
  input: NonColocalizationInput,
): Finding[] {
  const agreementThreshold = input.agreementThreshold ?? DEFAULT_AGREEMENT;
  const overlapThreshold = input.overlapThreshold ?? DEFAULT_OVERLAP;
  const minClusterSize = input.minClusterSize ?? DEFAULT_MIN_CLUSTER;
  const maxPerKind = input.maxPerKind ?? DEFAULT_MAX_PER_KIND;
  const nextId = createIdGenerator();

  const bySizeThenFirst = (a: string[], b: string[]) =>
    b.length - a.length || (a[0] ?? "").localeCompare(b[0] ?? "");

  const findings: Finding[] = [];

  // One clustering pass shared by both detectors: the full set for the
  // purpose-side containment check, the size-filtered set for the no-purpose one.
  const allBehaviorClusters = clustersFromPartitions(
    input.behaviorPartitions,
    agreementThreshold,
  );

  // Single-sourced detection loop for both behavioral and purpose non-colocalization findings.
  function detectNonColocalGroup(
    groups: string[][],
    boundary: string[][],
    label: "behavioral" | "purpose",
  ): void {
    const filtered = (label === "behavioral"
      ? groups.filter((g) => g.length >= minClusterSize)
      : groups.filter((g) => g.length >= 2)
    ).sort(bySizeThenFirst);

    for (const group of filtered.slice(0, maxPerKind)) {
      const best = bestContainment(
        group,
        label === "behavioral" ? input.intentBoundaries : allBehaviorClusters,
      );
      if (best + 1e-12 >= overlapThreshold) continue;

      const titleSuffix = label === "behavioral"
        ? `Behavioral cluster spans declared boundaries: ${group.length} files`
        : `Declared purpose is behaviorally smeared: ${group.length} files`;

      const summaryText = label === "behavioral"
        ? `These ${group.length} files are tightly coupled by behavior (call/import, co-change, and/or shared state) yet no single declared boundary (directory, doc, or comment grouping) contains most of them (best overlap ${(best * 100).toFixed(0)}%). A coupling cluster no declared purpose owns is accidental complexity or a dead subsystem — a lead for the conceptual charter pass to confirm.`
        : `A doc/comment grouping declares these ${group.length} files a unit, but they do not form a behavioral cluster — no single coupling cluster contains most of them (best overlap ${(best * 100).toFixed(0)}%). A purpose smeared across the codebase and never modularized is often the highest-value refactor — a lead for the conceptual charter pass.`;

      const evidenceText = label === "behavioral"
        ? `Behavioral coupling consensus across ${input.behaviorPartitions.length} resolution levels.`
        : `Declared as one unit by an intent-declared source (doc/comment).`;

      findings.push({
        id: nextId(),
        title: titleSuffix,
        category: label === "behavioral" ? "non_colocalization_behavioral" : "non_colocalization_purpose",
        severity: "low",
        confidence: "low",
        lens: LENS,
        summary: summaryText,
        affected_files: group.map((path) => ({ path })),
        evidence: [
          evidenceText,
          `Best containment in any ${label === "behavioral" ? "declared boundary" : "behavioral cluster"}: ${(best * 100).toFixed(0)}% (threshold ${(overlapThreshold * 100).toFixed(0)}%).`,
        ],
        systemic: true,
      });
    }
  }

  // --- Behavioral cluster with no coherent purpose ---
  detectNonColocalGroup(allBehaviorClusters, input.intentBoundaries, "behavioral");

  // --- A purpose with no behavioral cluster (smeared) ---
  detectNonColocalGroup(input.purposeGroups, allBehaviorClusters, "purpose");

  return findings;
}
