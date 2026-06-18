// Deterministic review-necessity classification — the tool-owned core of the
// review-approval gate (docs/backlog.md "Review-necessity approval gate").
//
// The 2026-06-15 self-remediation reported "17/17 resolved" but underneath only
// 12 of 42 design-review (architecture) findings got a code change; 30 were
// silently auto-dispositioned ("direction recorded") inside quality-tail blocks
// and never surfaced to the user. The durable fix is to enforce, in the TOOL,
// that every finding is bucketed by how much user review it needs BEFORE it can
// reach a terminal disposition — so judgment-heavy items are presented for
// approve/disapprove rather than swept closed on host discretion.
//
// This module owns the deterministic structure: the tier each finding lands in,
// why, and a coarse implementation-cost signal. The semantic pros/cons are an
// LLM slot the gate prompt requires the host to fill — but the tool guarantees
// the item is SHOWN and tiered (tool owns structure; LLM owns judgment).

import type { Finding } from "audit-tools/shared";

/**
 * How much of the USER's judgment a finding needs before it is acted on.
 * - `strategic`  — design/architecture/cross-cutting decision; the user's call.
 *                  These are exactly the items that "flitted into the ether".
 * - `concrete`   — a real fix with some design latitude; worth a confirmation.
 * - `mechanical` — obvious, low-risk, high-confidence; FYI / rubber-stamp.
 */
export type ReviewNecessity = "strategic" | "concrete" | "mechanical";

/** Coarse, deterministic effort signal derived from blast radius. */
export type ImplementationCost = "high" | "medium" | "low";

export interface ReviewClassification {
  necessity: ReviewNecessity;
  /** Deterministic, human-readable reason this finding landed in its tier. */
  rationale: string;
  implementation_cost: ImplementationCost;
}

export interface ClassifiedFinding {
  finding: Finding;
  classification: ReviewClassification;
}

/** Most-review-needed first. Used to order tiers in the gate prompt. */
export const REVIEW_NECESSITY_ORDER: readonly ReviewNecessity[] = [
  "strategic",
  "concrete",
  "mechanical",
];

/** Short human label + what the tier means, for rendering the gate. */
export const REVIEW_NECESSITY_LABELS: Record<
  ReviewNecessity,
  { title: string; description: string }
> = {
  strategic: {
    title: "Strategic — your call",
    description:
      "Design/architecture or cross-cutting decisions. Genuine tradeoffs only you should make.",
  },
  concrete: {
    title: "Concrete — some latitude",
    description:
      "Real fixes with a clear-ish path but a design choice worth a yes/no.",
  },
  mechanical: {
    title: "Mechanical — FYI",
    description: "Obvious, low-risk, high-confidence cleanups; minimal review.",
  },
};

const HIGH_SEVERITIES = new Set(["critical", "high"]);

/**
 * Coarse implementation-cost from blast radius: systemic or wide-reaching
 * findings cost more. Deterministic — never an LLM call.
 */
function deriveImplementationCost(finding: Finding): ImplementationCost {
  const fileCount = finding.affected_files?.length ?? 0;
  if (finding.systemic === true || fileCount >= 4) return "high";
  if (fileCount >= 2) return "medium";
  return "low";
}

/**
 * Classify a single finding by how much user review it needs. Pure and
 * deterministic over the canonical `Finding` contract — the same finding always
 * lands in the same tier, so the gate can never depend on host discretion.
 *
 * Ordered rules, first match wins for the tier:
 *  1. The architecture lens IS the design-review lens — always strategic. This
 *     single rule closes the exact 2026-06-15 failure (42 architecture findings
 *     hidden in quality-tail blocks).
 *  2. A high-severity systemic (cross-cutting) issue is a direction decision,
 *     not a local fix — strategic.
 *  3. Any remaining high-severity finding is a real, bounded fix worth a
 *     confirmation — concrete.
 *  4. Informational findings need no behavior change — mechanical.
 *  5. Low-severity + high-confidence is a rote fix — mechanical.
 *  6. Everything else (medium, or low/medium-confidence) — concrete.
 */
export function classifyReviewNecessity(finding: Finding): ReviewClassification {
  const implementation_cost = deriveImplementationCost(finding);
  const severity = finding.severity;
  const isHighSeverity = HIGH_SEVERITIES.has(severity);

  if (finding.lens === "architecture") {
    return {
      necessity: "strategic",
      rationale:
        "Design-review (architecture) finding — a structural/design judgment that is your call, not a mechanical fix.",
      implementation_cost,
    };
  }

  if (finding.systemic === true && isHighSeverity) {
    return {
      necessity: "strategic",
      rationale:
        "High-severity systemic issue — cross-cutting, so acting on it is a direction decision rather than a local change.",
      implementation_cost,
    };
  }

  if (isHighSeverity) {
    return {
      necessity: "concrete",
      rationale:
        "High-impact but bounded fix — the path is clear, but its severity warrants a confirmation before acting.",
      implementation_cost,
    };
  }

  if (severity === "info") {
    return {
      necessity: "mechanical",
      rationale:
        "Informational finding — no behavior change required; surfaced for awareness.",
      implementation_cost,
    };
  }

  if (severity === "low" && finding.confidence === "high") {
    return {
      necessity: "mechanical",
      rationale:
        "Low-severity, high-confidence finding — a rote/mechanical fix needing little review.",
      implementation_cost,
    };
  }

  return {
    necessity: "concrete",
    rationale:
      "Concrete fix with some design latitude — worth a quick yes/no before acting.",
    implementation_cost,
  };
}

/**
 * Classify and group a set of findings into review-necessity tiers, preserving
 * input order within each tier. The returned record always has all three keys
 * (possibly empty), so the gate renders a stable set of buckets.
 */
export function partitionByReviewNecessity(
  findings: readonly Finding[],
): Record<ReviewNecessity, ClassifiedFinding[]> {
  const buckets: Record<ReviewNecessity, ClassifiedFinding[]> = {
    strategic: [],
    concrete: [],
    mechanical: [],
  };
  for (const finding of findings) {
    const classification = classifyReviewNecessity(finding);
    buckets[classification.necessity].push({ finding, classification });
  }
  return buckets;
}
