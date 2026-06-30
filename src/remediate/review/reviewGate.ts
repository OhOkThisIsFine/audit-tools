// Review-approval gate engine — builds the tiered item-set the user
// approves/disapproves, and consumes their verdict.
//
// This is the single review surface for both paths. It replaced the classic
// per-block implementation-risk preview, which fired AFTER the contract pipeline
// collapsed the N original findings into M implementation-DAG nodes: the
// block-level preview showed M node "findings" while the individual design-review
// / free-form findings bundled inside a quality-tail node were never surfaced —
// they got bulk-dispositioned ("direction recorded") inside the node's worker,
// invisibly (the 2026-06-15 failure this gate exists to prevent). This engine
// instead operates BEFORE that collapse: Path A gates the original findings at
// intake; Path B gates the deduped/grounded node findings at the planning point.
// Every judgment-heavy item is presented for an explicit decision before the
// pipeline can mark it terminal-without-change.
//
// Tool owns the structure (tiering, rationale, cost, which items must be shown);
// the host fills only the semantic pros/cons slots when presenting. Disapproved
// items become a RECORDED terminal disposition, never a silent close.

import type { Finding, FindingSeverity, FindingConfidence } from "audit-tools/shared";
import {
  type ReviewNecessity,
  type ImplementationCost,
  classifyReviewNecessity,
  partitionByReviewNecessity,
  REVIEW_NECESSITY_ORDER,
  REVIEW_NECESSITY_LABELS,
} from "./reviewNecessity.js";

export const REVIEW_REQUEST_SCHEMA_VERSION = "remediate-code-review-request/v1" as const;

/** One reviewable item, with the tool-owned deterministic fields populated. */
export interface ReviewItemEntry {
  finding_id: string;
  title: string;
  severity: FindingSeverity;
  confidence: FindingConfidence;
  lens: string;
  summary: string;
  affected_files: string[];
  necessity: ReviewNecessity;
  /** Deterministic reason this item landed in its tier. */
  rationale: string;
  implementation_cost: ImplementationCost;
}

/** A review-necessity tier with its items (most-review-needed tiers first). */
export interface ReviewTierGroup {
  necessity: ReviewNecessity;
  label: string;
  description: string;
  items: ReviewItemEntry[];
}

/** The halt artifact presented to the user (`review_request.json`). */
export interface ReviewRequest {
  schema_version: typeof REVIEW_REQUEST_SCHEMA_VERSION;
  plan_id: string;
  total: number;
  counts: Record<ReviewNecessity, number>;
  /** Non-empty tiers only, ordered most-review-needed first. */
  tiers: ReviewTierGroup[];
}

/** The user's verdict (`review_resolution.json`). */
export interface ReviewResolution {
  plan_id?: string;
  /** Finding ids the user disapproved — do NOT act on these. */
  disapproved_findings?: string[];
  /** Whole tiers the user disapproved (e.g. "decline everything strategic"). */
  disapproved_tiers?: ReviewNecessity[];
}

export interface ReviewDecision {
  /** Finding ids approved to proceed to implementation. */
  approved_ids: string[];
  /** Disapproved items, each with the recorded reason for its terminal disposition. */
  declined: Array<{ finding_id: string; reason: string }>;
}

function firstPath(finding: Finding): string[] {
  return (finding.affected_files ?? []).map((f) => f.path).filter(Boolean);
}

function toEntry(finding: Finding): ReviewItemEntry {
  const classification = classifyReviewNecessity(finding);
  return {
    finding_id: finding.id,
    title: finding.title,
    severity: finding.severity,
    confidence: finding.confidence,
    lens: finding.lens,
    summary: finding.summary,
    affected_files: firstPath(finding),
    necessity: classification.necessity,
    rationale: classification.rationale,
    implementation_cost: classification.implementation_cost,
  };
}

/**
 * Build the tiered review request from a finding set. Deterministic: the same
 * findings always produce the same tiers/entries. Empty tiers are omitted, but
 * `counts` always carries all three keys so the caller can report the full
 * distribution.
 */
export function buildReviewRequest(
  findings: readonly Finding[],
  planId: string,
): ReviewRequest {
  const buckets = partitionByReviewNecessity(findings);
  const counts: Record<ReviewNecessity, number> = {
    strategic: buckets.strategic.length,
    concrete: buckets.concrete.length,
    mechanical: buckets.mechanical.length,
  };
  const tiers: ReviewTierGroup[] = [];
  for (const necessity of REVIEW_NECESSITY_ORDER) {
    const classified = buckets[necessity];
    if (classified.length === 0) continue;
    tiers.push({
      necessity,
      label: REVIEW_NECESSITY_LABELS[necessity].title,
      description: REVIEW_NECESSITY_LABELS[necessity].description,
      items: classified.map((c) => toEntry(c.finding)),
    });
  }
  return {
    schema_version: REVIEW_REQUEST_SCHEMA_VERSION,
    plan_id: planId,
    total: findings.length,
    counts,
    tiers,
  };
}

/**
 * Apply the user's resolution to a request: every item is either approved (act
 * on it) or declined (recorded terminal disposition with a reason). An item is
 * declined if its id is in `disapproved_findings` OR its tier is in
 * `disapproved_tiers`. Everything else is approved — the default is to act,
 * because the gate's job is to let the user REMOVE items, not to require
 * opting every item in. An absent/empty resolution approves everything.
 *
 * Crucially, declined items are returned with an explicit reason so the caller
 * records a terminal disposition (e.g. `ignored`) rather than silently closing
 * them — the exact failure this gate exists to prevent.
 */
export function applyReviewResolution(
  request: ReviewRequest,
  resolution: ReviewResolution | null | undefined,
): ReviewDecision {
  const disapprovedIds = new Set(resolution?.disapproved_findings ?? []);
  const disapprovedTiers = new Set<ReviewNecessity>(resolution?.disapproved_tiers ?? []);
  const approved_ids: string[] = [];
  const declined: ReviewDecision["declined"] = [];

  for (const tier of request.tiers) {
    const tierDisapproved = disapprovedTiers.has(tier.necessity);
    for (const item of tier.items) {
      if (tierDisapproved) {
        declined.push({
          finding_id: item.finding_id,
          reason: `Disapproved by the user at the review gate — declined the entire "${item.necessity}" tier.`,
        });
      } else if (disapprovedIds.has(item.finding_id)) {
        declined.push({
          finding_id: item.finding_id,
          reason: `Disapproved by the user at the review gate (review-necessity: ${item.necessity}).`,
        });
      } else {
        approved_ids.push(item.finding_id);
      }
    }
  }
  return { approved_ids, declined };
}
