// sites-pinned: tests/shared/fanout-review-mode-and-demand.test.ts, tests/shared/lane-demand.test.ts
import { z } from "zod";

import { compareCodeUnits } from "../compareCodeUnits.js";

export const StepStatusSchema = z.enum(["ready", "blocked", "complete"]);
export type StepStatus = z.infer<typeof StepStatusSchema>;

// <!-- comment-symbol-exempt: names deliberately-retired symbols; this block records that history -->
// ── The emitted-lane DEMAND RANKING ─────────────────────────────────────────
//
// Every lane a step contract emits — an audit review task, a remediation work
// block — states the same three facts about the work it names: how BIG it is,
// how much JUDGMENT it needs, and how much is RIDING on it. The host reads them
// to match a backend and a model to the work; the tool never does, because
// backend/model/quota identity is a host concern and does not exist in this
// package (see CLAUDE.md, "No execution inventory in this package").
//
// The vocabulary is CLOSED and lives here for both draws. It previously existed
// on the audit side alone, as two inline helpers in `semanticReviewStep.ts`
// (`taskComplexity`, and `risk` silently aliased to `priority`), while the
// remediate draw emitted a bare `token_estimate` and nothing else — so the same
// question got two answers, and one draw did not answer it at all.
//
// It NAMES DEMAND ONLY. There is deliberately no `model`, `provider`, `tier`,
// `backend`, `lane` or `agent` field, and there must never be one: a lane that
// names a backend has moved execution selection into the tool, which is the
// architecture this package exists downstream of. The refusal is mechanical —
// `tests/shared/lane-demand.test.ts` scans this module's schema and the emitted
// lane key sets and fails on any provider-shaped key.

/** How big the lane's content is, by the emitted `token_estimate` and file count. */
export const LANE_SIZE_VALUES = ["small", "medium", "large"] as const;

/** How much judgment the lane's work needs. */
export const LANE_COMPLEXITY_VALUES = ["focused", "standard", "deep"] as const;

/** How much is riding on the lane landing correctly. */
export const LANE_RISK_VALUES = ["low", "medium", "high"] as const;

/**
 * The demand ranking of one emitted lane. `.strict()` — an extra key here is a
 * provider-shaped field arriving by accident, which is the one thing this shape
 * must not admit.
 */
export const LaneDemandSchema = z
  .object({
    size: z.enum(LANE_SIZE_VALUES),
    complexity: z.enum(LANE_COMPLEXITY_VALUES),
    risk: z.enum(LANE_RISK_VALUES),
  })
  .strict();

export type LaneDemand = z.infer<typeof LaneDemandSchema>;

/**
 * The exact key set a lane's demand ranking contributes to an emitted lane —
 * derived from the schema's OWN shape, never a hand-listed literal beside it, so
 * a validator asking `hasExactKeys` and the schema cannot drift.
 */
export const LANE_DEMAND_KEYS: readonly string[] = Object.keys(
  LaneDemandSchema.shape,
).sort(compareCodeUnits);

/** File-count bound at which a lane's size steps up from `small`. */
const LANE_SIZE_MEDIUM_FILES = 4;
/** File-count bound at which a lane's size steps up from `medium`. */
const LANE_SIZE_LARGE_FILES = 12;
/** Token-estimate bound at which a lane's size steps up from `small`. */
const LANE_SIZE_MEDIUM_TOKENS = 3_000;
/** Token-estimate bound at which a lane's size steps up from `medium`. */
const LANE_SIZE_LARGE_TOKENS = 12_000;
/** Token-estimate bound at which a lane's judgment need steps up from `focused`. */
const LANE_COMPLEXITY_STANDARD_TOKENS = 2_000;
/** Token-estimate bound at which a lane's judgment need steps up from `standard`. */
const LANE_COMPLEXITY_DEEP_TOKENS = 8_000;
/** Risk score at which `low` becomes `medium`. */
const LANE_RISK_MEDIUM_SCORE = 1 / 3;
/** Risk score at which `medium` becomes `high`. */
const LANE_RISK_HIGH_SCORE = 2 / 3;

