// sites-pinned: tests/audit/work-blocks.test.ts
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
  compareCodeUnits,
  estimateTokensFromBytes,
  uniqueSorted,
} from "audit-tools/shared";
import {
  FINDINGS_DRAW_COHERENCE_POLICY,
  buildContentCoherenceTrace,
  type ContentCoherenceRelationship,
  type ContentCoherenceTrace,
} from "../../shared/decompose/contentCoherence.js";
import { deriveWorkBlockSeams } from "../../shared/decompose/workBlockSeams.js";
import { toPosixPath } from "../../shared/paths.js";
import { deriveWorkBlockFacts } from "../../shared/validation/findingsReport.js";

export type { WorkBlock } from "audit-tools/shared";

export interface WorkBlockPartitionInput {
  findings: Finding[];
  unitManifest?: UnitManifest;
  graphBundle?: GraphBundle;
  criticalFlows?: CriticalFlowManifest;
  sizeIndex?: Readonly<Record<string, number>>;
}

export interface WorkBlockPartition {
  coherence_trace: ContentCoherenceTrace;
  blocks: WorkBlock[];
  seams: WorkBlockSeam[];
}

function canonicalSizeIndex(
  sizeIndex?: Readonly<Record<string, number>>,
): Map<string, number> {
  const normalized = new Map<string, number>();
  for (const [path, bytes] of Object.entries(sizeIndex ?? {}).sort(([left], [right]) =>
    compareCodeUnits(left, right),
  )) {
    const key = toPosixPath(path);
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
    (sum, path) => sum + (sizes.get(toPosixPath(path)) ?? 0),
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
      const normalized = toPosixPath(path);
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
  return uniqueSorted(
    finding.affected_files.flatMap((file) => [
      ...(fileUnitMap.get(toPosixPath(file.path)) ?? []),
    ]),
  );
}

function findingFileSet(finding: Finding): Set<string> {
  return new Set(finding.affected_files.map((file) => toPosixPath(file.path)));
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
    const fromIds = byFile.get(toPosixPath(edge.from)) ?? [];
    const toIds = byFile.get(toPosixPath(edge.to)) ?? [];
    for (const fromId of fromIds) {
      for (const toId of toIds) add(fromId, toId, "call_adjacent");
    }
  }

  for (const flow of params.criticalFlows?.flows ?? []) {
    const flowFiles = new Set(
      [...flow.entrypoints, ...flow.paths].map(toPosixPath),
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
    const facts = deriveWorkBlockFacts(findings);
    const coordination = facts.role === "coordination";
    const block: WorkBlock = {
      id: `block-${index + 1}`,
      finding_ids: [...findingIds],
      unit_ids: uniqueSorted(
        findings.flatMap((finding) => unitsByFinding.get(finding.id) ?? []),
      ),
      ...facts,
      rationale: coordination
        ? `Canonical coherence component with ${findings.length} finding(s); systemic scope is presented as coordination work.`
        : `Canonical coherence component with ${findings.length} finding(s).`,
      depends_on: [],
      token_estimate: advisoryTokenEstimate(
        findings.length,
        facts.owned_files,
        sizes,
      ),
    };
    return block;
  });
  return {
    coherence_trace: coherenceTrace,
    blocks,
    seams: deriveWorkBlockSeams(blocks),
  };
}
