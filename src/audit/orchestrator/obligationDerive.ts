// The per-obligation projection of the holistic `deriveAuditState` scan, shared
// by the audit orchestrator's TWO DRAWS over one obligation registry: the plan
// draw (`buildPlanDrawObligations` in `advance.ts`) and the full next-step fold
// (`buildAuditObligations` in `cli/nextStepHelpers.ts`). It lived twice, once per
// draw, kept identical by discipline alone.
//
// WHY ITS OWN MODULE, and not `state.ts` which owns `deriveAuditState`.
// `state.ts` reads as the natural home — the module that owns the scan owning its
// projection — and that is what the item 2.1 plan recommends. It is wrong, and the
// reason is not layering. `tests/audit/one-holistic-derivation-per-scan.test.ts`
// pins the memo below by `vi.mock`-ing `orchestrator/state.js` and replacing
// `deriveAuditState` with a counting stub. A call from `state.ts` to its own
// `deriveAuditState` is INTRA-MODULE and no mock intercepts it, so hosting this
// function there makes that spy count zero against an assertion of one. The plan's
// grep for importers missed the test because it never names this symbol — it
// reaches the function through `buildAuditObligations()`. A separate module keeps
// the call cross-module, so the mock keeps working and the test stays byte-unchanged.
//
// NOT `src/shared/engine/obligationEngine.ts`, which the duplication catalog
// proposed: that module owns the generic selection vocabulary and imports only
// `zod`, and its header states that each orchestrator derives its OWN obligation
// states. This projection calls `deriveAuditState`, whose import closure is
// audit-domain all the way down (staleness, intent equivalence, pending tasks,
// design-review snapshots). Moving it to `shared/` would either drag that closure
// across the boundary or add injection indirection for a two-call-site helper that
// remediate-code would never call.
import type { ArtifactBundle } from "../io/artifacts.js";
import type { AuditState } from "../types/auditState.js";
import { deriveAuditState } from "./state.js";

/**
 * `derive` for one PRIORITY id: the same holistic `deriveAuditState` scan
 * `decideNextStep` runs, narrowed to this id's own missing/stale/satisfied
 * state. A pruned/absent obligation (e.g. `friction_capture_current`, which
 * `deriveAuditState` never emits — see `executorRunners.ts`) is satisfied, so
 * the scan can never select it — preserving today's "unreachable" behavior.
 * Every other state collapses to `"satisfied"`, which is the same partition
 * `isActionableObligationState` draws.
 *
 * MEMOIZED per bundle object identity, because `findNextObligation` calls EVERY
 * registered def's `derive` on the SAME bundle each scan (one scan per fold
 * iteration) and `deriveAuditState` runs the full `computeStaleArtifacts`
 * content-hash pass. Without the cache each scan recomputes that pass once per
 * obligation — the regression commit `6145a1a3` measured it and memoized it away.
 *
 * The key is safe because bundle identity changes at every transition
 * (`runSingleAdvanceStep` builds a fresh `finalizedBundle`), and the `complete`
 * gate above the memo can only flip via a transition. So a cache entry can never
 * outlive the state it was derived under. Pure memoization: WHAT is derived is
 * unchanged, and `deriveAuditState` is deterministic in the bundle.
 *
 * The cache is always created FRESH by the caller — per `advanceAudit` call in
 * the plan draw, per registry construction in the fold — never at module level,
 * so a caller that mutates a bundle in place between calls cannot observe a
 * stale entry.
 *
 * EMIT-OFF, like every in-fold derivation (CX-02): the fold's DRIVER emits the
 * one consolidated staleness record at its boundary — the preserve-list contract
 * — so a derive that emitted per scan miss would turn one call's cascade back
 * into a record per carried bundle.
 */
export function deriveObligationState(
  id: string,
  cache: WeakMap<ArtifactBundle, AuditState>,
): (bundle: ArtifactBundle) => "missing" | "stale" | "satisfied" {
  return (bundle) => {
    if (bundle.audit_state?.status === "complete") return "satisfied";
    let state = cache.get(bundle);
    if (!state) {
      state = deriveAuditState(bundle, { emitStaleness: false });
      cache.set(bundle, state);
    }
    const found = state.obligations.find((o) => o.id === id);
    if (!found) return "satisfied";
    return found.state === "missing" || found.state === "stale"
      ? found.state
      : "satisfied";
  };
}
