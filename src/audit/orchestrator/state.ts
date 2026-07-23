import { AUDIT_REPORT_FILENAME } from "../io/artifacts.js";
import type { ArtifactBundle } from "../io/artifacts.js";
import type {
  AuditObligation,
  AuditState,
  AuditTopLevelStatus,
  ObligationState,
} from "../types/auditState.js";
import { computeStaleArtifacts } from "./staleness.js";
import { derivePendingTaskPartition } from "./pendingTasks.js";
import {
  unresolvedConstraintClauses,
} from "./intentInterpreter.js";
import {
  isDesignReviewStale,
  type DesignReviewPass,
} from "./designReviewSnapshot.js";

function has(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function obligation(
  id: string,
  state: ObligationState,
  reason?: string,
): AuditObligation {
  return { id, state, reason };
}

function staleOrSatisfied(
  staleArtifacts: Set<string>,
  deps: string[],
  present: boolean,
): ObligationState {
  if (!present) return "missing";
  return deps.some((dep) => staleArtifacts.has(dep)) ? "stale" : "satisfied";
}

/**
 * Satisfaction state of a design-review pass (B2 parity port). A pass that has
 * not completed is `missing`. A completed pass is `stale` when a snapshot exists
 * and the semantic projection of any structural input it reviewed has changed —
 * which triggers a *diff-based* re-review, not a blind full re-run — otherwise
 * `satisfied`. The legacy path (only the old `reviewed` flag, no snapshot) has no
 * snapshot, so it stays `satisfied` (never spuriously re-fires).
 */
function designReviewPassState(
  bundle: ArtifactBundle,
  pass: DesignReviewPass,
  completed: boolean,
): ObligationState {
  if (!completed) return "missing";
  const snapshot = bundle.design_review_snapshots?.[pass];
  if (snapshot && isDesignReviewStale(snapshot, bundle)) return "stale";
  return "satisfied";
}

/** Options for `deriveAuditState`. */
export interface DeriveAuditStateOptions {
  /**
   * Forwarded to `computeStaleArtifacts`. When `false`, the staleness pass runs
   * without writing its stderr record — used by `advanceAudit`'s internal drain
   * loop so a whole regen cascade emits ONE consolidated staleness record at the
   * boundary rather than one per drained step. Defaults to `true` (every other
   * caller keeps the current emit-on-stale behavior).
   */
  emitStaleness?: boolean;
  /**
   * The reconciliation gate's PRECOMPUTED delta (G3): backends this auditor can
   * reach now that the operator's confirmation never mentions. Non-empty ⇒ the
   * `provider_confirmation` obligation re-opens so the operator reconciles them.
   *
   * Precomputed, never derived here, and that is load-bearing: the delta needs
   * `discoverProviders`, which shells out (`spawnSync("where"/"which")`) ~6 times.
   * `deriveAuditState` is sync, pure, and called from ~20 sites — three inside the
   * drain loop with `MAX_DRAIN_STEPS = 64` ⇒ deriving it here would mean 1,100+
   * process spawns per `next-step`, and would make this function PATH/env-dependent
   * (every bundle-derives-state test would start shelling out). The CLI computes it
   * ONCE per invocation and passes it down.
   *
   * Absent ⇒ presence-only, exactly as before. That is the right default for the
   * render/report callers, which are not the gate.
   */
  newlyReachableBackends?: readonly string[];
  /**
   * The capability-evidence gate's PRECOMPUTED delta: dispatchable pools whose
   * capability lookup does not resolve — no external rank source covers the model AND
   * the confirmation records no rank for it. Non-empty ⇒ the `provider_confirmation`
   * obligation re-opens so the pool is PINNED DOWN (LLM-proposed relative ordering,
   * operator reorder, or the explicit "unrankable, accept at band X" escape) rather
   * than silently fail-opening at the admission capability floor and becoming eligible
   * for `deep` work it may be entirely unfit for.
   *
   * Precomputed for the SAME reason as `newlyReachableBackends`: resolving it needs the
   * pool build + the confirmation read (both async, both I/O), and `deriveAuditState`
   * is sync, pure, and called ~20× per invocation including 3× inside the drain.
   *
   * Each entry is a MODEL id — the same keyspace the dispatch join uses
   * (`readConfirmedCapabilityRanks` → `pool.hostModel`). Entries are defined as "the
   * join does not resolve", never a parallel predicate: a pool the join cannot reach
   * at all (no model) is unpinnable, so admitting it here would re-prompt forever.
   *
   * Absent ⇒ presence-only, exactly as before — the right default for the render/report
   * callers, which are not the gate.
   */
  unevidencedCapabilityPools?: readonly string[];
}

export function deriveAuditState(
  bundle: ArtifactBundle,
  options: DeriveAuditStateOptions = {},
): AuditState {
  const obligations: AuditObligation[] = [];
  const staleArtifacts = computeStaleArtifacts(bundle, {
    emit: options.emitStaleness ?? true,
  });

  // Gate-0. Presence-only, PLUS the G3 reconciliation gate: a confirmation that
  // exists but predates a backend this auditor can now reach is NOT satisfied — the
  // operator confirms model choices, so a backend they never saw must not silently
  // become dispatchable. The delta is precomputed by the caller (see
  // `newlyReachableBackends`); absent ⇒ presence-only, as before.
  //
  // PLUS the capability-evidence gate: a confirmation that exists but leaves a
  // dispatchable pool with no resolvable capability rank is NOT satisfied either. The
  // admission capability floor fails OPEN on an unranked pool, so without this the pool
  // is eligible for `deep` work on no evidence at all. Same precomputed-delta shape and
  // same reason as the reach gate above.
  const newlyReachable = options.newlyReachableBackends ?? [];
  const unevidenced = options.unevidencedCapabilityPools ?? [];
  const reasons: string[] = [];
  if (newlyReachable.length > 0) {
    reasons.push(`reachable backends the operator never confirmed: ${newlyReachable.join(", ")}`);
  }
  if (unevidenced.length > 0) {
    reasons.push(`dispatch pools with no capability evidence: ${unevidenced.join(", ")}`);
  }
  obligations.push(
    obligation(
      "provider_confirmation",
      !has(bundle.provider_confirmation)
        ? "missing"
        : reasons.length > 0
          ? "stale"
          : "satisfied",
      reasons.length > 0 ? reasons.join("; ") : undefined,
    ),
  );

  obligations.push(
    obligation(
      "repo_manifest",
      has(bundle.repo_manifest) ? "satisfied" : "missing",
    ),
  );
  obligations.push(
    obligation(
      "file_disposition",
      staleOrSatisfied(
        staleArtifacts,
        ["file_disposition.json"],
        has(bundle.file_disposition),
      ),
    ),
  );
  obligations.push(
    obligation(
      "auto_fixes_applied",
      staleOrSatisfied(
        staleArtifacts,
        ["file_disposition.json"],
        has(bundle.auto_fixes_applied),
      ),
    ),
  );
  obligations.push(
    obligation(
      "syntax_resolved",
      staleOrSatisfied(
        staleArtifacts,
        ["auto_fixes_applied.json", "syntax_resolution_status.json"],
        has(bundle.syntax_resolution_status),
      ),
    ),
  );

  // External-analyzer acquisition (Slice D): runs AFTER intake, BEFORE structure
  // (graph/risk/planning consume external_analyzer_results). Satisfied when the
  // marker exists + is fresh w.r.t. {repo_manifest, file_disposition}.
  obligations.push(
    obligation(
      "external_analyzers_current",
      staleOrSatisfied(
        staleArtifacts,
        ["external_analyzer_acquisition.json"],
        has(bundle.external_analyzer_acquisition),
      ),
    ),
  );

  const structureReady =
    has(bundle.unit_manifest) &&
    has(bundle.surface_manifest) &&
    has(bundle.graph_bundle) &&
    has(bundle.critical_flows) &&
    has(bundle.risk_register);
  obligations.push(
    obligation(
      "structure_artifacts",
      staleOrSatisfied(
        staleArtifacts,
        [
          "unit_manifest.json",
          "surface_manifest.json",
          "graph_bundle.json",
          "critical_flows.json",
          "risk_register.json",
        ],
        structureReady,
      ),
    ),
  );

  // Critical-flow LLM fallback (audit-goals §Critical flows): a bounded host-LLM
  // pass that enriches the flows when — and ONLY when — the deterministic
  // inference explicitly marked itself below the confidence bar
  // (`critical_flows.fallback_required`). When the bar was met this self-satisfies
  // (nothing to review), so it never blocks the default path. When it fails, the
  // host submission (critical-flow-fallback.json, a durable upstream input the
  // structure phase merges) satisfies it: once present, the operator has been
  // given the review turn — regardless of whether the merged flows fully cleared
  // the bar — so the obligation never loops re-asking. It is a leaf host input, so
  // it is never stale on its own; a code change re-runs structure (which re-derives
  // fallback_required over the re-merged flows).
  const criticalFlowFallbackNeeded =
    has(bundle.critical_flows) &&
    bundle.critical_flows?.fallback_required === true;
  obligations.push(
    obligation(
      "critical_flow_fallback_current",
      !criticalFlowFallbackNeeded
        ? "satisfied"
        : has(bundle.critical_flow_fallback)
          ? "satisfied"
          : "missing",
      criticalFlowFallbackNeeded && !has(bundle.critical_flow_fallback)
        ? "Deterministic critical-flow inference fell below the confidence bar; a host-LLM fallback pass is needed to enrich the flows."
        : undefined,
    ),
  );

  obligations.push(
    obligation(
      "graph_enrichment_current",
      staleOrSatisfied(
        staleArtifacts,
        ["analyzer_capability.json"],
        has(bundle.analyzer_capability),
      ),
    ),
  );

  obligations.push(
    obligation(
      "design_assessment_current",
      staleOrSatisfied(
        staleArtifacts,
        ["design_assessment.json"],
        has(bundle.design_assessment),
      ),
    ),
  );

  // Phase B conceptual design-review — the deterministic structure-layer
  // decomposition (overlay-and-delta operator). Runs once the enriched graph +
  // manifest are fresh; its findings + node scaffold feed the Phase C charter pass.
  obligations.push(
    obligation(
      "structure_decomposition_current",
      staleOrSatisfied(
        staleArtifacts,
        ["structure_decomposition.json"],
        has(bundle.structure_decomposition),
      ),
    ),
  );

  // The checkpoint is "current" only when it both exists/fresh AND every
  // unencodable free_form_intent clause has been escalated to a host-answered
  // constraint. An unanswered unencodable clause keeps this obligation unmet so
  // the blocking `confirm_intent` step re-fires — the directive is never
  // silently dropped at planning time (the single shared interpreter is the
  // encodability authority; see intentInterpreter.unresolvedConstraintClauses).
  const intentCheckpointBase = staleOrSatisfied(
    staleArtifacts,
    ["intent_checkpoint.json"],
    has(bundle.intent_checkpoint),
  );
  const unresolvedClauses =
    intentCheckpointBase === "satisfied"
      ? unresolvedConstraintClauses(bundle.intent_checkpoint)
      : [];
  obligations.push(
    obligation(
      "intent_checkpoint_current",
      unresolvedClauses.length > 0 ? "missing" : intentCheckpointBase,
      unresolvedClauses.length > 0
        ? `${unresolvedClauses.length} free_form_intent clause(s) could not be encoded as planning signals and need a host answer in constraint_clauses before planning proceeds.`
        : undefined,
    ),
  );

  // Phase C conceptual design-review — the charter LAYER. Runs after the intent
  // checkpoint (it needs the confirmed ceiling) and before the design-review
  // passes. Satisfied when charter_register.json exists + is fresh w.r.t. its deps
  // (structure_decomposition / intent_checkpoint / repo_manifest). At a shallow
  // ceiling the executor writes an omitted register in one step, so this never
  // blocks the default (conversation-first) path.
  obligations.push(
    obligation(
      "charter_extraction_current",
      staleOrSatisfied(
        staleArtifacts,
        ["charter_register.json"],
        has(bundle.charter_register),
      ),
    ),
  );

  // Phase C.2 conceptual design-review — the INDEPENDENT delta-mining pass. Runs
  // after charter extraction (it reads the assembled charters) and before the
  // design-review passes. The base satisfaction is the usual exists+fresh check on
  // charter_register.json; the extraction pass sets `deltas_pending` whenever it
  // produced ≥1 subsystem, so this obligation stays unmet until the independent
  // delta-miner has run (no author marks its own homework). When extraction omitted
  // (or found no subsystems) `deltas_pending` is never set → this self-satisfies,
  // never blocking the default (conversation-first) path — mirrors
  // charter_extraction_current.
  const charterDeltaBase = staleOrSatisfied(
    staleArtifacts,
    ["charter_register.json"],
    has(bundle.charter_register),
  );
  const charterDeltasPending =
    charterDeltaBase === "satisfied" &&
    bundle.charter_register?.deltas_pending === true;
  obligations.push(
    obligation(
      "charter_delta_current",
      charterDeltasPending ? "missing" : charterDeltaBase,
      charterDeltasPending
        ? "Charter deltas not yet mined by the independent delta pass before the design-review passes."
        : undefined,
    ),
  );

  // Backward-compat: old artifacts only have `reviewed`; new artifacts have
  // contract_reviewed and conceptual_reviewed. Treat both as satisfied when
  // the legacy flag is set and neither new flag is present.
  // Guard: a stale design_assessment.json must NOT activate the legacy path —
  // the artifact was written by an old executor before the split; once stale it
  // triggers design_assessment_current and the executor will write a fresh
  // artifact with the new fields. Letting a stale legacy artifact permanently
  // satisfy both obligations bypasses the split-review passes (ARC-14c59af5-2).
  const legacyReviewed =
    bundle.design_assessment?.reviewed === true &&
    bundle.design_assessment?.contract_reviewed !== true &&
    bundle.design_assessment?.conceptual_reviewed !== true &&
    !staleArtifacts.has("design_assessment.json");

  obligations.push(
    obligation(
      "design_review_contract_completed",
      designReviewPassState(
        bundle,
        "contract",
        bundle.design_assessment?.contract_reviewed === true || legacyReviewed,
      ),
    ),
  );

  obligations.push(
    obligation(
      "design_review_conceptual_completed",
      designReviewPassState(
        bundle,
        "conceptual",
        bundle.design_assessment?.conceptual_reviewed === true || legacyReviewed,
      ),
    ),
  );

  // Phase D conceptual design-review — the charter-alignment TRIANGULATION LOOP.
  // Runs after the design-review passes and before planning. The base satisfaction
  // is the usual exists+fresh check on charter_clarification.json (its deps:
  // charter_register / intent_checkpoint / repo_manifest). At a shallow ceiling (or
  // zero attention) the executor writes the register in one deterministic step, so
  // this never blocks the default (conversation-first) path — mirrors
  // charter_extraction_current.
  //
  // The interruptible LOOP: when the register exists+fresh AND still carries
  // interactive `asked` questions with no recorded answer, the obligation stays
  // unmet so the relay step re-fires (the host banks each answer, the executor
  // re-splits, the queue shrinks). An empty/all-answered `asked` set satisfies it.
  // A user who taps out mid-loop leaves questions open → they bank as findings on
  // the next deterministic assemble, so the loop always terminates.
  const clarificationBase = staleOrSatisfied(
    staleArtifacts,
    ["charter_clarification.json"],
    has(bundle.charter_clarification),
  );
  const pendingCharterQuestions =
    clarificationBase === "satisfied"
      ? (bundle.charter_clarification?.asked ?? []).filter(
          (q) => q.answer === undefined,
        ).length
      : 0;
  obligations.push(
    obligation(
      "charter_clarification_current",
      pendingCharterQuestions > 0 ? "missing" : clarificationBase,
      pendingCharterQuestions > 0
        ? `${pendingCharterQuestions} interactive charter-alignment question(s) awaiting an answer (or leave-open) before planning proceeds.`
        : undefined,
    ),
  );

  // Phase E systemic improvement-seeking challenge — the loop-until-dry second-order
  // adversary pass. Runs after the charter-clarification loop and before planning. The
  // base satisfaction is the usual exists+fresh check on systemic_challenge.json (its
  // deps: charter_register / intent_checkpoint / repo_manifest). At a shallow ceiling
  // (the default) the executor writes an `omitted` register in one deterministic step,
  // so this never blocks the conversation-first path — mirrors charter_clarification.
  //
  // The interruptible LOOP-UNTIL-DRY: when the register exists+fresh but has NOT yet
  // `converged` (a deep+ run whose adversary rounds have not returned nothing-new), the
  // obligation stays unmet so the relay step re-fires for the next challenge round. A
  // converged (or omitted) register satisfies it.
  const systemicBase = staleOrSatisfied(
    staleArtifacts,
    ["systemic_challenge.json"],
    has(bundle.systemic_challenge),
  );
  const systemicOpen =
    systemicBase === "satisfied" && bundle.systemic_challenge?.converged !== true;
  obligations.push(
    obligation(
      "systemic_challenge_current",
      systemicOpen ? "missing" : systemicBase,
      systemicOpen
        ? "Systemic challenge loop still open (a challenge round has not yet returned nothing-new) before planning proceeds."
        : undefined,
    ),
  );

  const planningReady =
    has(bundle.coverage_matrix) &&
    has(bundle.flow_coverage) &&
    has(bundle.runtime_validation_tasks) &&
    has(bundle.audit_tasks) &&
    has(bundle.requeue_tasks);
  obligations.push(
    obligation(
      "planning_artifacts",
      staleOrSatisfied(
        staleArtifacts,
        [
          "external_analyzer_results.json",
          "coverage_matrix.json",
          "flow_coverage.json",
          "runtime_validation_tasks.json",
          "audit_tasks.json",
          "requeue_tasks.json",
        ],
        planningReady,
      ),
    ),
  );

  // The pending set is the shared partition (INV-PENDING-SINGLE-SOURCE,
  // ./pendingTasks.ts) — the SAME derivation dispatch's buildPendingAuditTasks
  // consumes, so the gate and dispatch can never disagree on which tasks still
  // need work. It already folds in the consume half of the O3 staleness gate:
  // a task whose CURRENT (supersession-resolved) result has DRIFTED from its
  // recorded content-key baseline re-dispatches even though its stale result
  // left it status `complete`.
  const { pendingTasks } = derivePendingTaskPartition(bundle);
  // Tasks deferred by a budget cap (FINDING-013) will never have results, so
  // they must be excluded from the completion check — otherwise the obligation
  // loops forever under a budget. Absent active_dispatch => empty set => the
  // logic is unchanged (all tasks must be complete).
  const deferredTaskIds = new Set<string>(
    bundle.active_dispatch?.deferred_task_ids ?? [],
  );
  // Tasks stranded by a partial-completion terminal (OBL-A06): when the dispatch
  // engine fires an empty-pool or livelock terminal and records it on
  // active_dispatch, those tasks will never be dispatched. Treat them as
  // uncovered so the pipeline can proceed to synthesis on partial coverage
  // rather than stalling forever. This shortcut fires ONLY when the terminal
  // was deliberately written — gate on its presence, not on the deferred list.
  const partialTerminal = bundle.active_dispatch?.partial_completion_terminal;
  const strandedTaskIds = new Set<string>(
    partialTerminal?.stranded_ids ?? [],
  );

  const hasPendingAuditTasks = pendingTasks.some(
    (task) =>
      // Deferred/stranded wins over pending: a budget-deferred or
      // terminal-stranded task must not hold the completion gate open.
      !deferredTaskIds.has(task.task_id) &&
      !strandedTaskIds.has(task.task_id),
  );

  if (hasPendingAuditTasks) {
    obligations.push(obligation("audit_tasks_completed", "missing"));
  } else if (has(bundle.audit_tasks)) {
    obligations.push(obligation("audit_tasks_completed", "satisfied"));
  }

  // INV-STATE-PURE-AND-REACHABLE (COR-b019d3b9): the top-level "blocked" status
  // is derivable from the BUNDLE, not only from step-write paths. A persisted
  // DC-4 dispatch pause (`active_dispatch.paused_state`: the run is waiting on
  // an exhausted provider pool) with work still pending is exactly that state:
  // the run is live but cannot advance until capacity returns. The obligation is
  // deliberately NON-ACTIONABLE ("blocked", and its id is not in the PRIORITY
  // scan) so it never masks the resume path — `audit_tasks_completed` stays
  // `missing` (actionable) above, and re-running next-step re-drives dispatch,
  // which resumes or promotes the pause (`advancePausedState`). A moot pause
  // (nothing pending) derives nothing; resume/terminal promotion clears
  // `paused_state`, which clears this.
  if (bundle.active_dispatch?.paused_state && hasPendingAuditTasks) {
    const pauseCount =
      bundle.active_dispatch.paused_state.lifecycle?.pause_count ?? 0;
    obligations.push(
      obligation(
        "dispatch_capacity",
        "blocked",
        `Rolling dispatch is paused waiting for provider capacity (pause ${pauseCount + 1}); ` +
          "re-run next-step once capacity returns — the run resumes automatically, or " +
          "yields to synthesis on partial coverage after the pause limit.",
      ),
    );
  }

  obligations.push(
    obligation(
      "audit_results_ingested",
      (bundle.audit_tasks?.length ?? 0) === 0 || has(bundle.audit_results)
        ? "satisfied"
        : "missing",
    ),
  );
  const runtimeTasks = bundle.runtime_validation_tasks?.tasks ?? [];
  const runtimeResults = bundle.runtime_validation_report?.results ?? [];
  const runtimeReady =
    runtimeTasks.length === 0 ||
    (runtimeTasks.length > 0 &&
      runtimeTasks.every((task) =>
        runtimeResults.some(
          (result) =>
            result.task_id === task.id &&
            result.status !== "pending",
        ),
      ));
  obligations.push(
    obligation(
      "runtime_validation_current",
      runtimeReady
        ? "satisfied"
        : has(bundle.runtime_validation_report)
          ? "stale"
          : "missing",
      runtimeTasks.length === 0
        ? "No deterministic runtime validation tasks were planned."
        : undefined,
    ),
  );
  obligations.push(
    obligation(
      "synthesis_current",
      staleOrSatisfied(
        staleArtifacts,
        [AUDIT_REPORT_FILENAME],
        has(bundle.audit_report),
      ),
    ),
  );
  obligations.push(
    obligation(
      "synthesis_narrative_current",
      staleOrSatisfied(
        staleArtifacts,
        ["synthesis-narrative.json"],
        has(bundle.synthesis_narrative),
      ),
    ),
  );

  // A run is "not_started" only when neither the session gate (provider_confirmation)
  // nor the first intake artifact (repo_manifest) has been produced. Once the provider
  // gate fires, the run is live and must not be cleaned up as stale.
  let status: AuditTopLevelStatus = "not_started";
  if (!has(bundle.provider_confirmation) && !has(bundle.repo_manifest)) {
    status = "not_started";
  } else if (obligations.some((o) => o.state === "blocked")) {
    status = "blocked";
  } else {
    status = "active";
  }

  const incomplete = obligations.some(
    (o) => o.state === "missing" || o.state === "stale",
  );
  if (!incomplete && has(bundle.audit_report)) {
    status = "complete";
  }

  return {
    status,
    blockers: [],
    obligations,
  };
}
