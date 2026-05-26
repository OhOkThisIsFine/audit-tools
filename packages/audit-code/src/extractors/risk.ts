import type { UnitManifest } from "../types.js";
import type { ExternalAnalyzerResults } from "../types/externalAnalyzer.js";
import type { CriticalFlowManifest } from "../types/flows.js";
import type { RiskItem, RiskRegister } from "../types/risk.js";

const MAX_RISK_SCORE = 10;

export function buildRiskRegister(
  unitManifest: UnitManifest,
  criticalFlows?: CriticalFlowManifest,
  externalAnalyzerResults?: ExternalAnalyzerResults,
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

    const riskScore =
      (unit.risk_score ?? 0) +
      flowHits +
      externalHits +
      (signals.includes("path_level_stateful_behavior") ? 1 : 0);

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
