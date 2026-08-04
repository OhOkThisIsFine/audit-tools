import type { Finding, UnitManifest } from "../types.js";
import type {
  CriticalFlowManifest,
  GraphBundle,
  WorkBlock,
  WorkBlockSeam,
} from "audit-tools/shared";
import {
  estimateTokensFromBytes,
  partitionWorkItems,
} from "audit-tools/shared";
import { severityRank } from "./findingRanks.js";

// WorkBlock is the canonical report-block contract owned by audit-tools/shared.
export type { WorkBlock } from "audit-tools/shared";

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
  const blocksByFile = new Map<string, string[]>();
  for (const block of params.blocks) {
    if (block.role === "coordination") continue;
    for (const path of block.owned_files) {
      const owners = blocksByFile.get(path) ?? [];
      owners.push(block.id);
      blocksByFile.set(path, owners);
    }
  }

  const candidates = new Set<string>();
  const addCandidate = (from: string, to: string): void => {
    if (from !== to) candidates.add(`${from}\u0000${to}`);
  };

  const filesByBlock = new Map(
    params.blocks.map((block) => [block.id, new Set(block.owned_files)]),
  );
  const graphEdges = [
    ...(params.graphBundle?.graphs.imports ?? []),
    ...(params.graphBundle?.graphs.calls ?? []),
  ];
  for (const edge of graphEdges) {
    const fromBlocks = blocksByFile.get(edge.from) ?? [];
    const toBlocks = blocksByFile.get(edge.to) ?? [];
    for (const fromBlock of fromBlocks) {
      for (const toBlock of toBlocks) {
        if (fromBlock === toBlock) continue;
        // When both blocks cover both endpoints this edge is overlap evidence,
        // not a trustworthy ordering signal. The explicit seam owns it.
        if (
          filesByBlock.get(fromBlock)?.has(edge.to) &&
          filesByBlock.get(toBlock)?.has(edge.from)
        ) {
          continue;
        }
        addCandidate(fromBlock, toBlock);
      }
    }
  }

  for (const flow of params.criticalFlows?.flows ?? []) {
    const ordered: string[] = [];
    const seen = new Set<string>();
    for (const path of flow.paths) {
      for (const blockId of blocksByFile.get(path) ?? []) {
        if (!seen.has(blockId)) {
          seen.add(blockId);
          ordered.push(blockId);
        }
      }
    }
    for (let index = 1; index < ordered.length; index++) {
      addCandidate(ordered[index - 1]!, ordered[index]!);
    }
  }

  // Add dependencies in stable order and skip any edge that would close a
  // cycle. WorkBlock.depends_on is a scheduling DAG, while cyclic coupling is
  // represented by overlap/seam metadata instead of an unusable dependency loop.
  const dependsOn = new Map<string, Set<string>>();
  for (const block of params.blocks) {
    dependsOn.set(block.id, new Set<string>());
  }
  const reaches = (from: string, to: string): boolean => {
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current === to) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      stack.push(...(dependsOn.get(current) ?? []));
    }
    return false;
  };
  for (const candidate of [...candidates].sort((a, b) => a.localeCompare(b))) {
    const [from, to] = candidate.split("\u0000") as [string, string];
    if (!reaches(to, from)) dependsOn.get(from)?.add(to);
  }

  return params.blocks.map((block) => ({
    ...block,
    depends_on: [...(dependsOn.get(block.id) ?? [])].sort(),
  }));
}

function semanticTagsForFinding(finding: Finding): string[] {
  const titleTokens = finding.title
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 4)
    .slice(0, 6)
    .map((token) => `title:${token}`);
  return [
    `lens:${finding.lens}`,
    `category:${finding.category.toLowerCase()}`,
    ...titleTokens,
  ];
}

export interface WorkBlockPartition {
  blocks: WorkBlock[];
  seams: WorkBlockSeam[];
}

