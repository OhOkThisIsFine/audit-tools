/**
 * Per-obligation host-boundary POLICY — the pure "classify" half of the ONE
 * audit obligation registry (CX-02).
 *
 * The registry's membership and order derive from `PRIORITY`; what each id
 * additionally carries is a decision about WHERE the host boundary sits on the
 * current bundle. That decision has two consumers with different rights:
 *
 * - the FULL `next-step` fold (cli) may CONSUME submissions, persist consent,
 *   ingest results and emit host steps — its bodies live in
 *   `src/audit/cli/nextStepHelpers.ts` and use these predicates as their
 *   branch conditions;
 * - the PLAN draw (`advanceAudit` without a `preferredExecutor`, reached by
 *   `audit-code plan`) must advance ONLY deterministic arms and halt at the
 *   first boundary that needs host work or would consume or persist host
 *   input. It gets exactly this module's classification and nothing else.
 *
 * Everything here is PURE with respect to the run: no consumption, no
 * quarantine, no unlink, no persist. Lane-file presence is probed through an
 * injected `submissionProbe` so this module never owns lane IO — and a caller
 * that supplies no probe (a bare in-memory `advanceAudit`) simply sees no
 * pending submissions, which is the correct degenerate reading: with no
 * artifacts dir there is nothing a plan could consume.
 *
 * The refuted shape this module replaces (design record, landing 4): an
 * EXCLUSION filter over the registry. `findFirstActionableObligation` skips a
 * missing id and continues, so removing host-boundary entries makes the scan
 * step OVER the boundary rather than halt at it. Classification preserves
 * every id, its derive closure, and its priority position.
 */

import type { ArtifactBundle } from "../io/artifacts.js";
import {
  ceilingRequestsCharters,
  resolveCharterCeiling,
} from "./charterExtractionExecutor.js";
import { resolveClarificationAttention } from "./charterClarificationExecutor.js";
import { deriveIntentEquivalenceStatus } from "./intentEquivalenceExecutor.js";
import {
  graphEnrichmentLowConfidenceEdges,
  graphEnrichmentUnresolvedAnalyzers,
  pendingAnalyzerConsent,
  type HostInputPauseInputs,
} from "./hostInputPause.js";
import { EXECUTOR_BY_OBLIGATION, isHostDelegationExecutor } from "./executors.js";
import {
  GATE_LANES,
  charterExtractionLane,
} from "../cli/laneSubmissions.js";
import { charterExtractionKindsForCeiling } from "../cli/charterExtractionPrompt.js";

/** Inputs the classification needs beyond the shared pause inputs. */
export interface ObligationPolicyInputs extends HostInputPauseInputs {
  /**
   * Whether the CLI session enables the synthesis narrative. The plan draw and
   * bare `advanceAudit` callers have no session, leave it unset, and take the
   * deterministic omit arm — which is exactly what the inner drain did at HEAD.
   */
  narrativeEnabled?: boolean;
  /**
   * Pure lane-file presence probe, injected by the caller that owns lane IO.
   * Absent → no submission is ever seen as pending.
   */
  submissionProbe?: (lane: string) => Promise<boolean>;
}

/** Where the host boundary sits for one obligation on one bundle. */
export type ObligationBranch =
  | { branch: "deterministic" }
  | { branch: "host_boundary"; reason: string }
  | { branch: "await_submission"; lane: string; reason: string };

const DETERMINISTIC: ObligationBranch = { branch: "deterministic" };

function hostBoundary(reason: string): ObligationBranch {
  return { branch: "host_boundary", reason };
}

function awaitSubmission(lane: string, reason: string): ObligationBranch {
  return { branch: "await_submission", lane, reason };
}

async function probe(
  inputs: ObligationPolicyInputs,
  lane: string,
): Promise<boolean> {
  return inputs.submissionProbe ? await inputs.submissionProbe(lane) : false;
}

// ── The pure deterministic-arm predicates, single-sourced ────────────────────
//
// Each is the exact branch condition the corresponding full-fold handler uses
// (previously private closures in `nextStepHelpers.ts`). Stating them once here
// is what makes the plan draw's classification and the full fold's consumption
// agree on WHERE the boundary is — the "one core, two draws" rule applied to
// pause policy.

/** Narrative disabled → the deterministic omit executor settles the obligation. */
export function synthesisNarrativeOmits(inputs: ObligationPolicyInputs): boolean {
  return !inputs.narrativeEnabled;
}

