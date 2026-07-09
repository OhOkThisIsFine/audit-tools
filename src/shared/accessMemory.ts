import type { AccessMemory, AccessMemoryPathRecord } from "./types/accessMemory.js";
import { ACCESS_MEMORY_VERSION } from "./types/accessMemory.js";

/**
 * A single normalized "touch" of a file by one step. Both orchestrators map their
 * own result shape to a stream of these, so the deterministic core below is
 * single-sourced and can't drift between audit and remediate:
 *   - audit: each `AuditResult.file_coverage[]` entry → a covered event.
 *   - remediate: each file a merged block actually edited → an edited event.
 */
export interface AccessTouchEvent {
  /** Repo-relative path, as the orchestrator sees it (normalization is the reader's job). */
  path: string;
  /** true = an edit (remediate); false = a read/coverage (audit). */
  edited: boolean;
  /** Step-ordinal: the step's position in its ledger/wave order (never wall-clock). */
  ordinal: number;
  /** Optional lens/category tag for the touch. */
  lens?: string;
}

/**
 * Deterministic core of the access-memory harvest, shared by both orchestrators.
 *
 * Pure: the same event stream always yields a byte-identical record. Frequency is
 * split into `covered_count` (reads) and `edited_count` (edits); recency is the
 * MAXIMUM ordinal that touched the path (step-ordinal space, never wall-clock).
 * Output arrays are content-sorted (paths by path, lenses lexically) so the
 * serialized bytes are stable regardless of event iteration order — the
 * "stable, content-derived array order" invariant that keeps the artifact's
 * content hash from churning the staleness DAG.
 */
export function deriveAccessMemoryFromEvents(
  events: Iterable<AccessTouchEvent>,
  options: { totalOrdinals: number; runId?: string },
): AccessMemory {
  const byPath = new Map<
    string,
    { covered: number; edited: number; lastOrdinal: number; lenses: Set<string> }
  >();

  for (const event of events) {
    if (!event.path) continue;
    let record = byPath.get(event.path);
    if (!record) {
      record = { covered: 0, edited: 0, lastOrdinal: 0, lenses: new Set<string>() };
      byPath.set(event.path, record);
    }
    if (event.edited) {
      record.edited += 1;
    } else {
      record.covered += 1;
    }
    // Max, not last-write: the event stream need not be ordinal-sorted.
    if (event.ordinal > record.lastOrdinal) {
      record.lastOrdinal = event.ordinal;
    }
    if (event.lens) record.lenses.add(event.lens);
  }

  const paths: AccessMemoryPathRecord[] = [...byPath.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, record]) => ({
      path,
      covered_count: record.covered,
      edited_count: record.edited,
      last_ordinal: record.lastOrdinal,
      lenses: [...record.lenses].sort(),
    }));

  return {
    version: ACCESS_MEMORY_VERSION,
    ...(options.runId ? { run_id: options.runId } : {}),
    total_ordinals: options.totalOrdinals,
    paths,
  };
}
