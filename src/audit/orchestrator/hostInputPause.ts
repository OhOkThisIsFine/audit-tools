import type { ArtifactBundle } from "../io/artifacts.js";
import type { AnalyzerSetting, GraphEdge } from "audit-tools/shared";
import type { AnalyzerPlanEntry } from "../extractors/analyzers/types.js";
import { decideNextStep } from "./nextStep.js";
import { isHostDelegationExecutor } from "./executors.js";
import { collectLowConfidenceEdges } from "./edgeReasoning.js";
import { buildPathLookup } from "../extractors/graph.js";
import { buildDispositionMap } from "../extractors/disposition.js";
import {
  resolveAnalyzerPlan,
  needsInstallDecision,
} from "../extractors/analyzers/registry.js";

/**
 * Inputs the fold-level host-input pauses depend on. These mirror the fields the
 * `next-step` fold reads when deciding whether to emit an interactive host step
 * (`analyzer_install` / `edge_reasoning`) instead of running the deterministic
 * graph-enrichment executor. Single-sourcing them here keeps the drain loop and
 * the primary fold from drifting on WHERE the pipeline pauses for the operator.
 */
export interface HostInputPauseInputs {
  /** Repo root — the analyzer plan resolves dependencies against it. */
  root?: string;
  /** Per-analyzer resolution policy (drives the analyzer-install consent fold). */
  analyzers?: Record<string, AnalyzerSetting>;
  /** Phase 4B gate: low-confidence edge-reasoning host turn only fires when true. */
  graphLlmEdgeReasoning?: boolean;
}

/**
 * The undecided analyzer-install entries the graph-enrichment step still owes the
 * operator a consent decision on. This is the SINGLE source of the analyzer-install
 * consent fold — consumed both by the `next-step` fold (`handleGraphEnrichmentBranch`,
 * which relays the list as the host step) AND by the drain stop predicate below
 * (which stops when the list is non-empty). Absent a root / manifest there is
 * nothing to resolve, so nothing is owed.
 */
export function graphEnrichmentUnresolvedAnalyzers(
  bundle: ArtifactBundle,
  inputs: HostInputPauseInputs,
): AnalyzerPlanEntry[] {
  if (!inputs.root || !bundle.repo_manifest) return [];
  const includedFiles = [
    ...new Set(
      buildPathLookup(
        bundle.repo_manifest,
        buildDispositionMap(bundle.file_disposition),
      ).values(),
    ),
  ];
  return resolveAnalyzerPlan(inputs.root, inputs.analyzers, includedFiles).filter(
    needsInstallDecision,
  );
}

/**
 * The low-confidence graph edges the graph-enrichment step still owes a host
 * edge-reasoning turn on. The SINGLE source of the edge-reasoning fold: the flag
 * must be on and the floor must carry at least one low-confidence edge candidate.
 * Consumed by both `handleGraphEnrichmentBranch` (relays the candidates as the host
 * step) and the drain stop predicate (stops when the list is non-empty).
 */
export function graphEnrichmentLowConfidenceEdges(
  bundle: ArtifactBundle,
  inputs: HostInputPauseInputs,
): GraphEdge[] {
  if (inputs.graphLlmEdgeReasoning !== true || !bundle.graph_bundle) return [];
  return collectLowConfidenceEdges(bundle.graph_bundle);
}

/**
 * The SINGLE fold-aware stop predicate consumed by BOTH the `advanceAudit` drain
 * loop AND the `next-step` fold. True when the next step derived from `bundle`
 * pauses for HOST INPUT and must not be resolved deterministically in-process.
 *
 * Two classes of pause:
 *  1. A registry-level host-delegation executor (provider confirmation, intent /
 *     charter checkpoints, design-review + clarification + systemic-challenge
 *     loops, synthesis narrative, dispatch handoffs). `isHostDelegationExecutor`
 *     already sees every one of these — they are `kind: "host_delegation"` in the
 *     executor registry.
 *  2. A FOLD-LEVEL interactive pause the registry cannot see: the
 *     `graph_enrichment_executor` is registered `deterministic`, but the fold
 *     emits an `analyzer_install` consent step (undecided analyzer installs) or
 *     an `edge_reasoning` step (low-confidence edges + flag on) BEFORE running it.
 *     A registry-only gate (`isHostDelegationExecutor`) is blind to (2), so an
 *     unconditional drain would silently skip an operator-interactive step —
 *     exactly the latent failure this predicate closes. It reuses the SAME
 *     fold-detection helpers the `next-step` fold does, so the two cannot drift.
 *
 * Chain-length/index-agnostic: the decision is re-derived from `decideNextStep`
 * each call, never a fixed executor index.
 */
export function nextStepPausesForHostInput(
  bundle: ArtifactBundle,
  inputs: HostInputPauseInputs = {},
): boolean {
  const decision = decideNextStep(bundle, { emitStaleness: false });
  const executor = decision.selected_executor;
  if (!executor) return false;
  if (isHostDelegationExecutor(executor)) return true;
  if (executor === "graph_enrichment_executor") {
    if (graphEnrichmentUnresolvedAnalyzers(bundle, inputs).length > 0) return true;
    if (graphEnrichmentLowConfidenceEdges(bundle, inputs).length > 0) return true;
  }
  return false;
}

/**
 * True when the next step is a deterministic, runner-backed regen step the drain
 * loop may resolve in-process — i.e. it has a runner AND does NOT pause for host
 * input (neither a registry host-delegation boundary nor a fold-level interactive
 * pause). Callers pass the runner-presence check via `hasRunner` so this module
 * stays free of the executor-runner import (which would pull the whole executor
 * graph into the pause predicate).
 */
export function nextStepIsDrainableRegen(
  bundle: ArtifactBundle,
  hasRunner: (executor: string) => boolean,
  inputs: HostInputPauseInputs = {},
): boolean {
  const decision = decideNextStep(bundle, { emitStaleness: false });
  const executor = decision.selected_executor;
  if (!executor) return false;
  if (!hasRunner(executor)) return false;
  return !nextStepPausesForHostInput(bundle, inputs);
}