/** Shallow ceiling → charter extraction settles deterministically (omitted). */
export function charterExtractionOmits(bundle: ArtifactBundle): boolean {
  return !ceilingRequestsCharters(resolveCharterCeiling(bundle.intent_checkpoint));
}

/** Nothing to mine (extraction omitted / no subsystems) → settle deterministically. */
export function charterDeltaOmits(bundle: ArtifactBundle): boolean {
  return !(bundle.charter_register?.deltas_pending === true);
}

/**
 * Shallow ceiling / zero attention / loop not yet computed / no interactive
 * queue → the clarification executor runs autonomously this turn.
 */
export function charterClarificationOmits(bundle: ArtifactBundle): boolean {
  const ceiling = resolveCharterCeiling(bundle.intent_checkpoint);
  const attention = resolveClarificationAttention(bundle.intent_checkpoint);
  if (!ceilingRequestsCharters(ceiling) || attention === 0) return true;
  if (!bundle.charter_clarification) return true;
  if ((bundle.charter_clarification.asked?.length ?? 0) === 0) return true;
  return false;
}

/**
 * Shallow ceiling / loop not yet opened / converged register → the systemic
 * challenge executor runs autonomously this turn.
 */
export function systemicChallengeOmits(bundle: ArtifactBundle): boolean {
  if (!ceilingRequestsCharters(resolveCharterCeiling(bundle.intent_checkpoint))) {
    return true;
  }
  if (!bundle.systemic_challenge) return true;
  if (bundle.systemic_challenge.converged) return true;
  return false;
}

/** A deterministic arm (baseline / gate-version / structured delta) owns it. */
export function intentEquivalenceOmits(bundle: ArtifactBundle): boolean {
  return deriveIntentEquivalenceStatus(bundle).kind !== "prose_judgment_pending";
}

// ── Per-id classification ────────────────────────────────────────────────────

type Classifier = (
  bundle: ArtifactBundle,
  inputs: ObligationPolicyInputs,
) => Promise<ObligationBranch>;

/**
 * The bespoke-policy ids whose classification cannot be read off the executor
 * registry — each mirrors its full-fold handler's branch ORDER exactly (e.g.
 * charter extraction checks its ceiling BEFORE its lanes, the omittable gates
 * poll their lane first). Order fidelity is load-bearing: a stray submission at
 * a shallow ceiling must classify deterministic, because that is what the full
 * fold does with it.
 */
