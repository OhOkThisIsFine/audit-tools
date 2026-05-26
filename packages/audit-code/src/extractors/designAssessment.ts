import type { Finding, UnitManifest } from "../types.js";
import type { DesignAssessment } from "../types/designAssessment.js";
import type { GraphBundle, GraphEdge } from "../types/graph.js";
import type { CriticalFlowManifest } from "../types/flows.js";
import type { RiskRegister } from "../types/risk.js";

let nextFindingId = 1;

function findingId(): string {
  return `DA-${String(nextFindingId++).padStart(3, "0")}`;
}

function allEdges(graphBundle: GraphBundle): GraphEdge[] {
  const edges: GraphEdge[] = [];
  for (const [key, value] of Object.entries(graphBundle.graphs)) {
    if (key === "routes" || !Array.isArray(value)) continue;
    for (const edge of value) {
      if (edge && typeof edge.from === "string" && typeof edge.to === "string") {
        edges.push(edge);
      }
    }
  }
  return edges;
}

function detectCycles(edges: GraphEdge[]): string[][] {
  const adjacency = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, new Set());
    adjacency.get(edge.from)!.add(edge.to);
  }

  const cycles: string[][] = [];
  const visited = new Set<string>();
  const stack = new Set<string>();

  function dfs(node: string, path: string[]): void {
    if (stack.has(node)) {
      const cycleStart = path.indexOf(node);
      if (cycleStart >= 0) {
        cycles.push(path.slice(cycleStart));
      }
      return;
    }
    if (visited.has(node)) return;

    visited.add(node);
    stack.add(node);
    path.push(node);

    for (const neighbor of adjacency.get(node) ?? []) {
      dfs(neighbor, path);
    }

    path.pop();
    stack.delete(node);
  }

  for (const node of adjacency.keys()) {
    dfs(node, []);
  }
  return cycles;
}

function deduplicateCycles(cycles: string[][]): string[][] {
  const seen = new Set<string>();
  const unique: string[][] = [];
  for (const cycle of cycles) {
    const normalized = [...cycle].sort().join("\0");
    if (!seen.has(normalized)) {
      seen.add(normalized);
      unique.push(cycle);
    }
  }
  return unique;
}

function detectCycleFindings(graphBundle: GraphBundle): Finding[] {
  const edges = allEdges(graphBundle);
  const cycles = deduplicateCycles(detectCycles(edges));
  if (cycles.length === 0) return [];

  return cycles.slice(0, 10).map((cycle) => ({
    id: findingId(),
    title: `Dependency cycle: ${cycle.length} modules`,
    category: "dependency_cycle",
    severity: cycle.length > 4 ? "high" : "medium",
    confidence: "high",
    lens: "architecture" as const,
    summary: `Circular dependency among ${cycle.join(" → ")} → ${cycle[0]}. Cycles increase coupling, complicate testing, and can cause initialization-order bugs.`,
    affected_files: cycle.map((path) => ({ path })),
    systemic: true,
  }));
}

function detectHubModules(graphBundle: GraphBundle): Finding[] {
  const edges = allEdges(graphBundle);
  const fanIn = new Map<string, number>();
  const fanOut = new Map<string, number>();

  for (const edge of edges) {
    fanOut.set(edge.from, (fanOut.get(edge.from) ?? 0) + 1);
    fanIn.set(edge.to, (fanIn.get(edge.to) ?? 0) + 1);
  }

  const allNodes = new Set([...fanIn.keys(), ...fanOut.keys()]);
  const hubThreshold = Math.max(8, Math.ceil(allNodes.size * 0.15));

  const findings: Finding[] = [];
  for (const node of allNodes) {
    const inCount = fanIn.get(node) ?? 0;
    const outCount = fanOut.get(node) ?? 0;
    if (inCount >= hubThreshold && outCount >= hubThreshold) {
      findings.push({
        id: findingId(),
        title: `Hub module: ${node}`,
        category: "hub_module",
        severity: "medium",
        confidence: "high",
        lens: "architecture",
        summary: `${node} has ${inCount} incoming and ${outCount} outgoing dependencies. Hub modules become change bottlenecks and make the dependency graph fragile.`,
        affected_files: [{ path: node }],
        systemic: true,
      });
    }
  }
  return findings;
}

function detectOrphanUnits(
  unitManifest: UnitManifest,
  graphBundle: GraphBundle,
): Finding[] {
  const edges = allEdges(graphBundle);
  const connected = new Set<string>();
  for (const edge of edges) {
    connected.add(edge.from);
    connected.add(edge.to);
  }

  if (connected.size === 0) return [];

  const orphans: string[] = [];
  for (const unit of unitManifest.units) {
    const hasConnection = unit.files.some((file) => connected.has(file));
    if (!hasConnection && unit.files.length > 0) {
      orphans.push(unit.unit_id);
    }
  }

  if (orphans.length === 0) return [];
  if (orphans.length > unitManifest.units.length * 0.5) return [];

  return [{
    id: findingId(),
    title: `${orphans.length} orphan unit(s) with no graph connections`,
    category: "orphan_units",
    severity: "low",
    confidence: "medium",
    lens: "architecture",
    summary: `Units [${orphans.join(", ")}] have no import, call, or reference edges in the dependency graph. They may be dead code, or the graph extraction missed their connections.`,
    affected_files: orphans.map((id) => {
      const unit = unitManifest.units.find((u) => u.unit_id === id);
      return { path: unit?.files[0] ?? id };
    }),
    systemic: true,
  }];
}

