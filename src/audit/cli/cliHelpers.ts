/**
 * Shared CLI helper for consistently formatted JSON command output.
 */

/**
 * Output a JSON object to stdout with standard formatting (2-space indentation).
 * Centralizes the repeated console.log(JSON.stringify(..., null, 2)) pattern.
 */
export function outputJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}
