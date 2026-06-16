// Single finding-filter pass (review-gate convergence, chunk A).
//
// The pre-planning filters — no-evidence drop, cross-lens dedup, phantom-path
// grounding, intent-checkpoint exclusion — historically ran in two different
// places with two different orderings: `runPlanPhase` (document/conversation
// path) ran them inline up front, while the structured-audit/contract-pipeline
// path ran dedup + grounding LATE, after the pipeline collapsed findings into DAG
// nodes, and never applied the checkpoint at all. That split is why the review
// preview could show findings that were about to be deduped/dropped.
//
// This is the ONE pass: run it once, on a finding set, BEFORE the review preview,
// so the preview shows exactly the survivors and the dispositions feed the
// coverage ledger verbatim. Its output shape is the `buildCoverageLedger`
// disposition inputs (minus planId/items), so the ledger never has to recompute
// any of it.
//
// Pure-ish: deterministic given the same findings + checkpoint + disk state; the
// only IO is phantom-path existence checks (via groundExtractedFindings).

import type { Finding, IntentCheckpoint } from "@audit-tools/shared";
import { deduplicateCrossLensFindings } from "./dedup/crossLensDedup.js";
import {
  groundExtractedFindings,
  type GroundExtractedFindingsOptions,
} from "./phases/grounding.js";
import { filterFindingsByCheckpoint } from "./intent/checkpointFilter.js";

/** Survivors plus every pre-planning disposition, in `buildCoverageLedger` shape. */
export interface FindingFilterResult {
  /** Findings that survive every filter — the set the preview shows and the pipeline acts on. */
  survivors: Finding[];
  /** Cross-lens dedup map: absorbed finding id → surviving canonical finding id. */
  mergeMap: Map<string, string>;
  /** Ids dropped for carrying no evidence. */
  droppedNoEvidence: string[];
  /** Ids dropped because every cited path was phantom, with the phantom paths. */
  droppedPhantomPaths: Map<string, string[]>;
  /** Phantom paths stripped from surviving findings (kept, not dropped). */
  phantomPathsRemoved: Map<string, string[]>;
  /** Ids dropped by the intent checkpoint (filters / excluded scope). */
  droppedByCheckpoint: string[];
}

export interface RunFindingFilterPassOptions {
  root: string;
  /** Confirmed intent checkpoint; absent/draft/no-constraints keeps everything. */
  checkpoint?: IntentCheckpoint;
  /**
   * Passed through to grounding: set false for findings grounded by construction
   * (contract-pipeline obligation evidence) rather than by path citation. Path
   * grounding still runs. Defaults to true (original audit findings cite paths).
   */
  evidenceGrounding?: boolean;
  /** Optional one-shot repair for all-phantom findings (see groundExtractedFindings). */
  repairZeroPathFindings?: GroundExtractedFindingsOptions["repairZeroPathFindings"];
}

/**
 * Run the canonical pre-planning filter chain once, in the established order:
 *   1. drop findings with no evidence,
 *   2. cross-lens dedup (fold duplicates a different lens flagged independently),
 *   3. phantom-path grounding (strip non-existent paths; drop all-phantom findings),
 *   4. intent-checkpoint exclusion (severity/lens/package/theme/scope filters).
 *
 * Returns the survivors and the full disposition record. Operates on findings
 * only — block pruning is the caller's job (prune to `survivors` once at the end).
 */
export async function runFindingFilterPass(
  findings: Finding[],
  options: RunFindingFilterPassOptions,
): Promise<FindingFilterResult> {
  // 1. No-evidence drop.
  const droppedNoEvidence = findings
    .filter((f) => !Array.isArray(f.evidence) || f.evidence.length === 0)
    .map((f) => f.id);
  let kept = findings.filter(
    (f) => Array.isArray(f.evidence) && f.evidence.length > 0,
  );

  // 2. Cross-lens dedup.
  const dedup = deduplicateCrossLensFindings(kept);
  kept = dedup.findings;

  // 3. Phantom-path grounding.
  const grounding = await groundExtractedFindings(kept, {
    root: options.root,
    evidenceGrounding: options.evidenceGrounding ?? true,
    ...(options.repairZeroPathFindings
      ? { repairZeroPathFindings: options.repairZeroPathFindings }
      : {}),
  });
  kept = grounding.findings;

  // 4. Intent-checkpoint exclusion.
  const { kept: checkpointKept, droppedIds: droppedByCheckpoint } =
    filterFindingsByCheckpoint(kept, options.checkpoint);
  kept = checkpointKept;

  return {
    survivors: kept,
    mergeMap: dedup.mergeMap,
    droppedNoEvidence,
    droppedPhantomPaths: new Map(
      grounding.dropped.map((d) => [d.finding.id, d.phantomPaths]),
    ),
    phantomPathsRemoved: grounding.phantomPathsByFinding,
    droppedByCheckpoint,
  };
}
