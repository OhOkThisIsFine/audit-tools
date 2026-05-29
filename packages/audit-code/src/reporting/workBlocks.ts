import type { Finding, UnitManifest } from "../types.js";
import type {
  CriticalFlowManifest,
  GraphBundle,
  WorkBlock,
} from "@audit-tools/shared";

// WorkBlock is the canonical report-block contract owned by @audit-tools/shared.
export type { WorkBlock } from "@audit-tools/shared";

function severityRank(severity: Finding["severity"]): number {
  switch (severity) {
    case "critical":
      return 5;
    case "high":
      return 4;
    case "medium":
      return 3;
    case "low":
      return 2;
    case "info":
      return 1;
  }
}

function buildFileUnitMap(unitManifest?: UnitManifest): Map<string, string> {
  const map = new Map<string, string>();
  for (const unit of unitManifest?.units ?? []) {
    for (const path of unit.files) {
      if (!map.has(path)) {
        map.set(path, unit.unit_id);
      }
    }
  }
  return map;
}

function normalizeOwnedUnits(
  finding: Finding,
  fileUnitMap: Map<string, string>,
): string[] {
  const unitIds = new Set<string>();
  for (const file of finding.affected_files) {
    const mapped = fileUnitMap.get(file.path);
    unitIds.add(mapped ?? `file:${file.path}`);
  }
  return [...unitIds].sort();
}

function computeDependencies(params: {
  blocks: WorkBlock[];
  graphBundle?: GraphBundle;
  criticalFlows?: CriticalFlowManifest;
}): WorkBlock[] {
  const blockByFile = new Map<string, string>();
  for (const block of params.blocks) {
    for (const path of block.owned_files) {
      blockByFile.set(path, block.id);
    }
  }

  const dependsOn = new Map<string, Set<string>>();
  for (const block of params.blocks) {
    dependsOn.set(block.id, new Set<string>());
  }

  const graphEdges = [
    ...(params.graphBundle?.graphs.imports ?? []),
    ...(params.graphBundle?.graphs.calls ?? []),
  ];
  for (const edge of graphEdges) {
    const fromBlock = blockByFile.get(edge.from);
    const toBlock = blockByFile.get(edge.to);
    if (fromBlock && toBlock && fromBlock !== toBlock) {
      dependsOn.get(fromBlock)?.add(toBlock);
    }
  }

  for (const flow of params.criticalFlows?.flows ?? []) {
    const flowBlocks = new Set<string>();
    for (const path of flow.paths) {
      const blockId = blockByFile.get(path);
      if (blockId) {
        flowBlocks.add(blockId);
      }
    }
    const ordered = [...flowBlocks].sort();
    for (let i = 1; i < ordered.length; i++) {
      dependsOn.get(ordered[i - 1]!)?.add(ordered[i]!);
    }
  }

  return params.blocks.map((block) => ({
    ...block,
    depends_on: [...(dependsOn.get(block.id) ?? [])].sort(),
  }));
}

export function buildWorkBlocks(params: {
  findings: Finding[];
  unitManifest?: UnitManifest;
  graphBundle?: GraphBundle;
  criticalFlows?: CriticalFlowManifest;
}): WorkBlock[] {
  if (params.findings.length === 0) {
    return [];
  }

  const fileUnitMap = buildFileUnitMap(params.unitManifest);
  const parent = new Map<string, string>();
  const findingUnits = new Map<string, string[]>();

  function find(id: string): string {
    if (!parent.has(id)) parent.set(id, id);
    const current = parent.get(id)!;
    if (current === id) return id;
    const root = find(current);
    parent.set(id, root);
    return root;
  }

  function union(a: string, b: string): void {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) {
      parent.set(rootA, rootB);
    }
  }

  const unitToFindingIds = new Map<string, string[]>();
  for (const finding of params.findings) {
    parent.set(finding.id, finding.id);
    const ownedUnits = normalizeOwnedUnits(finding, fileUnitMap);
    findingUnits.set(finding.id, ownedUnits);
    for (const unitId of ownedUnits) {
      const ids = unitToFindingIds.get(unitId) ?? [];
      ids.push(finding.id);
      unitToFindingIds.set(unitId, ids);
    }
  }

  for (const ids of unitToFindingIds.values()) {
    for (let index = 1; index < ids.length; index++) {
      union(ids[0]!, ids[index]!);
    }
  }

  const grouped = new Map<string, Finding[]>();
  for (const finding of params.findings) {
    const root = find(finding.id);
    const group = grouped.get(root) ?? [];
    group.push(finding);
    grouped.set(root, group);
  }

  const blocks: WorkBlock[] = [...grouped.values()].map((group, index) => {
    const orderedFindings = [...group].sort((a, b) => {
      const severityDelta = severityRank(b.severity) - severityRank(a.severity);
      if (severityDelta !== 0) return severityDelta;
      return a.id.localeCompare(b.id);
    });
    const unitIds = [
      ...new Set(group.flatMap((finding) => findingUnits.get(finding.id) ?? [])),
    ].sort();
    const ownedFiles = [
      ...new Set(
        group.flatMap((finding) => finding.affected_files.map((file) => file.path)),
      ),
    ].sort();
    return {
      id: `block-${index + 1}`,
      finding_ids: orderedFindings.map((finding) => finding.id),
      unit_ids: unitIds,
      owned_files: ownedFiles,
      max_severity: orderedFindings[0]!.severity,
      rationale:
        unitIds.length === 1
          ? "All findings map to the same owned unit and should be remediated together."
          : "Findings share owned units transitively and should remain one non-overlapping remediation block.",
      depends_on: [],
    };
  });

  blocks.sort((a, b) => {
    const severityDelta = severityRank(b.max_severity) - severityRank(a.max_severity);
    if (severityDelta !== 0) return severityDelta;
    const findingDelta = b.finding_ids.length - a.finding_ids.length;
    if (findingDelta !== 0) return findingDelta;
    return a.id.localeCompare(b.id);
  });

  for (let index = 0; index < blocks.length; index++) {
    blocks[index]!.id = `block-${index + 1}`;
  }

  return computeDependencies({
    blocks,
    graphBundle: params.graphBundle,
    criticalFlows: params.criticalFlows,
  });
}
