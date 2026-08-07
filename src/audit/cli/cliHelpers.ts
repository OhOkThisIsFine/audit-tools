/**
 * Shared CLI helper functions for common patterns across command files.
 * Extracted from: MNT-343762f6 (JSON output), MNT-6ba55c63 (lineIndex construction)
 */

/**
 * Output a JSON object to stdout with standard formatting (2-space indentation).
 * Centralizes the repeated console.log(JSON.stringify(..., null, 2)) pattern.
 */
export function outputJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

/**
 * Build a line index from audit tasks' file_line_counts.
 * Extracts the duplicated pattern from dispatch.ts and packetFilter.ts.
 * MNT-6ba55c63: Duplicated lineIndex construction logic
 */
export function buildLineIndexFromTasks(
  tasks: Array<{ file_line_counts?: Record<string, number> | null }>,
): Record<string, number> {
  return Object.fromEntries(
    tasks.flatMap((task) =>
      Object.entries(task.file_line_counts ?? {}),
    ),
  );
}
