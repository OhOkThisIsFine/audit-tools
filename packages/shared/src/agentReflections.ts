// Agent meta-audit reflections: a canonical, opt-in feedback channel shared by
// both orchestrators. Workers may append one reflection per task/item (NDJSON)
// to `agent-feedback.jsonl` in the run's artifacts dir — schema
// `schemas/agent_reflection.schema.json` (published per-package). Each
// orchestrator aggregates them into a "Process Feedback" section of its final
// report so recurring operational friction is visible without hand-reading the
// JSONL. The channel is best-effort: a malformed line is skipped, never fatal,
// and never competes with the actual audit/remediation obligation.

export type ReflectionClarity =
  | "clear"
  | "mostly_clear"
  | "ambiguous"
  | "unclear";
export type ReflectionSeverity = "info" | "low" | "medium" | "high";

export interface AgentReflection {
  task_id: string;
  lens?: string;
  instruction_clarity: ReflectionClarity;
  ambiguities?: string[];
  tool_friction?: string[];
  suggestions?: string[];
  severity: ReflectionSeverity;
}

/** Canonical worker-appended feedback file name, relative to an artifacts dir. */
export const AGENT_FEEDBACK_FILENAME = "agent-feedback.jsonl";

const CLARITY_VALUES = new Set<ReflectionClarity>([
  "clear",
  "mostly_clear",
  "ambiguous",
  "unclear",
]);
const SEVERITY_VALUES = new Set<ReflectionSeverity>([
  "info",
  "low",
  "medium",
  "high",
]);
const SEVERITY_RANK: Record<ReflectionSeverity, number> = {
  high: 3,
  medium: 2,
  low: 1,
  info: 0,
};

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/**
 * Parse NDJSON reflection text, keeping only schema-valid objects. Blank lines,
 * non-JSON lines, and objects missing the required `task_id`/`instruction_clarity`/
 * `severity` (or with out-of-enum values) are skipped silently — the channel is
 * opt-in and best-effort, so a bad reflection must never break synthesis.
 */
export function parseReflectionsNdjson(text: string): AgentReflection[] {
  const reflections: AgentReflection[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;

    const record = parsed as Record<string, unknown>;
    if (typeof record.task_id !== "string" || record.task_id.length === 0) {
      continue;
    }
    if (
      typeof record.instruction_clarity !== "string" ||
      !CLARITY_VALUES.has(record.instruction_clarity as ReflectionClarity)
    ) {
      continue;
    }
    if (
      typeof record.severity !== "string" ||
      !SEVERITY_VALUES.has(record.severity as ReflectionSeverity)
    ) {
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
  return reflections;
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
      target.set(key, Math.max(target.get(key) ?? 0, SEVERITY_RANK[severity]));
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
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
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
      `(opt-in; schema: agent_reflection.schema.json).`,
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
