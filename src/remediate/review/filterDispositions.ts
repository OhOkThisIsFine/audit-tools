// sites-pinned: tests/remediate/intake-finding-selection.test.ts, tests/remediate/next-step-review-gate.test.ts
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { writeJsonFile } from "audit-tools/shared";
import type { Finding } from "../state/types.js";
import type { FindingFilterResult } from "../findingFilter.js";
import { droppedFindingsRecordPath, renderDroppedFindingsRecord } from "../droppedFindingsRecord.js";

// ── Path-A filter dispositions (persisted for the coverage ledger) ──────────────
// The single filter pass runs at intake over the ORIGINAL findings; its
// dispositions are persisted here so handlePendingExtractedPlan can build the
// coverage ledger over the originals (every audit finding → exactly one
// disposition), even though it runs after the pipeline has collapsed the approved
// survivors into DAG nodes. Maps are serialized as entry arrays for JSON.

const REVIEW_FILTER_DISPOSITIONS_FILENAME = "review_filter_dispositions.json";

export interface PersistedReviewFilterDispositions {
  originals: Finding[];
  mergeMap: [string, string][];
  droppedNoEvidence: string[];
  droppedPhantomPaths: [string, string[]][];
  phantomPathsRemoved: [string, string[]][];
  droppedByCheckpoint: string[];
}

export function reviewFilterDispositionsPath(artifactsDir: string): string {
  return join(artifactsDir, REVIEW_FILTER_DISPOSITIONS_FILENAME);
}

export async function persistReviewFilterDispositions(
  artifactsDir: string,
  originals: Finding[],
  filter: FindingFilterResult,
): Promise<void> {
  const payload: PersistedReviewFilterDispositions = {
    originals,
    mergeMap: [...filter.mergeMap.entries()],
    droppedNoEvidence: filter.droppedNoEvidence,
    droppedPhantomPaths: [...filter.droppedPhantomPaths.entries()],
    phantomPathsRemoved: [...filter.phantomPathsRemoved.entries()],
    droppedByCheckpoint: filter.droppedByCheckpoint,
  };
  await writeJsonFile(reviewFilterDispositionsPath(artifactsDir), payload);
  // The human half of the same fact. The JSON above keeps only IDS, which told a
  // reader an id and nothing else; this states what each removed finding WAS and
  // why it went. Written beside it, on every pass, so its absence means the pass
  // did not run rather than "nothing was dropped".
  await writeFile(
    droppedFindingsRecordPath(artifactsDir),
    renderDroppedFindingsRecord(originals, filter),
    "utf8",
  );
}
