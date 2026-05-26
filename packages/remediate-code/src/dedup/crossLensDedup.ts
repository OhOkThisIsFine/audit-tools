import type { Finding, RemediationBlock } from "../state/types.js";

function wordSet(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter(Boolean),
  );
}

export function wordJaccard(a: string, b: string): number {
  const sa = wordSet(a);
  const sb = wordSet(b);
  let intersection = 0;
  for (const w of sa) {
    if (sb.has(w)) intersection++;
  }
  const union = sa.size + sb.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function filePathOverlap(a: Finding, b: Finding): number {
  const setA = new Set(a.affected_files.map((f) => f.path));
  const setB = new Set(b.affected_files.map((f) => f.path));
  let intersection = 0;
  for (const path of setA) {
    if (setB.has(path)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

const SEVERITY_RANK: Record<string, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
};

const CONFIDENCE_RANK: Record<string, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

function primaryPath(finding: Finding): string {
  return finding.affected_files[0]?.path ?? "";
}

export interface CrossLensDedupResult {
  findings: Finding[];
  mergeMap: Map<string, string>;
}

export function deduplicateCrossLensFindings(
  findings: Finding[],
): CrossLensDedupResult {
  const groups = new Map<string, Finding[]>();
  for (const finding of findings) {
    const key = primaryPath(finding);
    const group = groups.get(key);
    if (group) {
      group.push(finding);
    } else {
      groups.set(key, [finding]);
    }
  }

  const removed = new Set<Finding>();
  const mergeMap = new Map<string, string>();

  for (const group of groups.values()) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      if (removed.has(group[i])) continue;
      for (let j = i + 1; j < group.length; j++) {
        if (removed.has(group[j])) continue;
        const a = group[i];
        const b = group[j];
        if (a.lens.toLowerCase() === b.lens.toLowerCase()) continue;

        const titleSim = wordJaccard(a.title, b.title);
        const catMatch =
          a.category.toLowerCase() === b.category.toLowerCase();
        const threshold = catMatch ? 0.4 : 0.5;
        if (titleSim < threshold) continue;
        if (filePathOverlap(a, b) < 0.5) continue;

        const aSev = SEVERITY_RANK[a.severity] ?? 0;
        const bSev = SEVERITY_RANK[b.severity] ?? 0;
        const aConf = CONFIDENCE_RANK[a.confidence] ?? 0;
        const bConf = CONFIDENCE_RANK[b.confidence] ?? 0;
        const keepA = aSev > bSev || (aSev === bSev && aConf >= bConf);
        const [survivor, absorbed] = keepA ? [a, b] : [b, a];

        const existingPaths = new Set(
          survivor.affected_files.map(
            (f) =>
              `${f.path}:${f.line_start ?? ""}:${f.line_end ?? ""}:${f.symbol ?? ""}`,
          ),
        );
        for (const file of absorbed.affected_files) {
          const fKey = `${file.path}:${file.line_start ?? ""}:${file.line_end ?? ""}:${file.symbol ?? ""}`;
          if (!existingPaths.has(fKey)) {
            survivor.affected_files.push(file);
            existingPaths.add(fKey);
          }
        }

        survivor.evidence = [
          ...new Set([
            ...(survivor.evidence ?? []),
            ...(absorbed.evidence ?? []),
          ]),
        ];
        survivor.systemic = Boolean(survivor.systemic || absorbed.systemic);
        if (absorbed.summary.length > survivor.summary.length) {
          survivor.summary = absorbed.summary;
        }

        removed.add(absorbed);
        mergeMap.set(absorbed.id, survivor.id);
      }
    }
  }

  return {
    findings: findings.filter((f) => !removed.has(f)),
    mergeMap,
  };
}

export function fixupBlocksAfterDedup(
  blocks: RemediationBlock[],
  mergeMap: Map<string, string>,
): RemediationBlock[] {
  if (mergeMap.size === 0) return blocks;
  return blocks.map((block) => ({
    ...block,
    items: [...new Set(block.items.map((id) => mergeMap.get(id) ?? id))],
  }));
}
