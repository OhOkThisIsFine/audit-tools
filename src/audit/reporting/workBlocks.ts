import type { Finding, UnitManifest } from "../types.js";
import type {
  CriticalFlowManifest,
  GraphBundle,
  WorkBlock,
  WorkBlockSeam,
} from "audit-tools/shared";
import {
  ESTIMATED_ITEM_OVERHEAD_TOKENS,
  ESTIMATED_PROMPT_OVERHEAD_TOKENS,
  estimateTokensFromBytes,
} from "audit-tools/shared";
import {
  FINDINGS_DRAW_COHERENCE_POLICY,
  buildContentCoherenceTrace,
  type ContentCoherenceRelationship,
  type ContentCoherenceTrace,
} from "../../shared/decompose/contentCoherence.js";
import { deriveWorkBlockSeams } from "../../shared/decompose/workBlockSeams.js";
import { severityRank } from "./findingRanks.js";

export type { WorkBlock } from "audit-tools/shared";

export interface WorkBlockPartitionInput {
  findings: Finding[];
  unitManifest?: UnitManifest;
  graphBundle?: GraphBundle;
  criticalFlows?: CriticalFlowManifest;
  sizeIndex?: Readonly<Record<string, number>>;
  [presentationInput: string]: unknown;
}

export interface WorkBlockPartition {
  coherence_trace: ContentCoherenceTrace;
  blocks: WorkBlock[];
  seams: WorkBlockSeam[];
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizePath(path: string): string {
  return path.replace(/\\/gu, "/");
}

function stableStrings(values: Iterable<string>): string[] {
  return [...new Set([...values])].sort(compareCodeUnits);
}

function canonicalSizeIndex(
  sizeIndex?: Readonly<Record<string, number>>,
): Map<string, number> {
  const normalized = new Map<string, number>();
  for (const [path, bytes] of Object.entries(sizeIndex ?? {}).sort(([left], [right]) =>
    compareCodeUnits(left, right),
  )) {
    const key = normalizePath(path);
    const finiteBytes = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
    normalized.set(key, Math.max(normalized.get(key) ?? 0, finiteBytes));
  }
  return normalized;
}

function advisoryTokenEstimate(
  findingCount: number,
  files: readonly string[],
  sizes: ReadonlyMap<string, number>,
): number {
  const physicalBytes = files.reduce(
    (sum, path) => sum + (sizes.get(normalizePath(path)) ?? 0),
    0,
  );
  return (
    ESTIMATED_PROMPT_OVERHEAD_TOKENS +
    findingCount * ESTIMATED_ITEM_OVERHEAD_TOKENS +
    estimateTokensFromBytes(physicalBytes)
  );
}

function buildFileUnitMap(
  unitManifest?: UnitManifest,
): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const unit of unitManifest?.units ?? []) {
    for (const path of unit.files) {
      const normalized = normalizePath(path);
      const unitIds = map.get(normalized) ?? new Set<string>();
      unitIds.add(unit.unit_id);
      map.set(normalized, unitIds);
    }
  }
  return map;
}

function unitsForFinding(
  finding: Finding,
  fileUnitMap: ReadonlyMap<string, Set<string>>,
): string[] {
  return stableStrings(
    finding.affected_files.flatMap((file) => [
      ...(fileUnitMap.get(normalizePath(file.path)) ?? []),
    ]),
  );
}

function findingFileSet(finding: Finding): Set<string> {
  return new Set(finding.affected_files.map((file) => normalizePath(file.path)));
}

function pairRelationship(
  left: string,
  right: string,
  kind: string,
): ContentCoherenceRelationship {
  return compareCodeUnits(left, right) <= 0
    ? { left, right, kind }
    : { left: right, right: left, kind };
}

function relationshipsForFindings(params: {
  findings: readonly Finding[];
  graphBundle?: GraphBundle;
  criticalFlows?: CriticalFlowManifest;
}): ContentCoherenceRelationship[] {
  const fileSets = new Map(
    params.findings.map((finding) => [finding.id, findingFileSet(finding)]),
  );
  const byFile = new Map<string, string[]>();
  for (const finding of params.findings) {
    for (const path of fileSets.get(finding.id) ?? []) {
      const ids = byFile.get(path) ?? [];
      ids.push(finding.id);
      byFile.set(path, ids);
    }
  }
  for (const ids of byFile.values()) ids.sort(compareCodeUnits);

  const deduped = new Map<string, ContentCoherenceRelationship>();
  const add = (left: string, right: string, kind: string): void => {
    if (left === right) return;
    const relation = pairRelationship(left, right, kind);
    deduped.set(
      `${relation.left}\u0000${relation.right}\u0000${relation.kind}`,
      relation,
    );
  };

  const graphEdges = [
    ...(params.graphBundle?.graphs.imports ?? []),
    ...(params.graphBundle?.graphs.calls ?? []),
    ...(params.graphBundle?.graphs.references ?? []),
  ];
  for (const edge of graphEdges) {
    const fromIds = byFile.get(normalizePath(edge.from)) ?? [];
    const toIds = byFile.get(normalizePath(edge.to)) ?? [];
    for (const fromId of fromIds) {
      for (const toId of toIds) add(fromId, toId, "call_adjacent");
    }
  }

  for (const flow of params.criticalFlows?.flows ?? []) {
    const flowFiles = new Set(
      [...flow.entrypoints, ...flow.paths].map(normalizePath),
    );
    const members = params.findings
      .filter((finding) =>
        [...(fileSets.get(finding.id) ?? [])].some((path) =>
          flowFiles.has(path),
        ),
      )
      .map((finding) => finding.id)
      .sort(compareCodeUnits);
    for (let leftIndex = 0; leftIndex < members.length; leftIndex += 1) {
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < members.length;
        rightIndex += 1
      ) {
        add(members[leftIndex]!, members[rightIndex]!, "same_flow");
      }
    }
  }

  return [...deduped.values()].sort((left, right) => {
    const leftKey = `${left.left}\u0000${left.right}\u0000${left.kind}`;
    const rightKey = `${right.left}\u0000${right.right}\u0000${right.kind}`;
    return compareCodeUnits(leftKey, rightKey);
  });
}

