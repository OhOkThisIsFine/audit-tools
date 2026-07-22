import type { Finding, UnitManifest } from "../types.js";
import type { GraphBundle, CriticalFlowManifest, RiskRegister } from "audit-tools/shared";
import type { DesignAssessment } from "../types/designAssessment.js";
import { allGraphEdges, deriveGraphSignals, type GraphSignals } from "./graphSignals.js";
import { GIT_CO_CHANGE_CATEGORY } from "./gitHistory.js";

// ID generation is instance-scoped per build (no shared mutable module state),
// so repeated/concurrent buildDesignAssessment calls produce independent,
// non-colliding DA-### sequences.
function createFindingIdGenerator(): () => string {
  let n = 1;
  return () => `DA-${String(n++).padStart(3, "0")}`;
}

function detectCycleFindings(
  signals: GraphSignals,
  nextId: () => string,
): Finding[] {
  const cycles = signals.cycles;
  if (cycles.length === 0) return [];

  return cycles.slice(0, 10).map((cycle) => ({
    id: nextId(),
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

function detectHubModules(
  signals: GraphSignals,
  nextId: () => string,
): Finding[] {
  const findings: Finding[] = [];
  // Deterministic order: `hubs` derives from the connected set's iteration order
  // (edge insertion order), so the DA-### ids assigned here are reproducible.
  for (const node of signals.hubs) {
    const inCount = signals.fanIn.get(node) ?? 0;
    const outCount = signals.fanOut.get(node) ?? 0;
    findings.push({
      id: nextId(),
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
  return findings;
}

function detectOrphanUnits(
  unitManifest: UnitManifest,
  signals: GraphSignals,
  nextId: () => string,
): Finding[] {
  const connected = signals.connected;
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
    id: nextId(),
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
  nextId: () => string,
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
    id: nextId(),
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

function detectUnitSprawl(
  unitManifest: UnitManifest,
  nextId: () => string,
): Finding[] {
  if (unitManifest.units.length < 3) return [];

  const fileCounts = unitManifest.units.map((u) => u.files.length);
  const totalFiles = fileCounts.reduce((a, b) => a + b, 0);
  const maxFiles = fileCounts.reduce((max, n) => n > max ? n : max, 0);

  const findings: Finding[] = [];

  const dominantUnit = unitManifest.units.find(
    (u) => u.files.length === maxFiles,
  );
  if (dominantUnit && maxFiles > totalFiles * 0.5 && totalFiles > 10) {
    findings.push({
      id: nextId(),
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
        id: nextId(),
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
  signals: GraphSignals,
  nextId: () => string,
): Finding[] {
  const connected = signals.connected;

  const findings: Finding[] = [];
  for (const flow of criticalFlows.flows) {
    const disconnected = flow.paths.filter((path) => !connected.has(path));
    if (
      disconnected.length > 0 &&
      disconnected.length > flow.paths.length * 0.5
    ) {
      findings.push({
        id: nextId(),
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

// Complexity value at/above which a node-keyed maintainability finding surfaces.
const HIGH_COMPLEXITY = 10;
// Duplication value at/above which a node-keyed maintainability finding surfaces.
const DUPLICATION_FLOOR = 1;

function detectComplexityHotspots(
  signals: GraphSignals,
  nextId: () => string,
): Finding[] {
  // `signals.complexity` is already node-id sorted at the source; re-sort here so
  // id assignment is reproducible regardless of upstream ordering. Each row is a
  // node-keyed finding — a node belonging to NO unit still surfaces.
  const hotspots = [...(signals.complexity ?? [])]
    .filter((m) => m.value >= HIGH_COMPLEXITY)
    .sort((a, b) => a.node.localeCompare(b.node));

  return hotspots.map((m) => ({
    id: nextId(),
    title: `High complexity: ${m.node}`,
    category: "complexity_hotspot",
    severity: "medium",
    confidence: "medium",
    lens: "maintainability" as const,
    summary: `${m.node} has a ${m.measure} of ${m.value} (reach: ${m.reach}). High structural complexity is hard to test and change safely.`,
    affected_files: [{ path: m.node }],
    systemic: false,
  }));
}

function detectDuplication(
  signals: GraphSignals,
  nextId: () => string,
): Finding[] {
  // `signals.duplication` is already node-id sorted at the source; re-sort here
  // for reproducible id assignment. Node-keyed: a duplication node owned by no
  // unit still surfaces.
  const dups = [...(signals.duplication ?? [])]
    .filter((m) => m.value >= DUPLICATION_FLOOR)
    .sort((a, b) => a.node.localeCompare(b.node));

  return dups.map((m) => ({
    id: nextId(),
    title: `Duplicated code: ${m.node}`,
    category: "code_duplication",
    severity: "low",
    confidence: "medium",
    lens: "maintainability" as const,
    summary: `${m.node} has a ${m.measure} of ${m.value} (reach: ${m.reach}). Duplicated code multiplies the cost of every future change to that logic.`,
    affected_files: [{ path: m.node }],
    systemic: false,
  }));
}

function detectSeams(
  signals: GraphSignals,
  nextId: () => string,
): Finding[] {
  // `signals.seams` is already from-then-to sorted at the source; re-sort here so
  // id assignment is reproducible. Each seam is keyed by its two endpoints — a
  // seam whose endpoints belong to no unit still surfaces as a node-keyed finding.
  const seams = [...(signals.seams ?? [])].sort(
    (a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to),
  );

  return seams.map((seam) => ({
    id: nextId(),
    title: `Architectural seam: ${seam.from} ↔ ${seam.to}`,
    category: "architectural_seam",
    severity: "medium",
    confidence: "medium",
    lens: "architecture" as const,
    summary: `The dependency between ${seam.from} and ${seam.to} is a bridge (cut-edge): its removal disconnects the two regions. A single load-bearing link is a fragility and refactor risk.`,
    affected_files: [{ path: seam.from }, { path: seam.to }],
    systemic: true,
  }));
}

/**
 * Confidence floor for a hidden-coupling finding. Co-change confidence is
 * `0.4 + 0.05*(commits-1)`, so 0.5 ⇒ files that changed together in ≥ 3 commits
 * — a repeated coupling, not a one-off shared edit.
 */
const HIDDEN_COUPLING_CONFIDENCE_FLOOR = 0.5;
/** Cap on hidden-coupling findings (strongest first) so a churny repo can't flood. */
const HIDDEN_COUPLING_CAP = 10;

/**
 * Hidden coupling — files that repeatedly change together (git co-change) yet
 * have NO structural edge (import / call / reference) connecting them. This is
 * the coupling static analysis structurally cannot see: a temporal dependency
 * with no code-level link, which the dependency graph misses entirely. Reads the
 * `co_change` bucket (git-history mining, F6) and the structural edge set; a
 * pair backed by any structural edge in either direction is NOT hidden (it is
 * already visible to the graph) and is dropped. Empty when git-history was not
 * mined (no `co_change` bucket).
 */
function detectHiddenCoupling(
  graphBundle: GraphBundle,
  nextId: () => string,
): Finding[] {
  const coChange = graphBundle.graphs[GIT_CO_CHANGE_CATEGORY];
  if (!Array.isArray(coChange) || coChange.length === 0) return [];

  // Structural adjacency (undirected): allGraphEdges excludes the co_change
  // bucket, so this is purely import/call/reference connectivity.
  const structural = new Set<string>();
  for (const edge of allGraphEdges(graphBundle)) {
    structural.add(`${edge.from}\u0000${edge.to}`);
    structural.add(`${edge.to}\u0000${edge.from}`);
  }

  const hidden = coChange
    .filter(
      (edge) =>
        typeof edge.from === "string" &&
        typeof edge.to === "string" &&
        (edge.confidence ?? 0) >= HIDDEN_COUPLING_CONFIDENCE_FLOOR &&
        !structural.has(`${edge.from}\u0000${edge.to}`),
    )
    // Strongest coupling first; ties broken by endpoints so id assignment is
    // reproducible.
    .sort(
      (a, b) =>
        (b.confidence ?? 0) - (a.confidence ?? 0) ||
        a.from.localeCompare(b.from) ||
        a.to.localeCompare(b.to),
    )
    .slice(0, HIDDEN_COUPLING_CAP);

  return hidden.map((edge) => ({
    id: nextId(),
    title: `Hidden coupling: ${edge.from} ↔ ${edge.to}`,
    category: "hidden_coupling",
    severity: "medium",
    confidence: "medium",
    lens: "architecture" as const,
    summary: `${edge.from} and ${edge.to} repeatedly change together (${edge.reason ?? "temporal coupling"}) but have no import/call/reference edge between them. This hidden coupling is invisible to static dependency analysis — a change to one likely needs a matching change to the other, with nothing in the code to signal it.`,
    affected_files: [{ path: edge.from }, { path: edge.to }],
    systemic: true,
  }));
}

export function buildDesignAssessment(params: {
  unitManifest: UnitManifest;
  graphBundle: GraphBundle;
  criticalFlows: CriticalFlowManifest;
  riskRegister: RiskRegister;
}): DesignAssessment {
  const nextId = createFindingIdGenerator();
  // Single source of truth for the whole-graph signals — the same module the
  // risk register reads, so cycle/hub/orphan derivation cannot drift between them.
  const signals = deriveGraphSignals(params.graphBundle);

  const findings: Finding[] = [
    ...detectCycleFindings(signals, nextId),
    ...detectHubModules(signals, nextId),
    ...detectOrphanUnits(params.unitManifest, signals, nextId),
    ...detectRiskConcentration(params.riskRegister, params.unitManifest, nextId),
    ...detectUnitSprawl(params.unitManifest, nextId),
    ...detectFlowGaps(params.criticalFlows, signals, nextId),
    // Appended AFTER the existing detectors so the shared DA-### id counter does
    // not renumber any pre-existing finding. Each new detector sorts its signal
    // collection before assigning ids, so ids are reproducible.
    ...detectComplexityHotspots(signals, nextId),
    ...detectDuplication(signals, nextId),
    ...detectSeams(signals, nextId),
    // Appended last: consumes the git-history co_change bucket, so it adds no
    // findings (and renumbers nothing) on a run without git-history mining.
    ...detectHiddenCoupling(params.graphBundle, nextId),
  ];

  return {
    generated_at: new Date().toISOString(),
    findings,
  };
}
