import type { AuditorSelf, SessionConfig } from "audit-tools/shared";
import {
  resolveContextBudget,
  resolveHostActiveSubagentLimit,
  resolveModelStatics,
} from "audit-tools/shared";

/**
 * Resolve the transient work-partition capacity for the current auditor draw.
 * No capability is invented: explicit block quota, the current handshake, or
 * synced models.dev metadata must provide both sides of the usable window.
 */
export function resolveCurrentWorkPartitionRuntime(
  sessionConfig: SessionConfig,
  self: AuditorSelf,
): { capacityTokens: number; availableParallelism: number | null } | null {
  const configured = sessionConfig.block_quota ?? {};
  // Model-only — see the matching note in `remediate/phases/plan.ts`. This draw
  // is the reason the routing-removal plan's finding 2 was wrong: it claimed the
  // audit side already resolved statics provider-free, and this call did not.
  const staticLimits = self.model_id
    ? resolveModelStatics(self.model_id)
    : undefined;
  const capacityCandidates = (self.roster?.length
    ? self.roster.map((entry) =>
        resolveContextBudget({
          contextTokens: configured.context_tokens ?? entry.context_tokens,
          reservedOutputTokens:
            configured.reserved_output_tokens ?? entry.output_tokens,
        }),
      )
    : [
        resolveContextBudget({
          contextTokens:
            configured.context_tokens ??
            self.context_tokens ??
            staticLimits?.context_tokens,
          reservedOutputTokens:
            configured.reserved_output_tokens ??
            self.output_tokens ??
            staticLimits?.output_tokens,
        }),
      ]).filter((budget): budget is number => budget !== null && budget > 0);
  if (capacityCandidates.length === 0) return null;

  const concurrency = resolveHostActiveSubagentLimit({
    envPrefix: "AUDIT_CODE",
    explicitLimit: self.max_active_subagents,
    sessionConfig,
  });
  return {
    capacityTokens: Math.max(...capacityCandidates),
    availableParallelism: concurrency?.active_subagents ?? null,
  };
}
