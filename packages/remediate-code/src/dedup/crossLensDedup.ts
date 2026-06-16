import {
  severityRank,
  confidenceRank,
  findingIdentityKey,
} from "@audit-tools/shared";
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

function primaryPath(finding: Finding): string {
  return finding.affected_files[0]?.path ?? "";
}

/**
 * The shared finding-identity signature of a finding, but only when it is
 * *discriminating* enough to stand on its own as an exact-match key for
 * cross-lens dedup. A structural-anchor signature with an empty scope
 * (`anchor|<path>|`) means nothing more than "same file" — too coarse to
 * collapse two findings by itself, so the fuzzy title/overlap layer must refine
 * it. We return `null` in that case so it never short-circuits the heuristic.
 * Anchored-with-scope and normalized-title signatures are discriminating and are
 * returned verbatim; the rule/category tier embeds the lens, so two cross-lens
 * findings never share it (they fall through to the fuzzy layer by design).
 */
function discriminatingIdentityKey(finding: Finding): string | null {
  const key = findingIdentityKey(finding);
  if (key.startsWith("anchor|") && key.endsWith("|")) return null;
  return key;
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
  /**
   * Maps each source finding that participates as a survivor to its cloned
   * merged copy. INV-remediate-state-05: survivors are cloned so the caller's
   * original Finding objects are never mutated in place.
   */
  const cloneOf = new Map<Finding, Finding>();

  for (const group of groups.values()) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      if (removed.has(group[i])) continue;
      for (let j = i + 1; j < group.length; j++) {
        if (removed.has(group[j])) continue;
        const a = group[i];
        const b = group[j];
        if (a.lens.toLowerCase() === b.lens.toLowerCase()) continue;

        // Category is a hard merge-key discriminator, applied ahead of BOTH the
        // exact-match and fuzzy layers: two findings that share a file/lens-pair
        // but were classified under different categories describe structurally
        // different problems and must NEVER be collapsed — e.g. ARC-86b18f1b
        // (inferred_contract_gap) vs ARC-86b18f1b-2 (invariant_counterexample)
        // stay distinct (OBL-C003-DEDUP / OBL-INV-RPS-07). Category is
        // orthogonal to the structural-anchor identity signature (which ignores
        // it), so it remains an independent hard gate. A true duplicate keeps the
        // same category and still collapses below.
        if (a.category.toLowerCase() !== b.category.toLowerCase()) continue;

        // Exact-match layer (drift-plan R2): within a matching category, the
        // shared finding-identity signature is the one authority for "is this the
        // same finding?". When two cross-lens findings share a DISCRIMINATING
        // signature they ARE the same defect — collapse even if their titles
        // diverged enough to slip under the Jaccard floor (the signature is
        // lens-independent at the structural-anchor-with-scope and
        // normalized-title tiers). Otherwise fall back to the fuzzy heuristic: a
        // moderate title overlap plus a real file overlap.
        const keyA = discriminatingIdentityKey(a);
        const keyB = discriminatingIdentityKey(b);
        const exactIdentityMatch = keyA !== null && keyA === keyB;
        if (!exactIdentityMatch) {
          const titleSim = wordJaccard(a.title, b.title);
          if (titleSim < 0.4) continue;
          if (filePathOverlap(a, b) < 0.5) continue;
        }

        const aSev = severityRank(a.severity);
        const bSev = severityRank(b.severity);
        const aConf = confidenceRank(a.confidence);
        const bConf = confidenceRank(b.confidence);
        const keepA = aSev > bSev || (aSev === bSev && aConf >= bConf);
        // originalSurvivor is one of the source Finding objects (a or b).
        // absorbed is the other source Finding.
        const originalSurvivor = keepA ? a : b;
        const absorbed = keepA ? b : a;

        // Re-use the existing clone if this survivor has already been cloned by
        // a prior pair in this group; otherwise create a new clone.
        let survivor = cloneOf.get(originalSurvivor);
        if (!survivor) {
          survivor = {
            ...originalSurvivor,
            affected_files: [...originalSurvivor.affected_files],
            evidence: originalSurvivor.evidence ? [...originalSurvivor.evidence] : [],
          };
          cloneOf.set(originalSurvivor, survivor);
          // Update the group slot so future pair iterations in the same group
          // refer to the clone rather than the unmodified source object.
          const survivorGroupIdx = keepA ? i : j;
          group[survivorGroupIdx] = survivor;
        }

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
        process.stderr.write(
          JSON.stringify({
            level: "info",
            event: "cross_lens_dedup_merge",
            absorbed_id: absorbed.id,
            absorbed_lens: absorbed.lens,
            survivor_id: survivor.id,
            survivor_lens: survivor.lens,
            ts: new Date().toISOString(),
          }) + "\n",
        );
        // If the `i`-slot finding was just absorbed (!keepA), stop the inner
        // loop — there is no point comparing an absorbed finding with more
        // candidates. The outer loop's guard (removed.has(group[i])) handles
        // advancing `i` past it on the next outer iteration.
        if (!keepA) break;
      }
    }
  }

  // Return clones for survivors, original objects for untouched findings.
  return {
    findings: findings
      .filter((f) => !removed.has(f))
      .map((f) => cloneOf.get(f) ?? f),
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