export function buildWorkBlockPartition(params: {
  findings: Finding[];
  unitManifest?: UnitManifest;
  graphBundle?: GraphBundle;
  criticalFlows?: CriticalFlowManifest;
  /** Runtime-resolved usable input window. Required for non-empty findings. */
  contextBudgetTokens?: number;
  /** Current host/provider-declared concurrency. Absent stays absent; never guessed. */
  availableParallelism?: number | null;
  /** Intake manifest path → size_bytes index for deterministic source-context estimates. */
  sizeIndex?: Readonly<Record<string, number>>;
}): WorkBlockPartition {
  if (params.findings.length === 0) {
    return { blocks: [], seams: [] };
  }
  if (
    typeof params.contextBudgetTokens !== "number" ||
    !Number.isFinite(params.contextBudgetTokens) ||
    params.contextBudgetTokens <= 0
  ) {
    throw new Error(
      "Cannot partition audit findings because the usable context budget is unknown. " +
        "Provide a current auditor capability handshake or explicit block_quota limits.",
    );
  }

  const fileUnitMap = buildFileUnitMap(params.unitManifest);
  const findingUnits = new Map<string, string[]>();
  for (const finding of params.findings) {
    const ownedUnits = normalizeOwnedUnits(finding, fileUnitMap);
    findingUnits.set(finding.id, ownedUnits);
  }
  const partition = partitionWorkItems(
    params.findings.map((finding) => ({
      id: finding.id,
      unitIds: findingUnits.get(finding.id) ?? [],
      files: finding.affected_files.map((file) => file.path),
      semanticTags: semanticTagsForFinding(finding),
      estimatedTokens: estimateTokensFromBytes(
        Buffer.byteLength(JSON.stringify(finding), "utf8"),
      ),
      role: finding.systemic === true ? "coordination" as const : "implementation" as const,
    })),
    {
      capacityTokens: params.contextBudgetTokens,
      availableParallelism: params.availableParallelism,
      fileTokenCosts: Object.fromEntries(
        Object.entries(params.sizeIndex ?? {}).map(([path, bytes]) => [
          path,
          estimateTokensFromBytes(bytes),
        ]),
      ),
    },
  );
  const findingById = new Map(params.findings.map((finding) => [finding.id, finding]));
  const entries = partition.groups.map((partitionGroup, partitionIndex) => {
    const group = partitionGroup.itemIds.map((id) => findingById.get(id)!);
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
    const block: WorkBlock = {
      id: "",
      finding_ids: orderedFindings.map((finding) => finding.id),
      unit_ids: unitIds,
      owned_files: ownedFiles,
      role: partitionGroup.role,
      max_severity: orderedFindings[0]!.severity,
      rationale:
        partitionGroup.role === "coordination"
          ? "Broad/systemic scope is isolated as a coordination obligation; its affected files remain context rather than an ownership hyperedge."
          : `Multi-objective partition: ${orderedFindings.length} finding(s), ${unitIds.length} unit(s), approximately ${partitionGroup.estimatedTokens} input token(s), with semantic/unit cohesion and explicit cross-block overlap.`,
      depends_on: [],
    };
    return { block, partitionIndex };
  });

  entries.sort((a, b) => {
    const roleDelta =
      (a.block.role === "coordination" ? 0 : 1) -
      (b.block.role === "coordination" ? 0 : 1);
    if (roleDelta !== 0) return roleDelta;
    const severityDelta =
      severityRank(b.block.max_severity) - severityRank(a.block.max_severity);
    if (severityDelta !== 0) return severityDelta;
    const findingDelta = b.block.finding_ids.length - a.block.finding_ids.length;
    if (findingDelta !== 0) return findingDelta;
    return a.block.finding_ids[0]!.localeCompare(b.block.finding_ids[0]!);
  });

  const blockIdByPartitionIndex = new Map<number, string>();
  for (let index = 0; index < entries.length; index++) {
    const id = `block-${index + 1}`;
    entries[index]!.block.id = id;
    blockIdByPartitionIndex.set(entries[index]!.partitionIndex, id);
  }
  const blocks = entries.map((entry) => entry.block);
  const orderByBlockId = new Map(blocks.map((block, index) => [block.id, index]));
  const seamRows = partition.seams.map((seam) => {
    const left = blockIdByPartitionIndex.get(seam.leftGroup)!;
    const right = blockIdByPartitionIndex.get(seam.rightGroup)!;
    const blockIds =
      (orderByBlockId.get(left) ?? 0) <= (orderByBlockId.get(right) ?? 0)
        ? ([left, right] as [string, string])
        : ([right, left] as [string, string]);
    return { seam, blockIds };
  });
  seamRows.sort((a, b) => {
    const leftDelta =
      (orderByBlockId.get(a.blockIds[0]) ?? 0) -
      (orderByBlockId.get(b.blockIds[0]) ?? 0);
    if (leftDelta !== 0) return leftDelta;
    const rightDelta =
      (orderByBlockId.get(a.blockIds[1]) ?? 0) -
      (orderByBlockId.get(b.blockIds[1]) ?? 0);
    if (rightDelta !== 0) return rightDelta;
    return a.seam.kind.localeCompare(b.seam.kind);
  });
  const seams: WorkBlockSeam[] = seamRows.map(({ seam, blockIds }, index) => ({
    id: `seam-${index + 1}`,
    block_ids: blockIds,
    kind: seam.kind,
    shared_files: seam.sharedFiles,
    shared_unit_ids: seam.sharedUnitIds,
    requires_preparation: seam.requiresPreparation,
    rationale:
      seam.kind === "shared_context"
        ? "Blocks share read/context scope but no predicted write path; parallel remediation remains safe."
        : seam.kind === "systemic_coordination"
          ? "A systemic finding spans this boundary; prepare the shared contract before parallel implementation."
          : "Both blocks cite the same predicted write path; prepare and pin the seam before parallel implementation.",
  }));

  return {
    blocks: computeDependencies({
      blocks,
      graphBundle: params.graphBundle,
      criticalFlows: params.criticalFlows,
    }),
    seams,
  };
}

export function buildWorkBlocks(
  params: Parameters<typeof buildWorkBlockPartition>[0],
): WorkBlock[] {
  return buildWorkBlockPartition(params).blocks;
}
