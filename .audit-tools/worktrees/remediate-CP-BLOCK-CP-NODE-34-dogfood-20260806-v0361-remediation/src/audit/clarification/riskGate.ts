// Phase D — D1 pure primitive: the blast-radius RISK GATE applied over a queue.
//
// A high-blast question is high-VALUE but also high-RISK: acting on a wrong
// high-blast finding is catastrophic, so it must clear a much higher bar of
// independent adversarial refutation before it may be asked interactively (design
// of record spec/conceptual-design-review-design.md §"Blast radius"). The
// per-request decision is single-sourced in the shared `riskGateClarification`
// (validation/charterGate.ts); this module applies it over a whole queue, so a
// caller (the D3 loop) sets each request's `disposition` in one deterministic pass.
//
// PURE + deterministic + language-neutral: no IO, no LLM, no refutation is RUN here
// — the observed refutation count per request is supplied by the caller (the
// intensity dial's adversarial rounds). Exported for phase-e reuse.

import {
  riskGateClarification,
  type CharterClarificationRequest,
} from "audit-tools/shared";

/** The two thresholds the risk gate meters against, defaulted conservatively. */
export interface RiskGateThresholds {
  /** Blast radius at/above which the higher adversarial bar applies. */
  highBlastThreshold: number;
  /** Independent refutation rounds a high-blast question must clear. */
  requiredRefutations: number;
}

/**
 * The default thresholds: a delta reaching two or more parents up the goal DAG is
 * "high blast" and must clear at least one independent refutation round before it
 * is asked interactively. Conservative — the design's central failure mode is a
 * confident-but-wrong high-blast finding, so the default errs toward `finding_only`.
 */
export const DEFAULT_RISK_GATE_THRESHOLDS: RiskGateThresholds = {
  highBlastThreshold: 2,
  requiredRefutations: 1,
};

/**
 * Apply the risk gate over a queue, returning each request with its `disposition`
 * resolved. `refutationsByRequestId` supplies the observed independent-refutation
 * count per request (default 0 — nothing refuted yet, so a high-blast question
 * stays `finding_only` until the intensity dial funds refutation rounds). The input
 * order is preserved; callers that want VOI order should `voiQueue` the result.
 */
export function applyRiskGate(
  requests: CharterClarificationRequest[],
  refutationsByRequestId: Map<string, number> = new Map(),
  thresholds: RiskGateThresholds = DEFAULT_RISK_GATE_THRESHOLDS,
): CharterClarificationRequest[] {
  return requests.map((request) => ({
    ...request,
    disposition: riskGateClarification(
      request,
      refutationsByRequestId.get(request.request_id) ?? 0,
      thresholds,
    ),
  }));
}
