import type { FrictionItem } from "../io/frictionCapture.js";
import type { FrictionCaptureArtifact } from "../io/frictionCapture.js";
import { captureFrictionEvent, type FrictionEvent } from "./captureFrictionEvent.js";
import type { FrictionCategory } from "./frictionRecord.js";

/**
 * CE-005 — the SINGLE shared backend-observed step-boundary chokepoint.
 *
 * EVERY backend-observed friction fact flows through `captureStepBoundaryFriction`
 * (single-sourced here, consumed by BOTH orchestrators) so the fact list is
 * structural/extensible, not a snapshot a sixth fact can silently bypass. The
 * backend already computes each of these facts at its own step boundary — phase
 * re-emit counts, artifact rejection, repair rounds, post-repair re-derive,
 * no-change merge, the intent-gate lock-across-judge fallback, and any quota
 * escalation. Routing them all through one chokepoint with ZERO host discretion
 * (INV-O1-1 / OBL-m-friction-inv-1) means a new backend fact is added by routing
 * it through this same emitter, never by extending a closed enum elsewhere.
 *
 * CE-006 — the event id is a STRUCTURED, collision-free key. Its components
 * {event_type, runId, discriminator} are individually percent-encoded and joined
 * with a delimiter (`:`) that CANNOT appear in any encoded component, so a
 * `:`-bearing reused discriminator (e.g. an M-IDEMPOTENCY split key) can never
 * make the de-dup key ambiguous: two distinct facts never flatten to one key, and
 * one fact never expands to two (OBL-m-friction-inv-6 / fail-2). The encoding is
 * deterministic, so re-recording the same fact is a guaranteed no-op (INV-O1-6).
 *
 * The capture itself rides `captureFrictionEvent` — best-effort, non-fatal,
 * de-duped, OS/path-agnostic (INV-O1-5 / fail-5). A contended or failed capture
 * never throws into the in-flight obligation.
 */

/**
 * The backend-observed step-boundary fact kinds. OPEN/EXTENSIBLE — this union is
 * the documented catalogue, but the chokepoint accepts any string `event_type`
 * so a new backend fact routes through the SAME emitter without forking a closed
 * enum (CE-005). The named members below are the seven facts the contract pins:
 *
 *  - `phase_reemit`       — a phase re-emitting the SAME gate errors / leftovers.
 *  - `artifact_rejected`  — an artifact rejected / archived (referential-integrity
 *                           reject, deemed_inappropriate, archive-consumed-inputs).
 *  - `repair_round`       — one runEmitValidateRepair stage firing.
 *  - `post_repair_rederive` — a staleness re-derive after a repair / redispatch.
 *  - `no_change_merge`    — a resolved_no_change node merged with no diff.
 *  - `intent_gate_fallback` — intent_checkpoint gate lock-across-judge fallback.
 *  - `quota_escalation`   — a bounded quota re-limit escalation surfaced as friction.
 *  - `coverage_total_lines_mismatch` — an AuditResult whose
 *                           `file_coverage[].total_lines` disagrees with the
 *                           file's actual line count (discriminator: the result
 *                           index + the mismatching path).
 *  - `node_quarantine`    — an implement node that committed edits but hard-failed
 *                           the tool's verify/scope/merge; work preserved under a
 *                           quarantine ref, NOT landed (discriminator: the node id).
 *  - `declared_cost_drift` — a dispatch pool DECLARED free (`cost_per_mtok:0`)
 *                           reported a positive cost on a completion (lapsed free
 *                           tier); the tool demoted it out of free-first and the
 *                           operator should reconcile the declared cost
 *                           (discriminator: the pool id).
 */
export type StepBoundaryEventType =
  | "phase_reemit"
  | "artifact_rejected"
  | "repair_round"
  | "post_repair_rederive"
  | "no_change_merge"
  | "intent_gate_fallback"
  | "quota_escalation"
  | "coverage_total_lines_mismatch"
  | "node_quarantine"
  | "declared_cost_drift"
  | (string & {});

/**
 * Deterministic map from a backend step-boundary fact kind to the REAL close-out
 * friction CATEGORY (one of `FRICTION_CATEGORIES`) it belongs to. This is what
 * lets the auto-captured event feed the per-category friction walk directly:
 * every backend fact is redundant/wasteful re-work or a something-the-tool-had-to
 * -be-reminded-of, never the coarse `trap` bucket the sink used to stamp.
 *
 *  - `inefficient_feeding` — redundant / wasteful re-work: phase re-emits, repair
 *    rounds, post-repair re-derives, no-change merges, quota escalations, and the
 *    coverage-line mismatch (a re-round-trip to fix a mechanical mismatch).
 *  - `tool_should_decide`  — a fact where the tool fell back to host discretion or
 *    quarantined work the host must now shepherd: artifact rejection, the
 *    intent-gate lock-across-judge fallback, and a node quarantine.
 *
 * The named members are pinned; any UNKNOWN `event_type` degrades to
 * `inefficient_feeding` (the safe "this was avoidable re-work" default) so a new
 * backend fact always lands in a real category — never `trap`, never uncovered.
 */
const STEP_BOUNDARY_CATEGORY: Record<string, FrictionCategory> = {
  phase_reemit: "inefficient_feeding",
  repair_round: "inefficient_feeding",
  post_repair_rederive: "inefficient_feeding",
  no_change_merge: "inefficient_feeding",
  quota_escalation: "inefficient_feeding",
  coverage_total_lines_mismatch: "inefficient_feeding",
  artifact_rejected: "tool_should_decide",
  intent_gate_fallback: "tool_should_decide",
  node_quarantine: "tool_should_decide",
  // A declared-free pool that started charging is a stale operator config the tool
  // surfaced and demoted around — the operator must reconcile the declared cost.
  declared_cost_drift: "tool_should_decide",
};

