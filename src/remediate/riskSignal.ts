/**
 * Slice 2 of the self-scaling remediation pipeline (design of record:
 * `spec/self-scaling-pipeline-design.md`): the ONE shared risk/complexity signal
 * that BOTH self-scaling dials (adversarial depth, phase granularity) will read.
 *
 * This module only *produces and carries* the signal. The dials that consume it
 * (Slices 3 and 4) are not wired yet, so computing the signal changes no pipeline
 * behavior today — it establishes the single source the dials will key on.
 *
 * Hard constraints (from the spec):
 *   - Computed CHEAPLY at intake from data available at the routing point only:
 *     affected-files + a deterministic, configurable path-risk pattern set + the
 *     run intent (goals). It must NOT depend on any pipeline-internal output (the
 *     lap-3 circularity — `changeClassification` consumes finalized contracts that
 *     do not exist at the routing point; a routing signal cannot be a pipeline
 *     output).
 *   - Fail-CLOSED: anything unevaluable rounds toward MORE scrutiny, never less.
 *   - Re-assessable as the run produces evidence (escalate-on-evidence), and the
 *     re-assessment may only RAISE the tier, never lower it.
 */

import { readOptionalJsonFile, writeJsonFile } from "audit-tools/shared";
import { intakePaths } from "./intake.js";

export const INTAKE_RISK_SIGNAL_SCHEMA_VERSION =
  "remediate-code-intake-risk-signal/v1alpha1" as const;

/**
 * Ordered risk tiers. The two dials map onto this:
 *   - depth dial:       low → inline light self-check; high → full independent passes
 *   - granularity dial: low → coarse / collapsed round-trips; high → fine-grained
 * The floor is `low`, never "off" — nothing reaches zero adversarial scrutiny.
 */
export type RiskTier = "low" | "medium" | "high";

const TIER_RANK: Record<RiskTier, number> = { low: 0, medium: 1, high: 2 };

/** Numeric rank for ordering / comparison. */
export function riskTierRank(tier: RiskTier): number {
  return TIER_RANK[tier];
}

/** The higher (more scrutiny) of two tiers. Fail-closed combinator. */
export function maxRiskTier(a: RiskTier, b: RiskTier): RiskTier {
  return TIER_RANK[a] >= TIER_RANK[b] ? a : b;
}

/** A single deterministic path-risk family: a repo path family that warrants scrutiny. */
export interface PathRiskPattern {
  /** Stable label, surfaced in the rationale (e.g. "concurrency"). */
  label: string;
  /** Matched against the normalized (forward-slash) repo-relative path. */
  pattern: RegExp;
}

/**
 * Default deterministic path-risk pattern set. These are the subsystems where a
 * change is correctness-sensitive (the spec's "concurrency / dispatch / merge /
 * state / quota / shared-core = risky"). Configurable: callers may pass their own
 * set via {@link RiskSignalConfig.pathRiskPatterns}.
 *
 * Patterns are intentionally broad — fail-closed means a false "risky" match only
 * costs extra scrutiny, never silently under-scrutinizes.
 */
export const DEFAULT_PATH_RISK_PATTERNS: readonly PathRiskPattern[] = [
  { label: "concurrency", pattern: /(^|\/)(concurrency|scheduler|wave|lock|mutex|atomic)/i },
  { label: "dispatch", pattern: /(^|\/)dispatch/i },
  { label: "merge", pattern: /(^|\/)(merge|cherry|rebase|worktree)/i },
  { label: "state", pattern: /(^|\/)(state|store|ledger|persistence)/i },
  { label: "quota", pattern: /(^|\/)quota/i },
  { label: "shared-core", pattern: /(^|\/)(src\/)?shared(\/|$)/i },
];

/**
 * Default intent-risk keywords. A goal/brief mentioning one of these signals
 * inherently risky work regardless of which files are touched (e.g. a security or
 * concurrency goal). Matched case-insensitively against the goals text.
 */
export const DEFAULT_INTENT_RISK_KEYWORDS: readonly string[] = [
  "concurren",
  "race",
  "deadlock",
  "lock",
  "security",
  "vulnerab",
  "auth",
  "migration",
  "migrate",
  "schema change",
  "breaking",
  "backward",
  "data loss",
  "data-loss",
  "corrupt",
];

