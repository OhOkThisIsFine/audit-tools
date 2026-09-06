// Agent meta-audit reflections: a canonical, opt-in feedback channel shared by
// both orchestrators. Workers may append one reflection per task/item (NDJSON)
// to `agent-feedback.jsonl` in the run's artifacts dir — shape single-sourced by
// `AgentReflectionSchema` below (parsed via `parseReflectionsNdjson`). Each
// orchestrator aggregates them into a "Process Feedback" section of its final
// report so recurring operational friction is visible without hand-reading the
// JSONL. The channel is best-effort: a malformed line is skipped, never fatal,
// and never competes with the actual audit/remediation obligation.

import { z } from "zod";
import { severityRank } from "./types/lens.js";
import { compareCodeUnits } from "./compareCodeUnits.js";

export const ReflectionClaritySchema = z.enum([
  "clear",
  "mostly_clear",
  "ambiguous",
  "unclear",
]);
export type ReflectionClarity = z.infer<typeof ReflectionClaritySchema>;

export const ReflectionSeveritySchema = z.enum([
  "info",
  "low",
  "medium",
  "high",
  "critical",
]);
export type ReflectionSeverity = z.infer<typeof ReflectionSeveritySchema>;

export const AgentReflectionSchema = z
  .object({
    task_id: z.string(),
    lens: z.string().optional(),
    instruction_clarity: ReflectionClaritySchema,
    ambiguities: z.array(z.string()).optional(),
    tool_friction: z.array(z.string()).optional(),
    suggestions: z.array(z.string()).optional(),
    severity: ReflectionSeveritySchema,
  })
  .strict();
export type AgentReflection = z.infer<typeof AgentReflectionSchema>;

/** Canonical worker-appended feedback file name, relative to an artifacts dir. */
export const AGENT_FEEDBACK_FILENAME = "agent-feedback.jsonl";

const CLARITY_VALUES = new Set<ReflectionClarity>(ReflectionClaritySchema.options);
const SEVERITY_VALUES = new Set<ReflectionSeverity>(ReflectionSeveritySchema.options);
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** Why one NDJSON line did not become a reflection. */
export type ReflectionDiscardReason =
  | "not_json"
  | "not_an_object"
  | "missing_task_id"
  | "missing_or_invalid_instruction_clarity"
  | "missing_or_invalid_severity";

/** One discarded line, with enough to find and fix it. */
export interface DiscardedReflection {
  /** 1-based line number within the NDJSON text. */
  line: number;
  reason: ReflectionDiscardReason;
  /** The offending line, truncated — enough to identify it, never a payload dump. */
  excerpt: string;
}

export interface ReflectionParseResult {
  reflections: AgentReflection[];
  discarded: DiscardedReflection[];
}

const DISCARD_EXCERPT_LIMIT = 200;

function excerptOf(line: string): string {
  return line.length <= DISCARD_EXCERPT_LIMIT
    ? line
    : `${line.slice(0, DISCARD_EXCERPT_LIMIT)}…`;
}

/**
 * Parse NDJSON reflection text, keeping only schema-valid objects. Blank lines,
 * non-JSON lines, and objects missing the required `task_id`/`instruction_clarity`/
 * `severity` (or with out-of-enum values) are skipped — the channel is opt-in and
 * best-effort, so a bad reflection must never break synthesis.
 *
 * SKIPPED IS NOT SILENT (owner decision, nightly key `6aebffe0c4e32e11`,
 * 2026-09-06). The skip stays: a malformed line still never reaches a consumer,
 * and this function still never throws. What changed is that the caller is now
 * TOLD, because the silence was load-bearing in a real defect — the shipped
 * `audit-code` loader prompt asked the host for a reserved capability-preflight
 * reflection and never named `instruction_clarity`, so a host that followed the
 * prompt exactly produced a line discarded whole, and the channel that decides
 * whether a run may be called comprehensive carried nothing at all. Nothing on
 * any surface said so.
 *
 * The discards are DATA, deliberately: a caller may ignore them, and none of
 * them may become a blocking obligation. In particular they must never be fed to
 * the mandatory friction triage (`collectTriageSubjects`), which would turn one
 * malformed line into a closeout an operator cannot finish.
 */
export function parseReflectionsNdjson(text: string): ReflectionParseResult {
  const reflections: AgentReflection[] = [];
  const discarded: DiscardedReflection[] = [];
  let lineNumber = 0;
  const discard = (line: string, reason: ReflectionDiscardReason): void => {
    discarded.push({ line: lineNumber, reason, excerpt: excerptOf(line) });
  };

  for (const rawLine of text.split(/\r?\n/)) {
    lineNumber += 1;
    const line = rawLine.trim();
    // A blank line is formatting, not a failed reflection — never reported.
    if (line.length === 0) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      discard(line, "not_json");
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      discard(line, "not_an_object");
      continue;
    }

    const record = parsed as Record<string, unknown>;
    if (typeof record.task_id !== "string" || record.task_id.length === 0) {
      discard(line, "missing_task_id");
      continue;
    }
    if (
      typeof record.instruction_clarity !== "string" ||
      !CLARITY_VALUES.has(record.instruction_clarity as ReflectionClarity)
    ) {
      discard(line, "missing_or_invalid_instruction_clarity");
      continue;
    }
    if (
      typeof record.severity !== "string" ||
      !SEVERITY_VALUES.has(record.severity as ReflectionSeverity)
    ) {
      discard(line, "missing_or_invalid_severity");
      continue;
    }

    const reflection: AgentReflection = {
      task_id: record.task_id,
      instruction_clarity: record.instruction_clarity as ReflectionClarity,
      severity: record.severity as ReflectionSeverity,
    };
    if (typeof record.lens === "string") reflection.lens = record.lens;
    if (isStringArray(record.ambiguities)) reflection.ambiguities = record.ambiguities;
    if (isStringArray(record.tool_friction)) reflection.tool_friction = record.tool_friction;
    if (isStringArray(record.suggestions)) reflection.suggestions = record.suggestions;
    reflections.push(reflection);
  }
  return { reflections, discarded };
}

