import type { AuditTask } from "../types.js";
import { estimateTokensFromBytes } from "@audit-tools/shared";

// Per-packet sizing / token-budget arithmetic for review packetization,
// extracted from reviewPackets.ts. Estimates derive from manifest byte counts
// (recorded at intake) with a line-count fallback for manually built tasks.

export const DEFAULT_MAX_TASKS_PER_PACKET = 0;
const DEFAULT_TARGET_PACKET_LINES = 8000;
export const ESTIMATED_TOKENS_PER_LINE = 4;
export const ESTIMATED_PACKET_PROMPT_TOKENS = 900;
// Default per-packet content-token budget. Kept equal to the legacy
// line-target × per-line estimate so byte-derived sizing lands on the same
// thresholds as the old line-based sizing when the line fallback is in effect.
export const DEFAULT_TARGET_PACKET_TOKENS =
  DEFAULT_TARGET_PACKET_LINES * ESTIMATED_TOKENS_PER_LINE;

/**
 * Build a path → size_bytes index from a repo manifest. Byte counts are
 * recorded during intake, so this never reads files. Review packet token
 * estimates are derived from these bytes (Phase 2) instead of counted lines.
 */
export function sizeIndexFromManifest(
  repoManifest?: { files: ReadonlyArray<{ path: string; size_bytes: number }> },
): Record<string, number> {
  if (!repoManifest) return {};
  return Object.fromEntries(
    repoManifest.files.map((file) => [file.path, file.size_bytes]),
  );
}

/**
 * Estimated content tokens for a single file. Prefers a byte-based estimate
 * from `sizeIndex` (sourced from the repo manifest); falls back to the legacy
 * line-based estimate when no positive byte count is available (e.g. manually
 * built tasks in tests, or paths absent from the manifest).
 */
function pathContentTokens(
  owner: AuditTask | undefined,
  path: string,
  sizeIndex?: Record<string, number>,
  lineIndex?: Record<string, number>,
): number {
  const bytes = sizeIndex?.[path];
  if (typeof bytes === "number" && bytes > 0) {
    return estimateTokensFromBytes(bytes);
  }
  const lines = owner?.file_line_counts?.[path] ?? lineIndex?.[path] ?? 0;
  return lines * ESTIMATED_TOKENS_PER_LINE;
}

/** Estimated content tokens for one task across all of its files. */
export function taskContentTokens(
  task: AuditTask,
  sizeIndex?: Record<string, number>,
  lineIndex?: Record<string, number>,
): number {
  return task.file_paths.reduce(
    (sum, path) => sum + pathContentTokens(task, path, sizeIndex, lineIndex),
    0,
  );
}

/**
 * Estimated content tokens across a set of file paths, resolving an owning task
 * per path so the line fallback can read its `file_line_counts`. Shared files
 * are counted once.
 */
export function fileGroupContentTokens(
  filePaths: Iterable<string>,
  tasks: AuditTask[],
  sizeIndex?: Record<string, number>,
  lineIndex?: Record<string, number>,
): number {
  let total = 0;
  for (const path of filePaths) {
    const owner = tasks.find((task) => task.file_paths.includes(path));
    total += pathContentTokens(owner, path, sizeIndex, lineIndex);
  }
  return total;
}

export function estimateTaskGroupTokens(
  tasks: AuditTask[],
  sizeIndex?: Record<string, number>,
  lineIndex?: Record<string, number>,
): number {
  let contentTokens = 0;
  for (const task of tasks) {
    contentTokens += taskContentTokens(task, sizeIndex, lineIndex);
  }
  return ESTIMATED_PACKET_PROMPT_TOKENS + contentTokens;
}