function blockDependencies(params: {
  blocks: readonly WorkBlock[];
  graphBundle?: GraphBundle;
  criticalFlows?: CriticalFlowManifest;
}): WorkBlock[] {
  const blocksByFile = new Map<string, string[]>();
  for (const block of params.blocks) {
    for (const path of block.owned_files) {
      const normalized = normalizePath(path);
      const blockIds = blocksByFile.get(normalized) ?? [];
      blockIds.push(block.id);
      blocksByFile.set(normalized, blockIds);
    }
  }
  for (const ids of blocksByFile.values()) ids.sort(compareCodeUnits);

  const candidates = new Set<string>();
  const addCandidate = (from: string, to: string): void => {
    if (from !== to) candidates.add(`${from}\u0000${to}`);
  };
  for (const edge of [
    ...(params.graphBundle?.graphs.imports ?? []),
    ...(params.graphBundle?.graphs.calls ?? []),
    ...(params.graphBundle?.graphs.references ?? []),
  ]) {
    for (const from of blocksByFile.get(normalizePath(edge.from)) ?? []) {
      for (const to of blocksByFile.get(normalizePath(edge.to)) ?? []) {
        addCandidate(from, to);
      }
    }
  }
  for (const flow of params.criticalFlows?.flows ?? []) {
    const ordered: string[] = [];
    const seen = new Set<string>();
    for (const path of [...flow.entrypoints, ...flow.paths]) {
      for (const blockId of blocksByFile.get(normalizePath(path)) ?? []) {
        if (seen.has(blockId)) continue;
        seen.add(blockId);
        ordered.push(blockId);
      }
    }
    for (let index = 1; index < ordered.length; index += 1) {
      addCandidate(ordered[index - 1]!, ordered[index]!);
    }
  }

  const dependencies = new Map(
    params.blocks.map((block) => [block.id, new Set<string>()]),
  );
  const reaches = (from: string, target: string): boolean => {
    const pending = [from];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (current === target) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      pending.push(...(dependencies.get(current) ?? []));
    }
    return false;
  };
  for (const candidate of [...candidates].sort(compareCodeUnits)) {
    const [from, to] = candidate.split("\u0000") as [string, string];
    if (!reaches(to, from)) dependencies.get(from)?.add(to);
  }
  return params.blocks.map((block) => ({
    ...block,
    depends_on: [...(dependencies.get(block.id) ?? [])].sort(compareCodeUnits),
  }));
}

/** Project findings through the shared content-coherence membership core. */
export function buildWorkBlockPartition(
  params: WorkBlockPartitionInput,
): WorkBlockPartition {
  const fileUnitMap = buildFileUnitMap(params.unitManifest);
  const unitsByFinding = new Map(
    params.findings.map((finding) => [
      finding.id,
      unitsForFinding(finding, fileUnitMap),
    ]),
  );
  const coherenceTrace = buildContentCoherenceTrace(
    {
      items: params.findings.map((finding) => ({
        id: finding.id,
        file_paths: finding.affected_files.map((file) => file.path),
        unit_ids: unitsByFinding.get(finding.id) ?? [],
        tags: [finding.lens],
      })),
      relationships: relationshipsForFindings(params),
    },
    FINDINGS_DRAW_COHERENCE_POLICY,
  );
  const findingById = new Map(
    params.findings.map((finding) => [finding.id, finding]),
  );
  const sizes = canonicalSizeIndex(params.sizeIndex);
  const blocks = coherenceTrace.components.map((findingIds, index) => {
    const findings = findingIds.map((findingId) => findingById.get(findingId)!);
    const coordination = findings.some((finding) => finding.systemic === true);
    const maxSeverity = [...findings].sort(
      (left, right) =>
        severityRank(right.severity) - severityRank(left.severity) ||
        compareCodeUnits(left.id, right.id),
    )[0]!.severity;
    const ownedFiles = stableStrings(
      findings.flatMap((finding) =>
        finding.affected_files.map((file) => normalizePath(file.path)),
      ),
    );
    const block: WorkBlock = {
      id: `block-${index + 1}`,
      finding_ids: [...findingIds],
      unit_ids: stableStrings(
        findings.flatMap((finding) => unitsByFinding.get(finding.id) ?? []),
      ),
      owned_files: ownedFiles,
      role: coordination ? "coordination" : "implementation",
      max_severity: maxSeverity,
      rationale: coordination
        ? `Canonical coherence component with ${findings.length} finding(s); systemic scope is presented as coordination work.`
        : `Canonical coherence component with ${findings.length} finding(s).`,
      depends_on: [],
      token_estimate: advisoryTokenEstimate(
        findings.length,
        ownedFiles,
        sizes,
      ),
    };
    return block;
  });
  const withDependencies = blockDependencies({
    blocks,
    graphBundle: params.graphBundle,
    criticalFlows: params.criticalFlows,
  });
  return {
    coherence_trace: coherenceTrace,
    blocks: withDependencies,
    seams: deriveWorkBlockSeams(withDependencies),
  };
}
