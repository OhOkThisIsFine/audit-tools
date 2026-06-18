import { z } from "zod";
import {
  ResolvedLimitsSchema,
  LimitConfidenceSchema,
  LimitSourceSchema,
  HostConcurrencyLimitSchema,
  QuotaUsageSnapshotSchema,
  BackoffStateSchema,
  WaveBindingCapSchema,
  DispatchCapacityPoolSummarySchema,
  DispatchModelTierSchema,
  HostModelRosterEntrySchema,
} from "@audit-tools/shared";

// Re-exported from @audit-tools/shared
export {
  resolveLimits,
  classifyProvider,
  readQuotaState,
  writeQuotaState,
  computeMaxSafeConcurrency,
  recordWaveOutcome,
  getQuotaStatePath,
  decayWeight,
  applyDecayToEntry,
  computeBackoffCooldownMs,
  computeBackoffFailureWeight,
  computeRampUpConcurrency,
  setQuotaStateDir,
  detectRateLimitError,
  computeCooldownUntil,
  acquireLock,
  releaseLock,
  withFileLock,
  FileLockTimeoutError,
  runSlidingWindow,
  LearnedQuotaSource,
  CompositeQuotaSource,
  GenericErrorParser,
  ClaudeCodeErrorParser,
  getErrorParserForProvider,
  summarizeDispatchCapacityPools,
} from "@audit-tools/shared";

export type {
  LimitResolutionResult,
  ResolveLimitsOptions,
  ProviderType,
  ResolvedLimits,
  LimitSource,
  LimitConfidence,
  HostConcurrencyLimit,
  HostConcurrencyLimitSource,
  QuotaState,
  QuotaStateEntry,
  ConcurrencyBucket,
  WaveSchedule,
  BackoffState,
  ObservedWaveOutcome,
  RateLimitDetectionResult,
  SlidingWindowResult,
  QuotaSource,
  QuotaUsageSnapshot,
  ErrorParser,
  WaveBindingCap,
  DispatchCapacityPoolSummary,
} from "@audit-tools/shared";

// Wave scheduler now lives in @audit-tools/shared (single source of truth for
// both orchestrators). Auditor passes its discovered-limits via the structural
// DiscoveredRateLimitsInput the shared scheduler accepts.
export { scheduleWave, buildProviderModelKey, resolveHostModel } from "@audit-tools/shared";
export type { ScheduleWaveOptions } from "@audit-tools/shared";

// Capacity model: the JIT, multi-pool-capable layer both orchestrators size
// dispatch with. Single host pool today; heterogeneous provider pools slot in
// without changing call sites.
export { computeDispatchCapacity } from "@audit-tools/shared";
export type {
  CapacityPool,
  PoolDispatchAllocation,
  DispatchCapacity,
} from "@audit-tools/shared";

// Auditor-specific: discovered limits, header extraction
export {
  detectHostActiveSubagentLimit,
  resolveHostActiveSubagentLimit,
} from "./hostLimits.js";

export {
  lookupDiscoveredLimits,
  updateDiscoveredLimits,
  mergeDiscoveredLimits,
  readDiscoveredLimitsCache,
  writeDiscoveredLimitsCache,
} from "./discoveredLimits.js";
export type { DiscoveredRateLimits, DiscoveredLimitsCache, DiscoveredLimitsCacheEntry } from "./discoveredLimits.js";

export { extractRateLimitHeaders } from "./headerExtraction.js";
export type { ExtractedRateLimits } from "./headerExtraction.js";

export type { HeaderExtractor } from "./headerExtractors/index.js";
export { GenericHeaderExtractor, ClaudeCodeHeaderExtractor, getHeaderExtractorForProvider } from "./headerExtractors/index.js";

// Auditor-only type (not in shared)
export const DISPATCH_QUOTA_V1ALPHA1 = "audit-code-dispatch-quota/v1alpha1" as const;
export const DISPATCH_QUOTA_V1ALPHA2 = "audit-code-dispatch-quota/v1alpha2" as const;

export const DispatchQuotaSchema = z
  .object({
    contract_version: z.enum([
      DISPATCH_QUOTA_V1ALPHA1,
      DISPATCH_QUOTA_V1ALPHA2,
    ]),
    run_id: z.string(),
    model: z.string().nullable(),
    resolved_limits: ResolvedLimitsSchema,
    confidence: LimitConfidenceSchema,
    source: LimitSourceSchema,
    host_concurrency_limit: HostConcurrencyLimitSchema.nullable(),
    max_concurrent_agents: z.number().int().min(1),
    cooldown_until: z.string().nullable(),
    binding_cap: WaveBindingCapSchema.optional(),
    capacity_pools: z.array(DispatchCapacityPoolSummarySchema).optional(),
    /** Echo of the host-reported model roster (lowest rank first), when given. */
    host_model_roster: z.array(HostModelRosterEntrySchema).optional(),
    /** Per-tier packet input budgets (context − output) derived from the roster. */
    tier_budgets: z.record(DispatchModelTierSchema, z.number()).optional(),
    quota_source_snapshot: QuotaUsageSnapshotSchema.nullable().optional(),
    backoff_state: BackoffStateSchema.nullable().optional(),
  })
  .strict();
export type DispatchQuota = z.infer<typeof DispatchQuotaSchema>;