/** File-count thresholds (inclusive lower bounds) that bump the tier. Configurable. */
export interface RiskSignalConfig {
  pathRiskPatterns?: readonly PathRiskPattern[];
  intentRiskKeywords?: readonly string[];
  /** affected-file count at/above which the tier is at least `medium`. */
  mediumFileCount?: number;
  /** affected-file count at/above which the tier is at least `high`. */
  highFileCount?: number;
}

const DEFAULT_MEDIUM_FILE_COUNT = 6;
const DEFAULT_HIGH_FILE_COUNT = 15;

export interface IntakeRiskSignalInputs {
  /** Distinct affected-file count considered. */
  file_count: number;
  /** Path-risk family labels that matched at least one affected file. */
  matched_path_risks: string[];
  /** Intent-risk keywords that matched the goals text. */
  matched_intent_risks: string[];
}

export interface IntakeRiskSignal {
  schema_version: typeof INTAKE_RISK_SIGNAL_SCHEMA_VERSION;
  tier: RiskTier;
  /** Human-readable reasons the tier landed where it did (ordered, append-only on escalation). */
  rationale: string[];
  inputs: IntakeRiskSignalInputs;
  /**
   * Whether this signal has been raised by escalate-on-evidence since intake.
   * Lets a reader tell an intake assessment apart from an evidence-raised one.
   */
  escalated: boolean;
}

