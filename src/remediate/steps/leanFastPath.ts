// A1 — the conservative lean fast path past the contract pipeline.
//
// Most remediation runs route through the heavy contract pipeline
// (goal_normalization → … → critic → judge → implementation_dag), which exists
// to reason about DESIGN correctness for complex/coupled changes: module
// contracts, seam reconciliation, an obligation ledger, and an adversarial
// critic→judge→repair loop. That is the right machinery for a tangled change —
// and overkill for a handful of concrete, already-grounded fixes.
//
// This module is the gate that decides when a run may skip that loop, plus the
// builder for the lean `extracted-plan.json` the fast path emits. The gate is
// deliberately CONSERVATIVE: it fast-paths ONLY when every simplicity signal
// holds, and defaults to the full pipeline on any doubt. That asymmetry is how
// the "a subtle change must not skip the safety net" requirement is enforced —
// a mis-classified complex change costs extra pipeline work, never a skipped
// design review.
//
// What the fast path KEEPS (the retained safety net): the produced plan rejoins
// the normal plan→implement→close machinery — deterministic grounding re-pass,
// applyPlanPipeline's block derivation + affected-file hash snapshot (integrity
// check), the implement-phase per-node verify-before-merge, and the tool-owned
// final whole-repo gate. A fast-pathed fix that breaks something fails its
// verify and routes to triage; it never silently lands.
//
// What it DROPS: only the adversarial contract design loop + obligation
// derivation — precisely the work that earns its cost on coupled/systemic
// changes the gate has already excluded.
//
// Pure + deterministic: no IO, no clock, no randomness. The caller supplies the
// plan id so this stays trivially unit-testable.

import type { Finding } from "audit-tools/shared";
import { findingIsGrounded, isRecord } from "audit-tools/shared";

/**
 * Max approved findings the lean path will take — "a handful". Above this, the
 * coordination risk of a batch warrants the full pipeline.
 */
export const MAX_FAST_PATH_FINDINGS = 5;

/**
 * Max DISTINCT affected files across the approved set. A small footprint is the
 * primary structural proxy for "no broad cross-module ripple": a shared-contract
 * change that fans out to its consumers touches many files and trips this cap,
 * routing to the pipeline where seam reconciliation belongs.
 */
export const MAX_FAST_PATH_FILES = 5;

/** Source tag stamped on a lean-fast-path extracted plan (distinguishes it from `contract_pipeline`). */
export const LEAN_FAST_PATH_SOURCE = "lean_fast_path";

export interface FastPathDecision {
  /** True only when EVERY simplicity signal holds. */
  eligible: boolean;
  /** Human-readable reason the gate fired or declined (logged for observability). */
  reason: string;
}

/** Distinct affected-file paths across an approved finding set. */
export function distinctAffectedFiles(findings: Finding[]): string[] {
  const paths = new Set<string>();
  for (const finding of findings) {
    for (const location of finding.affected_files ?? []) {
      if (location?.path) {
        paths.add(location.path);
      }
    }
  }
  return [...paths];
}

/**
 * Decide whether an APPROVED, post-filter structured-audit finding set is simple
 * enough for the lean fast path. The caller guarantees the source is structured
 * (this never runs on free-form/document/conversation intake) and that every
 * finding already cleared the review-approval gate + the pre-planning filter
 * (evidence-bearing, deduped, non-phantom-path, checkpoint-kept).
 *
 * Every check is a conservative AND: any failing signal returns ineligible with
 * the reason, so the run takes the full pipeline.
 */
export function evaluateFastPath(findings: Finding[]): FastPathDecision {
  if (findings.length === 0) {
    return { eligible: false, reason: "no approved findings to fast-path" };
  }
  if (findings.length > MAX_FAST_PATH_FINDINGS) {
    return {
      eligible: false,
      reason: `${findings.length} findings exceeds the ${MAX_FAST_PATH_FINDINGS}-finding fast-path cap`,
    };
  }

  const files = distinctAffectedFiles(findings);
  if (files.length > MAX_FAST_PATH_FILES) {
    return {
      eligible: false,
      reason: `${files.length} affected files exceeds the ${MAX_FAST_PATH_FILES}-file fast-path cap`,
    };
  }

  // Grounding: require the auditor's strong S7 verdict (cited span re-verified
  // against disk, or an executable anchor confirmed the behavior). This is the
  // protection that REPLACES the adversarial loop — a fast-pathed finding is
  // never one the auditor couldn't positively ground.
  const ungrounded = findings.filter((finding) => !findingIsGrounded(finding));
  if (ungrounded.length > 0) {
    return {
      eligible: false,
      reason: `not positively grounded: ${ungrounded.map((f) => f.id).join(", ")}`,
    };
  }

  // High confidence: a medium/low-confidence finding carries doubt the
  // adversarial loop exists to resolve. (Note: an ungrounded finding is already
  // downgraded to low confidence upstream, so this is defense in depth.)
  const belowHigh = findings.filter((finding) => finding.confidence !== "high");
  if (belowHigh.length > 0) {
    return {
      eligible: false,
      reason: `below high confidence: ${belowHigh.map((f) => f.id).join(", ")}`,
    };
  }

  // No cross-cutting / seam signal. These are the auditor's own markers that a
  // finding is architecture-level or coupled to others; the small-footprint cap
  // above is the backstop for a finding the auditor failed to mark.
  const systemic = findings.filter((finding) => finding.systemic === true);
  if (systemic.length > 0) {
    return {
      eligible: false,
      reason: `systemic / cross-cutting: ${systemic.map((f) => f.id).join(", ")}`,
    };
  }
  const coupled = findings.filter(
    (finding) => (finding.related_findings?.length ?? 0) > 0,
  );
  if (coupled.length > 0) {
    return {
      eligible: false,
      reason: `coupled to related findings (seam risk): ${coupled.map((f) => f.id).join(", ")}`,
    };
  }
  const architectural = findings.filter((finding) => finding.lens === "architecture");
  if (architectural.length > 0) {
    return {
      eligible: false,
      reason: `architecture-lens (design-level): ${architectural.map((f) => f.id).join(", ")}`,
    };
  }

  return {
    eligible: true,
    reason: `${findings.length} grounded high-confidence finding(s) across ${files.length} file(s); none systemic, coupled, or architecture-lens`,
  };
}

