import type { ExternalAnalyzerResults } from "../types/externalAnalyzer.js";
import { normalizeGenericExternalResults } from "./normalizeExternal.js";

/**
 * rubocop `--format json` emits a single JSON document:
 *   { files: [{ path, offenses: [{ severity, message, cop_name,
 *     location: { start_line, line, last_line } }] }] }
 * Grounded against rubocop's JSON formatter output.
 *
 * rubocop severities: "info" | "refactor" | "convention" | "warning" | "error"
 * | "fatal". We map fatal/error → high, warning → medium, everything else → low,
 * and normalize through the shared generic seam.
 */

interface RubocopLocation {
  start_line?: number;
  line?: number;
  last_line?: number;
}

interface RubocopOffense {
  severity?: string;
  message?: string;
  cop_name?: string;
  location?: RubocopLocation;
}

interface RubocopFile {
  path?: string;
  offenses?: RubocopOffense[];
}

interface RubocopJson {
  files?: RubocopFile[];
}

function mapRubocopSeverity(severity: string | undefined): string {
  switch (severity?.toLowerCase()) {
    case "fatal":
    case "error":
      return "high";
    case "warning":
      return "medium";
    default:
      return "low";
  }
}

/**
 * Parse rubocop's `--format json` stdout into the generic item shape. Degrades
 * to `[]` on empty/malformed input or a missing `files` array.
 */
export function parseRubocop(stdout: string): Array<{
  id?: string;
  category?: string;
  severity?: string;
  path?: string;
  line_start?: number;
  line_end?: number;
  summary?: string;
  rule?: string;
}> {
  let payload: RubocopJson;
  try {
    payload = JSON.parse(stdout || "{}") as RubocopJson;
  } catch {
    return [];
  }
  const files = Array.isArray(payload.files) ? payload.files : [];
  const items: Array<{
    id?: string;
    category?: string;
    severity?: string;
    path?: string;
    line_start?: number;
    line_end?: number;
    summary?: string;
    rule?: string;
  }> = [];
  for (const file of files) {
    if (!file || typeof file !== "object") continue;
    const path = typeof file.path === "string" ? file.path : "";
    if (!path) continue;
    const offenses = Array.isArray(file.offenses) ? file.offenses : [];
    for (const offense of offenses) {
      if (!offense || typeof offense !== "object") continue;
      const location = offense.location ?? {};
      const lineStart =
        typeof location.start_line === "number"
          ? location.start_line
          : typeof location.line === "number"
            ? location.line
            : undefined;
      const lineEnd = typeof location.last_line === "number" ? location.last_line : undefined;
      const rule =
        typeof offense.cop_name === "string" && offense.cop_name.length > 0
          ? offense.cop_name
          : "rubocop";
      const summary =
        typeof offense.message === "string" && offense.message.trim().length > 0
          ? offense.message
          : rule;
      items.push({
        id: `rubocop:${rule}:${path}:${lineStart ?? 0}`,
        category: "maintainability",
        severity: mapRubocopSeverity(offense.severity),
        path,
        line_start: lineStart,
        line_end: lineEnd,
        summary,
        rule,
      });
    }
  }
  return items;
}

/**
 * Dedicated severity adapter: route rubocop's parsed items through the shared
 * generic normalizer so its output matches the exact ExternalAnalyzerResults
 * contract every other analyzer emits.
 */
export function normalizeRubocopJson(stdout: string): ExternalAnalyzerResults {
  return normalizeGenericExternalResults("rubocop", parseRubocop(stdout));
}