/** Shared complexity floor for semantic review passes (charter, conceptual, contract, second-order). */
export const SEMANTIC_WORK_COMPLEXITY_FLOOR: LaneDemand["complexity"] = "standard";
/** Shared risk floor for semantic review passes (charter, conceptual, contract, second-order). */
export const SEMANTIC_WORK_RISK_FLOOR: LaneDemand["risk"] = "high";

/**
 * Shared semantic demand floors across charter, conceptual, contract, and
 * second-order work (packet 10 / F01). Whole-repo, cross-cutting and high-consequence:
 * these lanes set the frame every later step reasons inside, so their judgment
 * and stakes are floored at standard complexity and high risk.
 */
export const SHARED_SEMANTIC_DEMAND_FLOORS = {
  complexity: SEMANTIC_WORK_COMPLEXITY_FLOOR,
  risk: SEMANTIC_WORK_RISK_FLOOR,
  riskScore: 2 / 3,
} as const;

const COMPLEXITY_ORDER: Record<LaneDemand["complexity"], number> = {
  focused: 0,
  standard: 1,
  deep: 2,
};

const RISK_ORDER: Record<LaneDemand["risk"], number> = {
  low: 0,
  medium: 1,
  high: 2,
};

function laneSize(tokenEstimate: number, fileCount: number): LaneDemand["size"] {
  if (tokenEstimate >= LANE_SIZE_LARGE_TOKENS || fileCount >= LANE_SIZE_LARGE_FILES) {
    return "large";
  }
  if (tokenEstimate >= LANE_SIZE_MEDIUM_TOKENS || fileCount >= LANE_SIZE_MEDIUM_FILES) {
    return "medium";
  }
  return "small";
}

function laneComplexity(tokenEstimate: number): LaneDemand["complexity"] {
  if (tokenEstimate >= LANE_COMPLEXITY_DEEP_TOKENS) return "deep";
  if (tokenEstimate >= LANE_COMPLEXITY_STANDARD_TOKENS) return "standard";
  return "focused";
}

function laneRisk(riskScore: number): LaneDemand["risk"] {
  if (riskScore >= LANE_RISK_HIGH_SCORE) return "high";
  if (riskScore >= LANE_RISK_MEDIUM_SCORE) return "medium";
  return "low";
}

/**
 * Derive one lane's demand ranking from CONTENT-DERIVED facts only — the lane's
 * token estimate, its file count, and a content-derived risk score in `[0, 1]`.
 * Pure and total: every draw calls it with whatever it has, a draw with no risk
 * signal passes `0` and honestly gets `low`.
 *
 * Each draw supplies its own `riskScore` from what its artifacts already carry —
 * audit from the task's frozen `risk_estimate`, remediate from the severities of
 * the findings the block addresses — because that INPUT is genuinely per-mode.
 * The ranking rules above are not, which is why they live here.
 *
 * Semantic review passes (charter, conceptual, contract, second-order) pass
 * `complexityFloor` and `riskFloor` (or use `SHARED_SEMANTIC_DEMAND_FLOORS`)
 * so that cross-cutting passes cannot be under-ranked merely because their
 * prompt pointer is short.
 */
export function deriveLaneDemand(params: {
  readonly tokenEstimate: number;
  readonly fileCount: number;
  readonly riskScore: number;
  readonly complexityFloor?: LaneDemand["complexity"];
  readonly riskFloor?: LaneDemand["risk"];
}): LaneDemand {
  const tokenEstimate = Number.isFinite(params.tokenEstimate)
    ? Math.max(0, params.tokenEstimate)
    : 0;
  const fileCount = Number.isFinite(params.fileCount)
    ? Math.max(0, Math.trunc(params.fileCount))
    : 0;
  const riskScore = Number.isFinite(params.riskScore)
    ? Math.min(1, Math.max(0, params.riskScore))
    : 0;

  let complexity = laneComplexity(tokenEstimate);
  if (
    params.complexityFloor &&
    COMPLEXITY_ORDER[complexity] < COMPLEXITY_ORDER[params.complexityFloor]
  ) {
    complexity = params.complexityFloor;
  }

  let risk = laneRisk(riskScore);
  if (
    params.riskFloor &&
    RISK_ORDER[risk] < RISK_ORDER[params.riskFloor]
  ) {
    risk = params.riskFloor;
  }

  return {
    size: laneSize(tokenEstimate, fileCount),
    complexity,
    risk,
  };
}

