import type { AnalyzerConsentDecisions } from "audit-tools/shared";
import type { ArtifactBundle } from "../io/artifacts.js";
import type {
  AnalyzerConsentTokenGrant,
  AnalyzerSetting,
  GraphEdge,
} from "audit-tools/shared";
import type { AnalyzerPlanEntry } from "../extractors/analyzers/types.js";
import { collectLowConfidenceEdges } from "./edgeReasoning.js";
import { buildPathLookup } from "../extractors/graph.js";
import { buildDispositionMap } from "../extractors/disposition.js";
import {
  resolveAnalyzerPlan,
  needsInstallDecision,
} from "../extractors/analyzers/registry.js";
import { EXTERNAL_ANALYZER_CANDIDATES } from "audit-tools/shared";

/**
 * Inputs the fold-level host-input pauses depend on. These mirror the fields the
 * `next-step` fold reads when deciding whether to emit an interactive host step
 * (`analyzer_install` / `edge_reasoning_dispatch`) instead of running the deterministic
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
  /** Item B: acquisition gate — the consent fold only fires when acquisition is live. */
  externalAcquisitionEnabled?: boolean;
  /**
   * Item B: recorded per-candidate consent DECLINES, from the durable analyzer
   * policy at `.audit-tools/audit/analyzer-policy.json` — NOT session config,
   * whose schema is strict and holds only review_mode + observability. A grant
   * is never here: it binds one run and rides the scoped consent token below.
   */
  analyzerConsent?: AnalyzerConsentDecisions;
  /**
   * Item B: a per-run, tool-SCOPED consent grant. Typed as the
   * {@link AnalyzerConsentTokenGrant} shape — never a bare string — so the
   * scoped consent-fold below can ask exactly which candidates the grant names:
   * a candidate outside the grant's `tools` is still owed its offer. A bare
   * string would read as "admits everything", which is precisely the unscoped
   * path this type retires.
   */
  acquisitionConsentToken?: AnalyzerConsentTokenGrant;
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
 * Item B (consent surfacing): the consent-gated analyzer candidates that are
 * APPLICABLE to this repo and have NO recorded decision AND are not admitted by
 * this run's consent grant — the set the operator is still owed a batched offer
 * on. The SINGLE source of the analyzer-consent fold, consumed by BOTH the
 * `next-step` fold (which relays the list as the offer step) and the drain stop
 * predicate (which halts before the acquisition executor would silently skip
 * them — the silent-fail-closed defect the mechanical-analyzer-layer program
 * exists to fix). Nothing is owed when acquisition is off, the candidate has a
 * recorded decision (declined is never re-offered), the setting is `skip`, or
 * THIS RUN's grant names the candidate. A grant that does not name a candidate
 * leaves it owed — scope is honored per candidate, never widened to the run.
 */
export function pendingAnalyzerConsent(
  inputs: HostInputPauseInputs,
): typeof EXTERNAL_ANALYZER_CANDIDATES {
  if (inputs.externalAcquisitionEnabled !== true || !inputs.root) return [];
  const grant = inputs.acquisitionConsentToken;
  const grantedTools =
    grant && grant.value.trim().length > 0 && Array.isArray(grant.tools)
      ? new Set<string>(grant.tools)
      : undefined;
  const root = inputs.root;
  return EXTERNAL_ANALYZER_CANDIDATES.filter((candidate) => {
    if (candidate.defaultRun) return false;
    if (inputs.analyzers?.[candidate.id] === "skip") return false;
    if (inputs.analyzerConsent?.[candidate.id] !== undefined) return false;
    // Scoped: only a grant that names THIS candidate suppresses its offer.
    if (grantedTools?.has(candidate.id)) return false;
    try {
      return candidate.detect(root);
    } catch {
      return false;
    }
  });
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

// The composite stop predicates (`nextStepPausesForHostInput`,
// `nextStepIsDrainableRegen`) that used to live here were SUPERSEDED by the
// per-obligation classification in `obligationPolicy.ts` (CX-02: pause policy
// is a property of each obligation in the ONE registry, consumed identically
// by the plan draw and the full fold's bespoke bodies). The helpers above
// remain the single sources those classifiers read.
