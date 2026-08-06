/**
 * Shared helpers for filtering and parsing JSON event lines from test output.
 * Single-sources the JSON filtering logic used across multiple test files.
 */

/**
 * Filter lines to only those that parse as JSON with a specific event type.
 * @param lines - Array of string lines, potentially containing JSON
 * @param eventType - The event field value to match
 * @returns Array of JSON-parsed objects matching the event type
 */
export function filterJsonLinesByEvent<T extends { event?: string }>(
  lines: string[],
  eventType: string,
): T[] {
  return lines.flatMap((line) => {
    try {
      const obj = JSON.parse(line.trim()) as unknown;
      if (isRecord(obj) && obj.event === eventType) {
        return [obj as T];
      }
      return [];
    } catch {
      return [];
    }
  });
}

/**
 * Find the first JSON-parsed line with a specific event type.
 * @param lines - Array of string lines
 * @param eventType - The event field value to match
 * @returns The parsed JSON object or undefined
 */
export function findJsonEventLine<T extends { event?: string }>(
  lines: string[],
  eventType: string,
): T | undefined {
  for (const line of lines) {
    try {
      const obj = JSON.parse(line.trim()) as unknown;
      if (isRecord(obj) && obj.event === eventType) {
        return obj as T;
      }
    } catch {
      // Continue to next line
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
