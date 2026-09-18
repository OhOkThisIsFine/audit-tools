// sites-pinned: tests/remediate/reviewGate.test.ts, tests/remediate/next-step-review-gate.test.ts
// Review-approval gate engine — builds the tiered item-set the user
// approves or declines, and consumes their verdict.
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
// the host fills only the semantic pros/cons slots when presenting. Declined
// items become a RECORDED terminal disposition, never a silent close.

import { z } from "zod";
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

/**
 * The user's verdict (`review_resolution.json`). Strict at every level: the
 * gate's default is APPROVE, so a field the tool does not read (a mistyped
 * name, the retired `disapproved_*` names) would turn the user's decline into
 * an approval in silence. An unknown field refuses the whole file instead.
 */
const ReviewResolutionSchema = z
  .object({
    plan_id: z.string().optional(),
    /** Findings the user declined — do NOT act on these. */
    declined_findings: z
      .array(
        z
          .object({
            finding_id: z.string(),
            /** The user's reason, in their words. Blank reads as absent. */
            reason: z.string().optional(),
          })
          .strict(),
      )
      .optional(),
    /** Whole tiers the user declined (e.g. "decline everything strategic"). */
    declined_tiers: z.array(z.string()).optional(),
  })
  .strict();

export type ReviewResolution = z.infer<typeof ReviewResolutionSchema>;

/** The retired field names, each with the field that replaced it. */
const RETIRED_RESOLUTION_FIELDS: Record<string, string> = {
  disapproved_findings:
    '`declined_findings`, whose entries are `{ "finding_id": "<id>", "reason": "<optional>" }`',
  disapproved_tiers: "`declined_tiers`",
};

export type ParsedReviewResolution =
  | { kind: "ok"; resolution: ReviewResolution }
  /** A resolution from another run (its `plan_id` names a different request). */
  | { kind: "stale" }
  | { kind: "refused"; reason: string };

export interface ReviewDecision {
  /** Finding ids approved to proceed to implementation. */
  approved_ids: string[];
  /** Declined items, each with the recorded reason for its terminal disposition. */
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
 * Whether `resolution` answers THIS `request` (INV-RSM-RESOLUTION-CORRELATE).
 * An absent resolution or an absent `plan_id` correlates (host-lenient: the
 * single-run common case writes no plan_id); a PRESENT plan_id that differs
 * from the request's marks a stale leftover from another run — the caller must
 * archive it and re-halt rather than apply a cross-run answer.
 */
function isResolutionForRequest(
  request: ReviewRequest,
  resolution: { plan_id?: unknown } | null | undefined,
): boolean {
  const resolutionPlanId = resolution?.plan_id;
  if (resolutionPlanId === undefined) return true;
  return resolutionPlanId === request.plan_id;
}

/**
 * The id references a resolution names outside the request (uniform id-join
 * contract): every `declined_findings` id must name an item in the request,
 * and every `declined_tiers` entry must be one of the closed review-necessity
 * names. A tier that is valid but empty in this request stays a harmless no-op
 * (it names a real vocabulary member, not a phantom item).
 */
function unknownResolutionIds(
  request: ReviewRequest,
  resolution: ReviewResolution,
): string[] {
  const validIds = request.tiers.flatMap((t) => t.items.map((i) => i.finding_id));
  const validIdSet = new Set(validIds);
  const validTiers = new Set<string>(REVIEW_NECESSITY_ORDER);
  const problems: string[] = [];
  (resolution.declined_findings ?? []).forEach((entry, index) => {
    if (!validIdSet.has(entry.finding_id)) {
      problems.push(
        `\`declined_findings[${index}].finding_id\`: \`${entry.finding_id}\` is not in the request (valid: ${validIds.map((i) => `\`${i}\``).join(", ")})`,
      );
    }
  });
  (resolution.declined_tiers ?? []).forEach((tier, index) => {
    if (!validTiers.has(tier)) {
      problems.push(
        `\`declined_tiers[${index}]\`: \`${tier}\` is not a tier (valid: ${REVIEW_NECESSITY_ORDER.map((t) => `\`${t}\``).join(", ")})`,
      );
    }
  });
  return problems;
}

/**
 * Read the text of `review_resolution.json` against the request it answers.
 * The WHOLE file is refused — never partly applied — when it is not valid
 * JSON, has a field the schema does not name (the retired `disapproved_*`
 * names get their replacement stated), has a wrong type, or names an id or a
 * tier outside the request. The reason names each problem. A file whose
 * `plan_id` names a different request is `stale`: it answers another run.
 */
export function parseReviewResolution(
  text: string,
  request: ReviewRequest,
): ParsedReviewResolution {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return {
      kind: "refused",
      reason: `the file is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      kind: "refused",
      reason: 'the file must be one JSON object: `{ "declined_findings": [...], "declined_tiers": [...] }`',
    };
  }
  const planId = (value as { plan_id?: unknown }).plan_id;
  if (typeof planId === "string" && planId !== request.plan_id) return { kind: "stale" };
  const problems: string[] = [];
  for (const [retired, replacement] of Object.entries(RETIRED_RESOLUTION_FIELDS)) {
    if (retired in value) {
      problems.push(`\`${retired}\` is not a field — write ${replacement}`);
    }
  }
  const parsed = ReviewResolutionSchema.safeParse(value);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      if (issue.code === z.ZodIssueCode.unrecognized_keys) {
        const unknown = issue.keys.filter((k) => !(k in RETIRED_RESOLUTION_FIELDS));
        const where = issue.path.length > 0 ? ` in \`${issue.path.join(".")}\`` : "";
        if (unknown.length > 0) {
          problems.push(
            `unknown field(s)${where}: ${unknown.map((k) => `\`${k}\``).join(", ")}`,
          );
        }
        continue;
      }
      const field = issue.path.length > 0 ? `\`${issue.path.join(".")}\`: ` : "";
      problems.push(`${field}${issue.message}`);
    }
  } else {
    problems.push(...unknownResolutionIds(request, parsed.data));
  }
  return problems.length > 0 || !parsed.success
    ? { kind: "refused", reason: problems.join("; ") }
    : { kind: "ok", resolution: parsed.data };
}