// ── The emitted-lane REVIEW-MODE classification ───────────────────────────────
//
// A lane's demand RANKING tells the host how big / hard / consequential the work
// is; a lane's review MODE tells it the one fact the ranking cannot: whether the
// lane's value depends on the reviewer NOT being the author of the work under
// review. The two are orthogonal — a small lane can still REQUIRE independence
// (a one-file adversarial check), and a large one can be ordinary. The mode is
// CLOSED (three values), single-sourced here so audit and remediate draw the same
// vocabulary (one core, two draws — see CLAUDE.md "One core, two draws").
//
//   - `ordinary` — the lane's value does not depend on independence; a host may
//     execute it inline or dispatch it, whichever it has. The default.
//   - `independence_required` — the lane is an adversarial review whose value
//     comes from a reviewer that did NOT author the work. Independence is a
//     property of the CONTEXT, never provable by tooling: the tool declares the
//     REQUIREMENT and the reason, and the host owns how an independent context is
//     obtained (in-process subagents are not universal). When none is available,
//     the step PAUSES — it never degrades to a self-review fallback.
//   - `degraded_permitted` — the lane ordinarily wants independence, but a
//     degraded inline self-review is an EXPLICITLY accepted fallback (e.g. a
//     low-risk proportionate floor that must never be skipped). Unlike
//     `independence_required`, an unavailable independent context does NOT stop
//     the step; instead the executor runs it inline and RECORDS the degraded
//     independence in its output (say so in the result, never silently).
//
// `degraded_permitted` is NOT a lighter `independence_required` arrived at by
// quietly dropping the requirement — the tool never re-classifies a required
// review into a permitted one on the host's behalf. Which of the three a lane is
// is a property of what the lane IS; a caller states it, and a caller that claims
// independence was tool-verified is stating a falsehood (see
// `LaneReviewModeSchema`'s note below).
export const LANE_REVIEW_MODE_VALUES = [
  "ordinary",
  "independence_required",
  "degraded_permitted",
] as const;

export type LaneReviewMode = (typeof LANE_REVIEW_MODE_VALUES)[number];

export const LaneReviewModeSchema = z.enum(LANE_REVIEW_MODE_VALUES);

export interface LaneReviewModeDeclaration {
  mode: LaneReviewMode;
  /**
   * Why this lane has this mode. Required for anything but `ordinary` — the mode
   * "independence_required" must say WHAT is being adversarially reviewed and
   * against whom, or the bound metadata records a requirement with no stated
   * basis (which a host cannot act on). The reason states the NEED (independent
   * context, not the author), never a mechanism the host may not have.
   */
  reason?: string;
}

/**
 * The bound, per-lane review-mode record a step contract carries so an
 * automated consumer reads the DECLARED review mode beside the lane, rather than
 * reconstructing it from prose. `.strict()` — a provider-shaped field arriving
 * here is the one thing this shape must not admit, the same boundary `LaneDemand`
 * draws. The mode/reason are DECLARED by the caller; the tool records them and
 * does NOT claim to have verified that a host produced an independent context
 * (independence is a property of the execution context, invisible to tooling).
 */
export const LaneReviewRecordSchema = z
  .object({
    lane: z.string(),
    mode: LaneReviewModeSchema,
    reason: z.string().optional(),
  })
  .strict();
export type LaneReviewRecord = z.infer<typeof LaneReviewRecordSchema>;
