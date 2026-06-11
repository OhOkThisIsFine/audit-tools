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
  { keywords: ["maintainability", "maintainability", "readability", "clean code", "debt", "technical debt", "refactor"], lens: "maintainability" },
  { keywords: ["architecture", "arch", "coupling", "cohesion", "design", "structure"], lens: "architecture" },
  { keywords: ["reliability", "resilience", "fault tolerance", "availability", "uptime"], lens: "reliability" },
  { keywords: ["performance", "perf", "latency", "throughput", "speed", "slow", "fast", "optimis", "optimiz"], lens: "performance" },
  { keywords: ["security", "auth", "authn", "authz", "injection", "xss", "csrf", "vuln", "vulnerabilit", "cve", "secret", "credential"], lens: "security" },
  { keywords: ["test", "coverage", "spec", "unit test", "integration test", "e2e"], lens: "tests" },
  { keywords: ["correctness", "bug", "bugs", "fix", "defect", "incorrect", "wrong", "broken"], lens: "correctness" },
];

/** Patterns that signal scope emphasis (focus/ignore/prioritise). */
export const SCOPE_PATTERNS: RegExp[] = [
  /\b(?:focus(?:ing)?\s+on|focused\s+on)\s+(.+)/i,
  /\b(?:prioriti[sz]e?|prioriti[sz]ing)\s+(.+)/i,
  /\b(?:ignore|ignoring|skip(?:ping)?|exclude?|excluding)\s+(.+)/i,
  /\b(?:concentrate\s+on|look\s+at|check\s+(?:only\s+)?(?:the\s+)?)\s+(.+)/i,
  /\b(?:limit(?:ed)?\s+to|restrict(?:ed)?\s+to|only\s+(?:in|within|for))\s+(.+)/i,
  // Bare "only <verb> <path>" — e.g. "only audit src/", "only review packages/"
  /^only\s+\w+\s+(\S+(?:\/\S*)?)/i,
];

/** Patterns that signal urgency / priority. */
export const PRIORITY_PATTERNS: RegExp[] = [
  /\b(?:urgent|urgently)\b/i,
  /\b(?:critical|critically)\b/i,
  /\b(?:most\s+important|top\s+priority|highest\s+priority|asap|as\s+soon\s+as\s+possible)\b/i,
  /\b(?:immediately|right\s+away|now)\b/i,
  /\b(?:high\s+priority|high-priority)\b/i,
];