/**
 * State a parse's discards on stderr, once, in one place.
 *
 * ONE HOME: every reader of `agent-feedback.jsonl` reports its discards through
 * this function, so the wording cannot drift between the two draws and a new
 * reader cannot quietly report nothing. Writing nothing when nothing was
 * discarded keeps a healthy run silent.
 *
 * @param discarded the parse result's discards
 * @param source a short label for where the file was read, for the operator
 */
export function reportDiscardedReflections(
  discarded: readonly DiscardedReflection[],
  source: string,
): void {
  if (discarded.length === 0) return;
  const byReason = new Map<ReflectionDiscardReason, number>();
  for (const entry of discarded) {
    byReason.set(entry.reason, (byReason.get(entry.reason) ?? 0) + 1);
  }
  const summary = [...byReason.entries()]
    .sort(([a], [b]) => compareCodeUnits(a, b))
    .map(([reason, count]) => `${reason}=${String(count)}`)
    .join(" ");
  process.stderr.write(
    `[${source}] Discarded ${String(discarded.length)} agent reflection line(s) from ` +
      `${AGENT_FEEDBACK_FILENAME} (${summary}); first at line ${String(discarded[0].line)}.\n`,
  );
}

export interface ReflectionAggregate {
  total: number;
  clarity_breakdown: Record<ReflectionClarity, number>;
  severity_breakdown: Record<ReflectionSeverity, number>;
  /** Deduped notes, highest reported impact first (ties broken alphabetically). */
  friction: string[];
  ambiguities: string[];
  suggestions: string[];
}

/**
 * Tally clarity/severity and dedupe the free-text notes across reflections,
 * ranking each distinct note by the highest severity it was reported under so the
 * most impactful friction surfaces first.
 */
export function aggregateReflections(
  reflections: AgentReflection[],
): ReflectionAggregate {
  const clarity_breakdown: Record<ReflectionClarity, number> = {
    clear: 0,
    mostly_clear: 0,
    ambiguous: 0,
    unclear: 0,
  };
  const severity_breakdown: Record<ReflectionSeverity, number> = {
    info: 0,
    low: 0,
    medium: 0,
    high: 0,
    critical: 0,
  };
  const friction = new Map<string, number>();
  const ambiguities = new Map<string, number>();
  const suggestions = new Map<string, number>();

  const collect = (
    target: Map<string, number>,
    items: string[] | undefined,
    severity: ReflectionSeverity,
  ): void => {
    for (const item of items ?? []) {
      const key = item.trim();
      if (key.length === 0) continue;
      // Canonical 1-based severity rank (shared single source); higher == more
      // severe, so the most-impactful report of a duplicate note wins.
      target.set(key, Math.max(target.get(key) ?? 0, severityRank(severity)));
    }
  };

  for (const reflection of reflections) {
    clarity_breakdown[reflection.instruction_clarity] += 1;
    severity_breakdown[reflection.severity] += 1;
    collect(friction, reflection.tool_friction, reflection.severity);
    collect(ambiguities, reflection.ambiguities, reflection.severity);
    collect(suggestions, reflection.suggestions, reflection.severity);
  }

  const rankedKeys = (target: Map<string, number>): string[] =>
    [...target.entries()]
      .sort((a, b) => b[1] - a[1] || compareCodeUnits(a[0], b[0]))
      .map(([key]) => key);

  return {
    total: reflections.length,
    clarity_breakdown,
    severity_breakdown,
    friction: rankedKeys(friction),
    ambiguities: rankedKeys(ambiguities),
    suggestions: rankedKeys(suggestions),
  };
}

function formatCounts(counts: Record<string, number>): string {
  const parts = Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([key, count]) => `${key}: ${count}`);
  return parts.length > 0 ? parts.join(", ") : "none";
}

/**
 * Render the "## Process Feedback" section. Returns `[]` when there are no
 * reflections so the report omits the section entirely.
 */
export function renderProcessFeedbackSection(
  reflections: AgentReflection[],
): string[] {
  if (reflections.length === 0) return [];

  const aggregate = aggregateReflections(reflections);
  const lines: string[] = [
    "## Process Feedback",
    "",
    `Aggregated from ${aggregate.total} agent reflection(s) appended during the run ` +
      `(opt-in agent-feedback.jsonl channel).`,
    "",
    `- Instruction clarity: ${formatCounts(aggregate.clarity_breakdown)}`,
    `- Reported impact: ${formatCounts(aggregate.severity_breakdown)}`,
    "",
  ];

  const block = (title: string, items: string[]): void => {
    if (items.length === 0) return;
    lines.push(`### ${title}`, "");
    for (const item of items) lines.push(`- ${item}`);
    lines.push("");
  };

  block("Tool & instruction friction", aggregate.friction);
  block("Ambiguities", aggregate.ambiguities);
  block("Suggestions", aggregate.suggestions);

  return lines;
}
