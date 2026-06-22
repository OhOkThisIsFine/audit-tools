import type { UnitManifest } from "../types.js";
import type { ExternalAnalyzerResults } from "../types/externalAnalyzer.js";
import type { CriticalFlowManifest, RiskItem, RiskRegister } from "audit-tools/shared";
import type { GraphSignals } from "./graphSignals.js";

const MAX_RISK_SCORE = 10;

/**
 * Cap on the correlated structural-fragility family (member_of_cycle + is_hub +
 * seam_endpoint). These three signals measure one underlying property — graph
 * fragility — so they are bounded together: even all three firing contributes at
 * most this much, ensuring the family cannot ALONE drive risk_score to the
 * MAX_RISK_SCORE clamp.
 */
const STRUCTURAL_FAMILY_CAP = 2;

/** Complexity value (from node_metrics) at/above which a unit is flagged. */
const HIGH_COMPLEXITY = 10;

/** Duplication value (from node_metrics) at/above which a unit is flagged. */
const DUPLICATION_FLOOR = 1;

export function buildRiskRegister(
  unitManifest: UnitManifest,
  criticalFlows?: CriticalFlowManifest,
  externalAnalyzerResults?: ExternalAnalyzerResults,
  graphSignals?: GraphSignals,
): RiskRegister {
  const flowMap = new Map<string, number>();
  for (const flow of criticalFlows?.flows ?? []) {
    for (const path of flow.paths) {
      flowMap.set(path, (flowMap.get(path) ?? 0) + 1);
    }
  }

  const externalByPath = new Map<string, number>();
  for (const item of externalAnalyzerResults?.results ?? []) {
    externalByPath.set(item.path, (externalByPath.get(item.path) ?? 0) + 1);
  }

  const items: RiskItem[] = unitManifest.units.map((unit) => {
    const signals: string[] = [];
    if ((unit.risk_score ?? 0) >= 5) signals.push("high_bucket_density");
    if (unit.required_lenses.includes("security"))
      signals.push("security_relevant");
    if (unit.required_lenses.includes("data_integrity"))
      signals.push("writes_or_persistence");
    if (unit.required_lenses.includes("config_deployment"))
      signals.push("operational_surface");
    if (
      unit.files.some((path) =>
        /(write|save|persist|lock|cache|retry|open|sync|refresh)/i.test(path),
      )
    ) {
      signals.push("path_level_stateful_behavior");
    }

    const flowHits = unit.files.reduce(
      (sum, path) => sum + (flowMap.get(path) ?? 0),
      0,
    );
    if (flowHits > 0) {
      signals.push("critical_flow_member");
    }

    const externalHits = unit.files.reduce(
      (sum, path) => sum + (externalByPath.get(path) ?? 0),
      0,
    );
    if (externalHits > 0) {
      signals.push("external_analyzer_signal");
    }

    // Whole-graph structural signals (single-sourced in graphSignals). A unit
    // inherits a signal when ANY of its files is so flagged in the dependency
    // graph. `member_of_cycle`, `is_hub`, and `seam_endpoint` raise
    // structural-fragility risk; `deletion_candidate` (low-in-degree dead-code
    // suspect) is informational — it flags cleanup scope without inflating the
    // risk score.
    const inCycle =
      graphSignals != null &&
      unit.files.some((path) => graphSignals.nodesInCycles.has(path));
    if (inCycle) signals.push("member_of_cycle");
    const isHub =
      graphSignals != null &&
      unit.files.some((path) => graphSignals.hubs.has(path));
    if (isHub) signals.push("is_hub");
    const isSeamEndpoint =
      graphSignals != null &&
      (graphSignals.seams ?? []).some(
        (seam) =>
          unit.files.includes(seam.from) || unit.files.includes(seam.to),
      );
    if (isSeamEndpoint) signals.push("seam_endpoint");
    const deletionCandidate =
      graphSignals != null &&
      unit.files.some((path) => graphSignals.deletionCandidates.has(path));
    if (deletionCandidate) signals.push("deletion_candidate");

    // Per-node structural metrics (read from node_metrics, single-sourced in
    // graphSignals). High complexity / duplication on any of the unit's files
    // raises maintainability risk by a bounded +1 each.
    const hasHighComplexity =
      graphSignals != null &&
      (graphSignals.complexity ?? []).some(
        (m) => unit.files.includes(m.node) && m.value >= HIGH_COMPLEXITY,
      );
    if (hasHighComplexity) signals.push("high_complexity");
    const hasDuplication =
      graphSignals != null &&
      (graphSignals.duplication ?? []).some(
        (m) => unit.files.includes(m.node) && m.value >= DUPLICATION_FLOOR,
      );
    if (hasDuplication) signals.push("duplicated_code");

    // The correlated structural family (member_of_cycle + is_hub + seam_endpoint)
    // is bounded: these three measure the SAME underlying property (graph
    // fragility) so together they contribute at most STRUCTURAL_FAMILY_CAP, and
    // therefore cannot ALONE saturate risk_score to MAX_RISK_SCORE.
    const structuralFamilyDelta = Math.min(
      STRUCTURAL_FAMILY_CAP,
      (inCycle ? 1 : 0) + (isHub ? 1 : 0) + (isSeamEndpoint ? 1 : 0),
    );

    const riskScore =
      (unit.risk_score ?? 0) +
      flowHits +
      externalHits +
      (signals.includes("path_level_stateful_behavior") ? 1 : 0) +
      structuralFamilyDelta +
      (hasHighComplexity ? 1 : 0) +
      (hasDuplication ? 1 : 0);

    return {
      unit_id: unit.unit_id,
      risk_score: Math.min(MAX_RISK_SCORE, riskScore),
      signals,
      notes: [
        "Initial heuristic risk scoring.",
        ...(externalHits > 0
          ? [
              `External analyzer signals affecting ${externalHits} path match(es).`,
            ]
          : []),
      ],
    };
  });

  return { items };
}
