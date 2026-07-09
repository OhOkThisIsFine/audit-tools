// The `low`-risk tier's realization: the lean plan builder + the light adversarial
// review floor.
//
// Most remediation runs route through the heavy contract pipeline
// (goal_normalization → … → critic → judge → implementation_dag), which exists to
// reason about DESIGN correctness for complex/coupled changes. That is the right
// machinery for a tangled change — and overkill for a handful of concrete, already-
// grounded fixes.
//
// The decision of WHEN to skip that loop is NOT made here anymore: it is the
// self-scaling risk dial. A run takes the lean path IFF its effective risk tier is
// `low` (`src/remediate/riskSignal.ts` — the intake path/breadth/intent signal folded
// with the finding-level `findingRiskEvidence`). This module owns only the low tier's
// two mechanisms: the light adversarial review floor (`interpretLeanLightReviewVerdict`
// — `adversarialDepthForTier("low") === "light"`) and the lean `extracted-plan.json`
// builder. Folding the old standalone `evaluateFastPath` boolean into the tier killed a
// second classifier that could DISAGREE with the risk signal (a grounded 5-finding batch
// touching `src/shared/quota` was "fast-path eligible" AND risk-tier `high`, and bypassed
// the pipeline anyway).
//
// What the lean path KEEPS (the retained safety net): the produced plan rejoins the
// normal plan→implement→close machinery — deterministic grounding re-pass,
// applyPlanPipeline's block derivation + affected-file hash snapshot (integrity check),
// the implement-phase per-node verify-before-merge, and the tool-owned final whole-repo
// gate. A lean-pathed fix that breaks something fails its verify and routes to triage; it
// never silently lands. What it DROPS: only the adversarial contract DESIGN loop +
// obligation derivation — the work that earns its cost on the coupled/systemic changes the
// tier has already routed away.
//
// Pure + deterministic: no IO, no clock, no randomness. The caller supplies the plan id
// so this stays trivially unit-testable.

import type { Finding } from "audit-tools/shared";
import { isRecord } from "audit-tools/shared";

/** Source tag stamped on a lean-fast-path extracted plan (distinguishes it from `contract_pipeline`). */
export const LEAN_FAST_PATH_SOURCE = "lean_fast_path";

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
