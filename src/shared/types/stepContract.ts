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
 */
export function deriveLaneDemand(params: {
  readonly tokenEstimate: number;
  readonly fileCount: number;
  readonly riskScore: number;
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
  return {
    size: laneSize(tokenEstimate, fileCount),
    complexity: laneComplexity(tokenEstimate),
    risk: laneRisk(riskScore),
  };
}