/**
 * Apply the user's resolution to a request: every item is either approved (act
 * on it) or declined (recorded terminal disposition with a reason). An item is
 * declined if its id is in `declined_findings` OR its tier is in
 * `declined_tiers`. Everything else is approved — the default is to act,
 * because the gate's job is to let the user REMOVE items, not to require
 * opting every item in. An absent/empty resolution approves everything.
 *
 * The resolution must come from {@link parseReviewResolution}; a stale
 * `plan_id` or an unknown id still throws here as the mechanical backstop
 * (INV-RSM-RESOLUTION-CORRELATE, COR-0b906e37), never the primary UX.
 *
 * Crucially, declined items are returned with an explicit reason — the user's
 * own words when they gave one — so the caller records a terminal disposition
 * (e.g. `ignored`) rather than silently closing them, the exact failure this
 * gate exists to prevent.
 */
export function applyReviewResolution(
  request: ReviewRequest,
  resolution: ReviewResolution | undefined,
): ReviewDecision {
  if (!isResolutionForRequest(request, resolution)) {
    throw new Error(
      `review resolution plan_id "${resolution?.plan_id}" does not answer review request plan_id "${request.plan_id}" — stale cross-run resolution rejected (INV-RSM-RESOLUTION-CORRELATE).`,
    );
  }
  const unknown = resolution ? unknownResolutionIds(request, resolution) : [];
  if (unknown.length > 0) {
    throw new Error(`review resolution refused — ${unknown.join("; ")}`);
  }
  const userReasons = new Map<string, string | undefined>(
    (resolution?.declined_findings ?? []).map((d) => [d.finding_id, d.reason?.trim() || undefined]),
  );
  const declinedTiers = new Set<string>(resolution?.declined_tiers ?? []);
  const approved_ids: string[] = [];
  const declined: ReviewDecision["declined"] = [];

  for (const tier of request.tiers) {
    const tierDeclined = declinedTiers.has(tier.necessity);
    for (const item of tier.items) {
      const userReason = userReasons.get(item.finding_id);
      if (userReason !== undefined) {
        declined.push({
          finding_id: item.finding_id,
          reason: `Declined by the user at the review gate: ${userReason}`,
        });
      } else if (tierDeclined) {
        declined.push({
          finding_id: item.finding_id,
          reason: `Declined by the user at the review gate — declined the entire "${item.necessity}" tier.`,
        });
      } else if (userReasons.has(item.finding_id)) {
        declined.push({
          finding_id: item.finding_id,
          reason: `Declined by the user at the review gate (review-necessity: ${item.necessity}).`,
        });
      } else {
        approved_ids.push(item.finding_id);
      }
    }
  }
  return { approved_ids, declined };
}
