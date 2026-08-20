/**
 * Shared keyword maps and patterns used by both the free-form intent
 * interpreter and the per-clause intent interpreter. Single-sourced here
 * so both modules stay in sync without duplication.
 */

import type { Lens } from "../types/lens.js";

/** Maps normalised keyword fragments → Lens. Longer/more-specific entries first. */
export const LENS_KEYWORD_MAP: Array<{ keywords: string[]; lens: Lens }> = [
  { keywords: ["config_deployment", "config deployment", "deployment", "deploy", "config"], lens: "config_deployment" },
  { keywords: ["data_integrity", "data integrity", "data quality", "integrity"], lens: "data_integrity" },
  { keywords: ["observability", "logging", "monitoring", "tracing", "metrics", "logs"], lens: "observability" },
  { keywords: ["operability", "ops", "runbook", "runbooks", "operations"], lens: "operability" },
  { keywords: ["maintainability", "readability", "clean code", "debt", "technical debt", "refactor"], lens: "maintainability" },
  { keywords: ["architecture", "arch", "coupling", "cohesion", "design", "structure"], lens: "architecture" },
  { keywords: ["reliability", "resilience", "fault tolerance", "availability", "uptime"], lens: "reliability" },
  { keywords: ["performance", "perf", "latency", "throughput", "speed", "slow", "fast", "optimis", "optimiz"], lens: "performance" },
  { keywords: ["security", "auth", "authn", "authz", "injection", "xss", "csrf", "vuln", "vulnerabilit", "cve", "secret", "credential"], lens: "security" },
  { keywords: ["test", "coverage", "spec", "unit test", "integration test", "e2e"], lens: "tests" },
  { keywords: ["correctness", "bug", "bugs", "fix", "defect", "incorrect", "wrong", "broken"], lens: "correctness" },
];

/**
 * A scope-emphasis clause's polarity: does the user want this scope IN focus
 * ("focus on X", "only audit X") or OUT of it ("ignore X", "skip X")? Consumers
 * that boost/deboost by scope match (e.g. intentOrdering.ts) must never conflate
 * the two (COR-a0648a7d / COR-a0648a7d-2) — the sign convention is exactly
 * inverted, or ignored, when the lead-in verb's polarity is discarded.
 */
export type ScopePolarity = "include" | "exclude";

interface ScopePatternEntry {
  pattern: RegExp;
  polarity: ScopePolarity;
}

/**
 * Single-sourced scope-emphasis pattern set, each entry tagged with its
 * polarity. `SCOPE_PATTERNS` below is DERIVED from this array (same regexes,
 * same order) so a polarity-blind caller (clauseInterpreter.ts's "is this a
 * scope clause at all" check) and a polarity-aware caller (freeFormIntentInterpreter.ts's
 * `scopeClausePolarity`) can never drift on which clauses count as scope
 * emphasis — there is exactly one list of patterns, not two kept in lockstep.
 */
const SCOPE_PATTERN_ENTRIES: ScopePatternEntry[] = [
  { pattern: /\b(?:focus(?:ing)?\s+on|focused\s+on)\s+(.+)/i, polarity: "include" },
  { pattern: /\b(?:prioriti[sz]e?|prioriti[sz]ing)\s+(.+)/i, polarity: "include" },
  { pattern: /\b(?:ignore|ignoring|skip(?:ping)?|exclude?|excluding)\s+(.+)/i, polarity: "exclude" },
  { pattern: /\b(?:concentrate\s+on|look\s+at|check\s+(?:only\s+)?(?:the\s+)?)\s+(.+)/i, polarity: "include" },
  { pattern: /\b(?:limit(?:ed)?\s+to|restrict(?:ed)?\s+to|only\s+(?:in|within|for))\s+(.+)/i, polarity: "include" },
  // Bare "only <verb> <path>" — e.g. "only audit src/", "only review packages/"
  { pattern: /^only\s+\w+\s+(\S+(?:\/\S*)?)/i, polarity: "include" },
];

/** Patterns that signal scope emphasis (focus/ignore/prioritise) — the
 * polarity-blind view existing callers (clauseInterpreter.ts) consume, derived
 * from {@link SCOPE_PATTERN_ENTRIES} so it can never diverge from the
 * polarity-tagged set below. */
export const SCOPE_PATTERNS: RegExp[] = SCOPE_PATTERN_ENTRIES.map((e) => e.pattern);

/**
 * The polarity of the FIRST scope-emphasis pattern a clause matches, or `null`
 * when the clause matches none (mirrors the match order `SCOPE_PATTERNS` itself
 * is scanned in, so polarity and match-detection can never disagree on which
 * pattern "won").
 */
export function scopeClausePolarity(clause: string): ScopePolarity | null {
  for (const entry of SCOPE_PATTERN_ENTRIES) {
    if (entry.pattern.test(clause)) return entry.polarity;
  }
  return null;
}

/** Patterns that signal urgency / priority. */
export const PRIORITY_PATTERNS: RegExp[] = [
  /\b(?:urgent|urgently)\b/i,
  /\b(?:critical|critically)\b/i,
  /\b(?:most\s+important|top\s+priority|highest\s+priority|asap|as\s+soon\s+as\s+possible)\b/i,
  /\b(?:immediately|right\s+away|now)\b/i,
  /\b(?:high\s+priority|high-priority)\b/i,
];
