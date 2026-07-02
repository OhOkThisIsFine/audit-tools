import type { ExternalAnalyzerResults } from "../types/externalAnalyzer.js";
import { normalizeGenericExternalResults } from "./normalizeExternal.js";

/**
 * cargo-clippy `--message-format=json` emits ONE JSON object PER LINE (a
 * "cargo message" stream), not a single JSON document. The compiler diagnostics
 * we care about are the `reason: "compiler-message"` lines, whose `message`
 * field is an rustc diagnostic:
 *   { reason, message: { level, message, code?: { code },
 *     spans: [{ file_name, line_start, line_end, is_primary }] } }
 * Grounded against rustc's JSON diagnostic shape + cargo's message envelope.
 *
 * clippy's `level` values: "error" | "warning" | "note" | "help". We map error
 * → high, warning → medium, everything else → low, and normalize through the
 * shared generic seam.
 */

interface ClippySpan {
  file_name?: string;
  line_start?: number;
  line_end?: number;
  is_primary?: boolean;
}

interface ClippyMessage {
  level?: string;
  message?: string;
  code?: { code?: string } | null;
  spans?: ClippySpan[];
}

interface ClippyCargoLine {
  reason?: string;
  message?: ClippyMessage;
}

function mapClippySeverity(level: string | undefined): string {
  switch (level?.toLowerCase()) {
    case "error":
      return "high";
    case "warning":
      return "medium";
    default:
      return "low";
  }
}

function primarySpan(spans: ClippySpan[] | undefined): ClippySpan | undefined {
  if (!Array.isArray(spans) || spans.length === 0) return undefined;
  return spans.find((s) => s && s.is_primary) ?? spans[0];
}

/**
 * Parse cargo-clippy's newline-delimited JSON message stream into the generic
 * item shape. Degrades to `[]` on empty/malformed input; individual unparseable
 * lines are skipped rather than throwing the whole parse.
 */
export function parseClippy(stdout: string): Array<{
  id?: string;
  category?: string;
  severity?: string;
  path?: string;
  line_start?: number;
  line_end?: number;
  summary?: string;
  rule?: string;
}> {
  if (!stdout || stdout.trim().length === 0) return [];
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
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    let parsed: ClippyCargoLine;
    try {
      parsed = JSON.parse(line) as ClippyCargoLine;
    } catch {
      continue;
    }
    if (!parsed || parsed.reason !== "compiler-message" || !parsed.message) continue;
    const message = parsed.message;
    const level = typeof message.level === "string" ? message.level : undefined;
    // Skip non-diagnostic levels (note/help attached separately have no primary
    // span of interest); only surface error/warning diagnostics.
    if (level !== "error" && level !== "warning") continue;
    const span = primarySpan(message.spans);
    const path = typeof span?.file_name === "string" ? span.file_name : "";
    if (!path) continue;
    const lineStart = typeof span?.line_start === "number" ? span.line_start : undefined;
    const lineEnd = typeof span?.line_end === "number" ? span.line_end : undefined;
    const rule =
      message.code && typeof message.code.code === "string" && message.code.code.length > 0
        ? message.code.code
        : "clippy";
    const summary =
      typeof message.message === "string" && message.message.trim().length > 0
        ? message.message
        : rule;
    items.push({
      id: `clippy:${rule}:${path}:${lineStart ?? 0}`,
      category: "correctness",
      severity: mapClippySeverity(level),
      path,
      line_start: lineStart,
      line_end: lineEnd,
      summary,
      rule,
    });
  }
  return items;
}

/**
 * Dedicated severity adapter: route clippy's parsed items through the shared
 * generic normalizer so its output matches the exact ExternalAnalyzerResults
 * contract every other analyzer emits.
 */
export function normalizeClippyJson(stdout: string): ExternalAnalyzerResults {
  return normalizeGenericExternalResults("clippy", parseClippy(stdout));
}
