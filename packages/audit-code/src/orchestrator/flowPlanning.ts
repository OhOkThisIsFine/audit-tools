import type { Lens } from "../types.js";
import type { CriticalFlowManifest } from "@audit-tools/shared";

const FLOW_REVIEW_LENSES: Lens[] = [
  "security",
  "reliability",
  "correctness",
  "data_integrity",
  "operability",
  "performance",
  "observability",
];

export interface FlowReviewBlock {
  flow_id: string;
  lens: Lens;
  file_paths: string[];
}

function lensPathKey(lens: Lens, path: string): string {
  return `${lens}:${path}`;
}

function flowLensPriority(lens: Lens): number {
  const index = FLOW_REVIEW_LENSES.indexOf(lens);
  return index >= 0 ? index : FLOW_REVIEW_LENSES.length;
}

export function claimFlowReviewBlocks(
  criticalFlows: CriticalFlowManifest,
  pendingByLens: Map<Lens, Set<string>>,
  assigned: Set<string>,
): FlowReviewBlock[] {
  const candidates: FlowReviewBlock[] = [];

  for (const flow of criticalFlows.flows) {
    const flowPaths = [...new Set(flow.paths)].sort((a, b) =>
      a.localeCompare(b),
    );
    const desiredLenses = flow.concerns
      .filter((concern): concern is Lens =>
        FLOW_REVIEW_LENSES.includes(concern as Lens),
      )
      .sort((a, b) => flowLensPriority(a) - flowLensPriority(b));

    for (const lens of desiredLenses) {
      const pendingPaths = pendingByLens.get(lens);
      if (!pendingPaths || pendingPaths.size === 0) {
        continue;
      }

      const filePaths = flowPaths.filter((path) => pendingPaths.has(path));
      if (filePaths.length === 0) {
        continue;
      }

      candidates.push({
        flow_id: flow.id,
        lens,
        file_paths: filePaths,
      });
    }
  }

  candidates.sort((a, b) => {
    const sizeDelta = b.file_paths.length - a.file_paths.length;
    if (sizeDelta !== 0) return sizeDelta;
    const lensDelta = flowLensPriority(a.lens) - flowLensPriority(b.lens);
    if (lensDelta !== 0) return lensDelta;
    return a.flow_id.localeCompare(b.flow_id);
  });

  const blocks: FlowReviewBlock[] = [];
  for (const candidate of candidates) {
    const unclaimedPaths = candidate.file_paths.filter(
      (path) => !assigned.has(lensPathKey(candidate.lens, path)),
    );
    if (unclaimedPaths.length === 0) {
      continue;
    }

    for (const path of unclaimedPaths) {
      assigned.add(lensPathKey(candidate.lens, path));
    }

    blocks.push({
      ...candidate,
      file_paths: unclaimedPaths,
    });
  }

  return blocks;
}