/**
 * The REAL close-out friction category for a step-boundary fact kind. Total: an
 * unknown event type degrades to `inefficient_feeding` so the mapping is never
 * undefined and a captured event is ALWAYS tagged with a real category.
 */
export function stepBoundaryFrictionCategory(
  eventType: StepBoundaryEventType,
): FrictionCategory {
  return STEP_BOUNDARY_CATEGORY[eventType] ?? "inefficient_feeding";
}

/**
 * Percent-encode a single id component so the join delimiter (`:`) cannot appear
 * inside it. `encodeURIComponent` already escapes `:` (and `/`, `\`, `%`, etc.),
 * but it leaves a handful of safe sub-delimiters (`!'()*-._~`) unescaped — none of
 * which is `:`, so the delimiter remains unambiguous. We additionally escape `*`
 * and `!` defensively to keep the keyspace tight and fully reversible.
 */
function encodeIdComponent(value: string): string {
  return encodeURIComponent(value).replace(
    /[!*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

/**
 * Build the STRUCTURED, collision-free de-dup id for a step-boundary fact.
 * Components are individually percent-encoded then joined with `:` — a delimiter
 * that cannot survive the encoding inside any component, so the mapping
 * {event_type, runId, discriminator} → id is injective (CE-006).
 */
export function stepBoundaryEventId(
  eventType: StepBoundaryEventType,
  runId: string,
  discriminator: string,
): string {
  return [eventType, runId, discriminator]
    .map((part) => encodeIdComponent(part))
    .join(":");
}

/** The structured fact a caller routes through the chokepoint. */
export interface StepBoundaryFriction {
  /** Backend-observed fact kind (one of the named members, or a new string). */
  eventType: StepBoundaryEventType;
  /**
   * A stable discriminator distinguishing this fact instance within the run
   * (e.g. the phase id + attempt, the artifact id, the node id). May contain any
   * characters — it is percent-encoded before flattening, so `:` is safe.
   */
  discriminator: string;
  /** Human-readable summary for the triage prompt. */
  note: string;
  severity?: FrictionItem["severity"];
  category?: FrictionItem["category"];
  area?: string;
  /**
   * Optional artifact/subject key this fact concerns (e.g. the node id, the
   * contract id). The aggregation axis for the derived per-category observation:
   * N facts on the SAME artifact collapse to one `inefficient_feeding` line.
   * Falls back to `area`, then the discriminator, when unset.
   */
  artifact?: string;
}

/**
 * Route ONE backend-observed step-boundary fact through the single chokepoint.
 *
 * Best-effort and non-fatal: delegates to `captureFrictionEvent`, which swallows
 * every failure so the in-flight obligation is never broken (INV-O1-5). De-duped
 * on the structured collision-free id, so re-entrant boundary passes (re-dispatch,
 * retry, re-derive) never double-count the same fact (INV-O1-6).
 */
export async function captureStepBoundaryFriction(
  artifactsDir: string,
  runId: string,
  fact: StepBoundaryFriction,
  tool: FrictionCaptureArtifact["tool"],
): Promise<void> {
  const event: FrictionEvent = {
    id: stepBoundaryEventId(fact.eventType, runId, fact.discriminator),
    note: fact.note,
    severity: fact.severity,
    // The inherited `FrictionItem.category` (`bug|trap|suggestion`) is only a
    // coarse ORIGIN hint. It is NEVER the close-out category — the close-out keys
    // on `frictionCategory` below. Default the origin hint to `trap` (a standing
    // tooling fact) but ALWAYS stamp a REAL close-out category so the event feeds
    // the per-category walk instead of the dead `trap` bucket it used to land in.
    category: fact.category ?? "trap",
    frictionCategory: stepBoundaryFrictionCategory(fact.eventType),
    // The aggregation axis: N same-artifact backend facts collapse to ONE derived
    // observation. Prefer the caller's explicit `artifact`, then the fact's area,
    // then the discriminator (which is per-instance but still a stable subject key).
    artifact: fact.artifact ?? fact.area ?? fact.discriminator,
    area: fact.area,
  };
  await captureFrictionEvent(artifactsDir, runId, event, tool);
}

/** Reactive cost-drift facts routed through {@link captureCostDriftFriction}. */
export interface CostDriftInfo {
  poolId: string;
  observedCostUsd: number;
  declaredCostPerMtok: number;
}

/**
 * Route a reactive cost-drift demotion (a dispatch pool declared free —
 * `cost_per_mtok:0` — that started reporting a positive cost, so the rolling
 * engine demoted it out of free-first ordering) through the step-boundary
 * chokepoint as a `declared_cost_drift` fact. Both orchestrators' rolling
 * dispatch wiring (`onCostDrift`) is byte-identical apart from the trailing
 * `source` tool tag; this single-sources the eventType/note/severity/area
 * template so they cannot drift. Fire-and-forget, like the call sites it
 * replaces — never awaited by the caller.
 */
export function captureCostDriftFriction(
  artifactsDir: string,
  runId: string,
  info: CostDriftInfo,
  source: FrictionCaptureArtifact["tool"],
): void {
  void captureStepBoundaryFriction(
    artifactsDir,
    runId,
    {
      eventType: "declared_cost_drift",
      discriminator: info.poolId,
      note:
        `pool "${info.poolId}" was declared free (cost_per_mtok=${info.declaredCostPerMtok}) ` +
        `but reported cost=${info.observedCostUsd} — demoted out of free-first ordering; ` +
        `reconcile the source's declared cost.`,
      severity: "medium",
      area: "dispatch/cost",
    },
    source,
  );
}
