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

/**
 * CCU-analyzer-merge-helper-seam (risk half).
 *
 * Append an analyzer's per-unit risk signals into a risk register, returning a
 * NEW register (the input is never mutated). This is the single, pre-shipped
 * seam through which any post-build analyzer risk contribution — git-history
 * change-hotspot / broad-authorship (F6), and any later F5+ analyzer — re-enters
 * the register, so contributions can never drift in how they merge.
 *
 * Each entry of `signalsByUnit` (keyed by `unit_id`) is unioned into the
 * matching item's `signals`, deduped and re-sorted for determinism. Signals for
 * an unknown unit are ignored. `risk_score` is intentionally untouched — these
 * are informational signals; score weighting stays owned by `buildRiskRegister`.
 * Degrades to the original register (cloned) when the map is empty.
 */
export function mergeAnalyzerRiskSignals(
  register: RiskRegister,
  signalsByUnit: Map<string, string[]> | undefined,
): RiskRegister {
  const map = signalsByUnit ?? new Map<string, string[]>();
  return {
    ...register,
    items: register.items.map((item) => {
      const added = map.get(item.unit_id);
      if (!added || added.length === 0) return { ...item };
      const merged = [...new Set([...item.signals, ...added])].sort((a, b) =>
        a.localeCompare(b),
      );
      return { ...item, signals: merged };
    }),
  };
}

/** Compound signal name for a unit that is BOTH churn-heavy and complex. */
const RISK_CONCENTRATION_SIGNAL = "risk_concentration";

/**
 * Derive the churn × complexity compound signal — the real risk concentration.
 * Frequent change (`change_hotspot`, from git-history mining) on code that is
 * also structurally complex (`high_complexity`, from node_metrics) is where bugs
 * actually concentrate: each measures a different axis, and their coincidence is
 * a stronger prioritization cue than either alone. Returns a NEW register (input
 * never mutated). Kept informational (the seam invariant: analyzer-derived
 * signals never touch `risk_score`, which `buildRiskRegister` owns) — the signal
 * surfaces the concentration to lenses / synthesis without re-weighting score.
 * Idempotent: re-running never double-adds (signals are a deduped set).
 */
export function deriveRiskConcentration(register: RiskRegister): RiskRegister {
  return {
    ...register,
    items: register.items.map((item) => {
      const has = new Set(item.signals);
      if (!has.has("change_hotspot") || !has.has("high_complexity")) {
        return { ...item };
      }
      if (has.has(RISK_CONCENTRATION_SIGNAL)) return { ...item };
      const merged = [...item.signals, RISK_CONCENTRATION_SIGNAL].sort((a, b) =>
        a.localeCompare(b),
      );
      return { ...item, signals: merged };
    }),
  };
}

export function buildRiskRegister(
  unitManifest: UnitManifest,
  criticalFlows?: CriticalFlowManifest,
  externalAnalyzerResults?: ExternalAnalyzerResults[],
  graphSignals?: GraphSignals,
): RiskRegister {
  const flowMap = new Map<string, number>();
  for (const flow of criticalFlows?.flows ?? []) {
    for (const path of flow.paths) {
      flowMap.set(path, (flowMap.get(path) ?? 0) + 1);
    }
  }

  const externalByPath = new Map<string, number>();
  for (const tool of externalAnalyzerResults ?? []) {
    for (const item of tool.results ?? []) {
      externalByPath.set(item.path, (externalByPath.get(item.path) ?? 0) + 1);
    }
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