/** Normalize a path for pattern matching: forward slashes, no leading `./`. */
function normalizePathForMatch(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

export interface ComputeIntakeRiskInput {
  /** Best-available affected-file list at intake (repo-relative paths). */
  affectedFiles: readonly string[];
  /** Run intent — the intake goals (and any brief text the caller folds in). */
  goals: readonly string[];
  config?: RiskSignalConfig;
}

/**
 * Compute the shared intake risk/complexity signal. Pure + deterministic; uses
 * only intake-available data. Fail-closed: an unevaluable input (no files AND no
 * goals to assess) rounds up to `high`.
 */
export function computeIntakeRiskSignal(
  input: ComputeIntakeRiskInput,
): IntakeRiskSignal {
  const pathPatterns = input.config?.pathRiskPatterns ?? DEFAULT_PATH_RISK_PATTERNS;
  const intentKeywords =
    input.config?.intentRiskKeywords ?? DEFAULT_INTENT_RISK_KEYWORDS;
  const mediumFileCount =
    input.config?.mediumFileCount ?? DEFAULT_MEDIUM_FILE_COUNT;
  const highFileCount = input.config?.highFileCount ?? DEFAULT_HIGH_FILE_COUNT;

  const distinctFiles = Array.from(
    new Set(input.affectedFiles.map(normalizePathForMatch).filter((p) => p.length > 0)),
  );
  const fileCount = distinctFiles.length;

  const matchedPathRisks: string[] = [];
  for (const family of pathPatterns) {
    if (distinctFiles.some((p) => family.pattern.test(p))) {
      matchedPathRisks.push(family.label);
    }
  }

  const goalsText = input.goals.join("\n").toLowerCase();
  const matchedIntentRisks = intentKeywords.filter((kw) =>
    goalsText.includes(kw.toLowerCase()),
  );

  let tier: RiskTier = "low";
  const rationale: string[] = [];

  // Fail-closed: nothing to assess at all ⇒ assume the worst.
  if (fileCount === 0 && input.goals.length === 0) {
    return {
      schema_version: INTAKE_RISK_SIGNAL_SCHEMA_VERSION,
      tier: "high",
      rationale: [
        "no affected files and no goals to assess — failing closed to high scrutiny",
      ],
      inputs: { file_count: 0, matched_path_risks: [], matched_intent_risks: [] },
      escalated: false,
    };
  }

  // Path-risk match ⇒ a correctness-sensitive subsystem is in scope ⇒ deep.
  if (matchedPathRisks.length > 0) {
    tier = maxRiskTier(tier, "high");
    rationale.push(
      `affected files touch risk subsystems: ${matchedPathRisks.join(", ")}`,
    );
  }

  // Intent-risk keyword ⇒ inherently risky work ⇒ at least medium.
  if (matchedIntentRisks.length > 0) {
    tier = maxRiskTier(tier, "medium");
    rationale.push(`intent mentions risk signals: ${matchedIntentRisks.join(", ")}`);
  }

  // Breadth: more files in scope ⇒ more complexity to isolate.
  if (fileCount >= highFileCount) {
    tier = maxRiskTier(tier, "high");
    rationale.push(`${fileCount} affected files (>= ${highFileCount}) — broad change`);
  } else if (fileCount >= mediumFileCount) {
    tier = maxRiskTier(tier, "medium");
    rationale.push(`${fileCount} affected files (>= ${mediumFileCount})`);
  }

  if (rationale.length === 0) {
    rationale.push(
      `localized, low-risk change (${fileCount} file(s), no risk-subsystem or intent match)`,
    );
  }

  return {
    schema_version: INTAKE_RISK_SIGNAL_SCHEMA_VERSION,
    tier,
    rationale,
    inputs: {
      file_count: fileCount,
      matched_path_risks: matchedPathRisks,
      matched_intent_risks: matchedIntentRisks,
    },
    escalated: false,
  };
}

/** Evidence that may raise the run's risk tier as the pipeline produces it. */
export interface RiskEscalationEvidence {
  /** The tier this evidence justifies (the signal is raised to at least this). */
  tier: RiskTier;
  /** Why — appended to the signal's rationale (e.g. "decomposition surfaced a cross-module seam"). */
  reason: string;
}

/**
 * Escalate-on-evidence: re-assess the signal as the run produces evidence the
 * work is harder than the intake assessment assumed (a cross-module seam, a light
 * self-check flag, a verify failure). May only RAISE the tier — a wrong call can
 * cost extra scrutiny, never silently relax it. Returns the same object reference
 * unchanged when the evidence does not raise the tier (no spurious rewrite).
 */
export function escalateRiskSignal(
  current: IntakeRiskSignal,
  evidence: RiskEscalationEvidence,
): IntakeRiskSignal {
  const raised = maxRiskTier(current.tier, evidence.tier);
  if (raised === current.tier) {
    return current;
  }
  return {
    ...current,
    tier: raised,
    escalated: true,
    rationale: [...current.rationale, `escalated to ${raised}: ${evidence.reason}`],
  };
}

/** Read the persisted intake risk signal, or undefined when none is recorded. */
export async function readIntakeRiskSignal(
  artifactsDir: string,
): Promise<IntakeRiskSignal | undefined> {
  return readOptionalJsonFile<IntakeRiskSignal>(intakePaths(artifactsDir).riskSignal);
}

/** Persist (overwrite) the intake risk signal. */
export async function writeIntakeRiskSignal(
  artifactsDir: string,
  signal: IntakeRiskSignal,
): Promise<void> {
  await writeJsonFile(intakePaths(artifactsDir).riskSignal, signal);
}

/**
 * Compute-and-persist the intake risk signal the FIRST time only. Idempotent
 * across the many `next-step` calls of a run: once recorded it is never
 * recomputed, so an escalate-on-evidence raise (which rewrites the file with a
 * higher tier) is never clobbered by a later intake-only recompute. Returns the
 * effective signal (existing or freshly computed).
 *
 * The inputs are supplied by a lazy provider so any cost of gathering them (e.g.
 * reading the audit report to union per-finding affected files) is paid only on
 * the single run that actually computes, never on every subsequent next-step.
 */
export async function ensureIntakeRiskSignal(
  artifactsDir: string,
  resolveInput: () => ComputeIntakeRiskInput | Promise<ComputeIntakeRiskInput>,
): Promise<IntakeRiskSignal> {
  const existing = await readIntakeRiskSignal(artifactsDir);
  if (existing) {
    return existing;
  }
  const signal = computeIntakeRiskSignal(await resolveInput());
  await writeIntakeRiskSignal(artifactsDir, signal);
  return signal;
}