// ── T1 slice 3b — lean-path light adversarial review ────────────────────────────
//
// The fast path no longer SKIPS adversarial scrutiny — that would be a
// zero-scrutiny fork, and remediation legitimately catches upstream (audit)
// errors. Instead an eligible run runs ONE bounded LIGHT adversarial pass over
// the approved findings (the floor: light, never off) before the lean plan is
// trusted. A clear verdict proceeds to the lean plan; a verdict that surfaces a
// real concern escalates the run (evidence the change is harder than assessed)
// and routes it to the full contract pipeline. The verdict is a mechanical
// on-disk gate, NOT a "please self-check" instruction the host might ignore.

export const LEAN_LIGHT_REVIEW_SCHEMA_VERSION =
  "remediate-code-lean-light-review/v1alpha1" as const;

export type LeanLightReviewDisposition = "clear" | "escalate";

/**
 * Interpret a host-written light-review verdict, fail-safe toward escalation:
 * any malformed / ambiguous verdict, or an `escalate` with no stated concern,
 * routes to the full pipeline. The floor must never silently pass — when in
 * doubt, escalate (a wrong call costs extra pipeline work, never skipped review).
 */
export function interpretLeanLightReviewVerdict(raw: unknown): {
  disposition: LeanLightReviewDisposition;
  concerns: string[];
} {
  if (!isRecord(raw)) {
    return { disposition: "escalate", concerns: ["unreadable light-review verdict"] };
  }
  // Schema-version gate: a verdict that does not carry the exact expected
  // schema_version is not a trustworthy light-review emission (it may be a stale,
  // mis-shaped, or wrong-contract artifact). Fail safe toward escalation rather
  // than trusting an unversioned `clear`.
  if (raw.schema_version !== LEAN_LIGHT_REVIEW_SCHEMA_VERSION) {
    return {
      disposition: "escalate",
      concerns: [
        `light-review verdict schema_version must be "${LEAN_LIGHT_REVIEW_SCHEMA_VERSION}"`,
      ],
    };
  }
  const concerns = Array.isArray(raw.concerns)
    ? raw.concerns.filter((c): c is string => typeof c === "string")
    : [];
  if (raw.disposition === "clear") {
    return { disposition: "clear", concerns: [] };
  }
  if (raw.disposition === "escalate") {
    return {
      disposition: "escalate",
      concerns:
        concerns.length > 0
          ? concerns
          : ["light review escalated without a stated concern"],
    };
  }
  return {
    disposition: "escalate",
    concerns: ["light-review verdict missing a valid disposition"],
  };
}

/** The minimal `extracted-plan.json` shape the lean path emits. */
export interface LeanExtractedPlan {
  plan_id: string;
  findings: Finding[];
  project_type: string;
  source: typeof LEAN_FAST_PATH_SOURCE;
  candidate_closing_actions: string[];
}

/**
 * Build the lean extracted plan from the approved findings. Blocks are
 * intentionally omitted: `normalizeExtractedPlan` synthesizes one block per
 * finding and `applyPlanPipeline` then merges blocks sharing a file + splits by
 * context budget — the same deterministic block derivation the contract pipeline
 * feeds into, single-sourced rather than reimplemented here.
 */
export function buildLeanExtractedPlan(
  findings: Finding[],
  planId: string,
): LeanExtractedPlan {
  return {
    plan_id: planId,
    findings,
    project_type: "unknown",
    source: LEAN_FAST_PATH_SOURCE,
    candidate_closing_actions: ["none"],
  };
}
