import type { ArtifactBundle } from "../io/artifacts.js";
import type { ExecutorRunResult } from "./executorResult.js";
import type { CriticalFlowFallbackResult } from "audit-tools/shared";
import { CriticalFlowFallbackResultSchema } from "audit-tools/shared";

/**
 * Persist the host-authored critical-flow fallback submission (the LLM pass that
 * fires when deterministic flow inference marked itself below the confidence bar)
 * as the durable `critical-flow-fallback.json` artifact — an UPSTREAM input to
 * critical_flows. This executor does NOT enrich critical_flows itself: writing the
 * submission re-stales critical_flows so the structure phase rebuilds it (and its
 * risk_register sibling) atomically off the merged flows on the next fold, which
 * is what avoids a post-hoc-rewrite clobber loop.
 *
 * A malformed/absent submission degrades to an empty enrichment (the host was
 * given the review turn and returned nothing) rather than throwing, so the
 * obligation always makes progress and never spins.
 */
export function runCriticalFlowFallbackExecutor(
  bundle: ArtifactBundle,
  submission?: CriticalFlowFallbackResult,
): ExecutorRunResult {
  const parsed = CriticalFlowFallbackResultSchema.safeParse(submission);
  const fallback: CriticalFlowFallbackResult = parsed.success
    ? parsed.data
    : { flows: [] };
  if (!parsed.success) {
    process.stderr.write(
      `[audit-code] criticalFlowFallback: host submission did not conform (${parsed.error.issues[0]?.message ?? "schema mismatch"}); recording an empty enrichment\n`,
    );
  }

  return {
    updated: {
      ...bundle,
      critical_flow_fallback: fallback,
    },
    artifacts_written: ["critical-flow-fallback.json"],
    progress_summary: `Recorded host critical-flow fallback enrichment (${fallback.flows.length} flow(s)); structure will merge on the next fold.`,
  };
}
