/**
 * The ONE dispatch-quota contract + emit core (unified-routing step H5).
 *
 * Replaces the kept-in-parity fork: audit's `DispatchQuota` (zod, literally
 * annotated "Auditor-only type (not in shared)") vs remediate's
 * `RemediationDispatchQuota` (compile-time only) — 12 identical fields maintained
 * as two, with two version literals and two character-for-character emit wrappers
 * (`finalizeDispatchQuota` ≡ `buildDispatchQuota`, the latter even commented
 * "Mirrors audit's finalizeDispatchQuota"). One shared, runtime-validated contract
 * with optional per-mode extensions; each orchestrator keeps only its thin
 * assembly policy (audit: capacity fold + fanout/capable; remediate: schedule +
 * phase), never the contract or the admission math.
 */

import { z } from "zod";
import type { ReservationLedger } from "../quota/reservationLedger.js";
import {
  DispatchAdmissionSchema,
  computeDispatchAdmission,
  type AdmissionPool,
  type AdmissionCandidate,
} from "./admissionLoop.js";
import {
  DispatchCapacityPoolSummarySchema,
} from "../quota/capacity.js";
import {
  LimitConfidenceSchema,
  LimitSourceSchema,
  HostConcurrencyLimitSchema,
  ResolvedLimitsSchema,
  WaveBindingCapSchema,
  BackoffStateSchema,
} from "../quota/types.js";
import { HostModelRosterEntrySchema } from "../quota/scheduler.js";
import { QuotaUsageSnapshotSchema } from "../quota/quotaSource.js";
import { DispatchModelTierSchema, type DispatchModelTier } from "../types/stepContract.js";

/** The single contract version — both orchestrators emit and validate this. */
export const DISPATCH_QUOTA_CONTRACT_VERSION = "dispatch-quota/v1" as const;

export const DispatchQuotaContractSchema = z
  .object({
    contract_version: z.literal(DISPATCH_QUOTA_CONTRACT_VERSION),
    run_id: z.string(),
    model: z.string().nullable(),
    resolved_limits: ResolvedLimitsSchema,
    confidence: LimitConfidenceSchema,
    source: LimitSourceSchema,
    host_concurrency_limit: HostConcurrencyLimitSchema.nullable(),
    /**
     * Admission control: the tool GRANTS the affordable admitted set
     * (cost-first-capable, ledger-leased) — the granted set's size is the emergent
     * admission width. See spec/audit/dispatch-admission-control.md.
     */
    admission: DispatchAdmissionSchema,
    cooldown_until: z.string().nullable(),
    binding_cap: WaveBindingCapSchema.optional(),
    capacity_pools: z.array(DispatchCapacityPoolSummarySchema).optional(),
    quota_source_snapshot: QuotaUsageSnapshotSchema.nullable().optional(),
    backoff_state: BackoffStateSchema.nullable().optional(),
    // ── per-mode optional extensions (one contract, two draws) ──────────────
    /** AUDIT: echo of the host-reported model roster (lowest rank first). */
    host_model_roster: z.array(HostModelRosterEntrySchema).optional(),
    /** AUDIT: per-tier packet input budgets (context − output) from the roster. */
    tier_budgets: z.record(DispatchModelTierSchema, z.number()).optional(),
    /** REMEDIATE: which dispatch phase this quota governs. */
    phase: z.string().optional(),
    /** REMEDIATE: the wave's total estimated tokens. */
    estimated_wave_tokens: z.number().optional(),
  })
  .strict();
export type DispatchQuotaContract = z.infer<typeof DispatchQuotaContractSchema>;

/**
 * The shared emit core: run admission over the caller's pool set and assemble the
 * validated contract. The caller supplies its resolved base fields + per-mode
 * extensions; the admission math and the contract shape live HERE, once.
 */
export async function assembleDispatchQuota(params: {
  runId: string;
  pools: AdmissionPool[];
  packets: { id: string; inputTokens: number; complexity: number; requiredTier?: DispatchModelTier }[];
  outputCap: number;
  grantLeases: boolean;
  ledger: ReservationLedger;
  capable?: (pool: AdmissionPool, packet: AdmissionCandidate) => boolean;
  dispatchBias?: number;
  base: Omit<DispatchQuotaContract, "contract_version" | "run_id" | "admission">;
}): Promise<DispatchQuotaContract> {
  const admission = await computeDispatchAdmission({
    packets: params.packets,
    pools: params.pools,
    outputCap: params.outputCap,
    grantLeases: params.grantLeases,
    ledger: params.ledger,
    ...(params.capable ? { capable: params.capable } : {}),
    ...(params.dispatchBias != null ? { dispatchBias: params.dispatchBias } : {}),
  });
  return DispatchQuotaContractSchema.parse({
    contract_version: DISPATCH_QUOTA_CONTRACT_VERSION,
    run_id: params.runId,
    admission,
    ...params.base,
  });
}