const POLICY_CLASSIFIERS: Readonly<Record<string, Classifier>> = {
  external_analyzers_current: async (_bundle, inputs) => {
    const pending = pendingAnalyzerConsent(inputs);
    if (pending.length === 0) return DETERMINISTIC;
    if (await probe(inputs, GATE_LANES.analyzer_consent)) {
      return awaitSubmission(
        GATE_LANES.analyzer_consent,
        "an analyzer-consent decisions submission is pending",
      );
    }
    return hostBoundary(
      "applicable consent-gated analyzer candidates await the batched operator offer",
    );
  },

  critical_flow_fallback_current: async (_bundle, inputs) => {
    if (await probe(inputs, GATE_LANES.critical_flow_fallback)) {
      return awaitSubmission(
        GATE_LANES.critical_flow_fallback,
        "a critical-flow fallback submission is pending",
      );
    }
    return hostBoundary(
      "deterministic flow inference fell below the confidence bar; the host authors the enrichment",
    );
  },

  graph_enrichment_current: async (bundle, inputs) => {
    if (graphEnrichmentUnresolvedAnalyzers(bundle, inputs).length > 0) {
      if (await probe(inputs, GATE_LANES.analyzer_decisions)) {
        return awaitSubmission(
          GATE_LANES.analyzer_decisions,
          "an analyzer-install decisions submission is pending",
        );
      }
      return hostBoundary("undecided analyzer installs await operator decisions");
    }
    if (graphEnrichmentLowConfidenceEdges(bundle, inputs).length > 0) {
      if (await probe(inputs, GATE_LANES.edge_reasoning)) {
        return awaitSubmission(
          GATE_LANES.edge_reasoning,
          "an edge-reasoning submission is pending",
        );
      }
      return hostBoundary("low-confidence graph edges await the host edge-reasoning turn");
    }
    return DETERMINISTIC;
  },

  intent_equivalence_current: async (bundle, inputs) => {
    if (await probe(inputs, GATE_LANES.intent_equivalence)) {
      return awaitSubmission(
        GATE_LANES.intent_equivalence,
        "an intent-equivalence verdict submission is pending",
      );
    }
    if (intentEquivalenceOmits(bundle)) return DETERMINISTIC;
    return hostBoundary("a prose-only intent delta awaits the host judge");
  },

  charter_extraction_current: async (bundle, inputs) => {
    if (charterExtractionOmits(bundle)) return DETERMINISTIC;
    const ceiling = resolveCharterCeiling(bundle.intent_checkpoint);
    for (const kind of charterExtractionKindsForCeiling(ceiling)) {
      const lane = charterExtractionLane(kind);
      if (await probe(inputs, lane)) {
        return awaitSubmission(lane, "a charter-extraction lane submission is pending");
      }
    }
    return hostBoundary("a deep ceiling owes the host charter-extraction turn");
  },

  charter_delta_current: async (bundle, inputs) => {
    if (await probe(inputs, GATE_LANES.charter_delta)) {
      return awaitSubmission(
        GATE_LANES.charter_delta,
        "a charter-delta submission is pending",
      );
    }
    if (charterDeltaOmits(bundle)) return DETERMINISTIC;
    return hostBoundary("a deltas_pending register owes the independent delta-miner turn");
  },

  charter_clarification_current: async (bundle, inputs) => {
    if (await probe(inputs, GATE_LANES.charter_clarification)) {
      return awaitSubmission(
        GATE_LANES.charter_clarification,
        "a clarification-answers submission is pending",
      );
    }
    if (charterClarificationOmits(bundle)) return DETERMINISTIC;
    return hostBoundary("an interactive clarification queue awaits relay to the operator");
  },

  systemic_challenge_current: async (bundle, inputs) => {
    if (await probe(inputs, GATE_LANES.systemic_challenge)) {
      return awaitSubmission(
        GATE_LANES.systemic_challenge,
        "a systemic-challenge round submission is pending",
      );
    }
    if (systemicChallengeOmits(bundle)) return DETERMINISTIC;
    return hostBoundary("an open challenge register awaits the next adversary round");
  },

  synthesis_narrative_current: async (_bundle, inputs) => {
    if (await probe(inputs, GATE_LANES.synthesis_narrative)) {
      return awaitSubmission(
        GATE_LANES.synthesis_narrative,
        "a synthesis-narrative submission is pending",
      );
    }
    // TRI-STATE, and the unknown arm is load-bearing: the narrative branch is
    // SESSION-owned (`narrativeEnabled` is a CLI-session parameter no bundle
    // field carries), so a draw that does not know the session must HALT here
    // — an omit on unknown would durably mark the narrative omitted and
    // silently foreclose the session's narrative turn. Only an EXPLICIT
    // narrativeEnabled=false takes the deterministic omit arm; the full fold
    // always states its session's value.
    if (inputs.narrativeEnabled === undefined) {
      return hostBoundary(
        "the synthesis-narrative branch is session-owned and this draw carries no session",
      );
    }
    if (synthesisNarrativeOmits(inputs)) return DETERMINISTIC;
    return hostBoundary("the enabled synthesis narrative awaits its host turn");
  },
};

/**
 * Classify where the host boundary sits for `id` on `bundle`.
 *
 * Per-id policy runs FIRST — several host-delegation-kind executors own real
 * deterministic arms (the omit/assemble/settle paths), so a kind-based check
 * alone would halt at boundaries that do not exist on this run (the refuted
 * blanket halt). The generic fallback then reads the executor registry: a
 * host-delegation executor or one with no deterministic runner is a boundary;
 * everything else is deterministic.
 *
 * `hasRunner` is injected (`EXECUTOR_RUNNERS` presence) so this module does not
 * pull the whole executor implementation graph into the policy layer.
 */
export async function classifyObligationBranch(
  id: string,
  bundle: ArtifactBundle,
  inputs: ObligationPolicyInputs,
  hasRunner: (executor: string) => boolean,
): Promise<ObligationBranch> {
  const classifier = POLICY_CLASSIFIERS[id];
  if (classifier) return classifier(bundle, inputs);
  const executor = EXECUTOR_BY_OBLIGATION.get(id);
  if (!executor) {
    return hostBoundary(`no executor is registered for obligation ${id}`);
  }
  if (isHostDelegationExecutor(executor.id) || !hasRunner(executor.id)) {
    return hostBoundary(`executor ${executor.id} requires its bound host step`);
  }
  return DETERMINISTIC;
}