function detectRiskConcentration(
  riskRegister: RiskRegister,
  unitManifest: UnitManifest,
): Finding[] {
  if (riskRegister.items.length < 4) return [];

  const sorted = [...riskRegister.items].sort(
    (a, b) => b.risk_score - a.risk_score,
  );
  const topQuartileSize = Math.max(1, Math.ceil(sorted.length * 0.25));
  const topQuartile = sorted.slice(0, topQuartileSize);
  const totalRisk = sorted.reduce((sum, item) => sum + item.risk_score, 0);
  const topRisk = topQuartile.reduce((sum, item) => sum + item.risk_score, 0);

  if (totalRisk === 0) return [];
  const concentration = topRisk / totalRisk;

  if (concentration < 0.6) return [];

  return [{
    id: findingId(),
    title: "Risk concentrated in top quartile of units",
    category: "risk_concentration",
    severity: concentration > 0.8 ? "high" : "medium",
    confidence: "high",
    lens: "architecture",
    summary: `${Math.round(concentration * 100)}% of total risk score is concentrated in the top ${topQuartileSize} of ${sorted.length} units: ${topQuartile.map((i) => i.unit_id).join(", ")}. Consider decomposing high-risk units or adding isolation boundaries.`,
    affected_files: topQuartile.flatMap((item) => {
      const unit = unitManifest.units.find((u) => u.unit_id === item.unit_id);
      return (unit?.files ?? [item.unit_id]).map((path) => ({ path }));
    }),
    systemic: true,
  }];
}

function detectUnitSprawl(unitManifest: UnitManifest): Finding[] {
  if (unitManifest.units.length < 3) return [];

  const fileCounts = unitManifest.units.map((u) => u.files.length);
  const totalFiles = fileCounts.reduce((a, b) => a + b, 0);
  const maxFiles = Math.max(...fileCounts);

  const findings: Finding[] = [];

  const dominantUnit = unitManifest.units.find(
    (u) => u.files.length === maxFiles,
  );
  if (dominantUnit && maxFiles > totalFiles * 0.5 && totalFiles > 10) {
    findings.push({
      id: findingId(),
      title: `Dominant unit: ${dominantUnit.unit_id}`,
      category: "monolith_unit",
      severity: "medium",
      confidence: "medium",
      lens: "architecture",
      summary: `Unit ${dominantUnit.unit_id} contains ${maxFiles} of ${totalFiles} files (${Math.round((maxFiles / totalFiles) * 100)}%). A single unit this large suggests insufficient decomposition.`,
      affected_files: dominantUnit.files.slice(0, 10).map((path) => ({ path })),
      systemic: true,
    });
  }

  if (unitManifest.units.length > 50) {
    const smallUnits = unitManifest.units.filter((u) => u.files.length === 1);
    if (smallUnits.length > unitManifest.units.length * 0.6) {
      findings.push({
        id: findingId(),
        title: "Excessive single-file units",
        category: "unit_fragmentation",
        severity: "low",
        confidence: "medium",
        lens: "architecture",
        summary: `${smallUnits.length} of ${unitManifest.units.length} units contain only a single file. This fragmentation may indicate that the unit grouping is too granular to reflect meaningful architectural boundaries.`,
        affected_files: smallUnits.slice(0, 5).map((u) => ({ path: u.files[0] })),
        systemic: true,
      });
    }
  }

  return findings;
}

function detectFlowGaps(
  criticalFlows: CriticalFlowManifest,
  graphBundle: GraphBundle,
): Finding[] {
  const edges = allEdges(graphBundle);
  const connected = new Set<string>();
  for (const edge of edges) {
    connected.add(edge.from);
    connected.add(edge.to);
  }

  const findings: Finding[] = [];
  for (const flow of criticalFlows.flows) {
    const disconnected = flow.paths.filter((path) => !connected.has(path));
    if (
      disconnected.length > 0 &&
      disconnected.length > flow.paths.length * 0.5
    ) {
      findings.push({
        id: findingId(),
        title: `Critical flow "${flow.name}" has weak graph coverage`,
        category: "flow_gap",
        severity: "medium",
        confidence: "low",
        lens: "architecture",
        summary: `${disconnected.length} of ${flow.paths.length} files in flow "${flow.name}" have no dependency graph edges. The flow's structural integrity cannot be verified through static analysis alone.`,
        affected_files: disconnected.map((path) => ({ path })),
        systemic: true,
      });
    }
  }
  return findings;
}

export function buildDesignAssessment(params: {
  unitManifest: UnitManifest;
  graphBundle: GraphBundle;
  criticalFlows: CriticalFlowManifest;
  riskRegister: RiskRegister;
}): DesignAssessment {
  nextFindingId = 1;

  const findings: Finding[] = [
    ...detectCycleFindings(params.graphBundle),
    ...detectHubModules(params.graphBundle),
    ...detectOrphanUnits(params.unitManifest, params.graphBundle),
    ...detectRiskConcentration(params.riskRegister, params.unitManifest),
    ...detectUnitSprawl(params.unitManifest),
    ...detectFlowGaps(params.criticalFlows, params.graphBundle),
  ];

  return {
    generated_at: new Date().toISOString(),
    findings,
  };
}
