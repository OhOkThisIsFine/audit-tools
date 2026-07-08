/**
 * `audit-tools/shared/repair/brokeredDispatch.ts` — the F3<->F4 / O3<->F4
 * dispatch-broker SEAM (F4: dispatch-broker-and-driver).
 *
 * This is the single, pre-shipped interface that lands FIRST so the consumer
 * modules compile against it: F3 (schema-enforced-generation) calls the broker
 * at emit, and O3 (emit-validate-repair) issues its stage-2 LLM patch and
 * stage-3 re-dispatch ONLY through the broker (see the broker-handle edge in
 * docs/backlog-remediation-design.md §"broker handle (O3<->F4)"). No
 * seam consumer ever calls `scheduleWave` / a provider directly — every dispatch
 * decision flows through this single gated chokepoint so quota reads, the
 * deterministic-local token estimate, the over-budget refusal, and the
 * await-completion handoff cannot drift between the two halves of the pipeline.
 *
 * The contract here is intentionally provider/model/OS-agnostic: it names no
 * model, reads no environment beyond what the caller supplies, and computes its
 * token estimate deterministically and locally (never an API token-count call).
 * The concrete broker is `createBrokeredRepairDispatch` below; it is backed by
 * the shared wave scheduler (`scheduleWave`) so the broker's sizing math is the
 * SAME math the dispatch CLIs use — there is one wave-scheduling authority.
 */
import type { ResolvedProviderName, SessionConfig } from '../types/sessionConfig.js';
import type {
  HostConcurrencyLimit,
  QuotaStateEntry,
  ResolvedLimits,
  WaveBindingCap,
  WaveSchedule,
} from '../quota/types.js';
import type { QuotaUsageSnapshot } from '../quota/quotaSource.js';
import type { DiscoveredRateLimitsInput } from '../quota/scheduler.js';
import { scheduleWave, classifyProvider } from '../quota/scheduler.js';
import { estimateTokensFromBytes, ESTIMATED_PROMPT_OVERHEAD_TOKENS } from '../tokens.js';
import { resolveContextBudget } from '../tokens.js';
import { getQuotaStatePath, readQuotaStateForUpdate, writeQuotaState } from '../quota/state.js';
import { withFileLock } from '../quota/fileLock.js';

/**
 * One unit of work the broker is asked to dispatch. The broker derives a
 * deterministic-local token estimate from `payload_bytes` (never an API
 * token-count) plus a fixed prompt overhead, so identical input always sizes
 * identically regardless of provider/OS.
 */
export interface BrokeredDispatchSlot {
  /** Stable id of the slot (node id / result id), echoed back on completion. */
  slotId: string;
  /** Raw byte size of the slot's prompt payload; drives the local estimate. */
  payloadBytes: number;
}

/** Why the broker refused (or partially admitted) a requested dispatch. */
export type BrokerAdmission = 'admitted' | 'refused_over_budget' | 'cooldown';

/**
 * The single brokered dispatch decision. Built from the shared wave schedule so
 * `max_concurrent` / `binding_cap` / `cooldown_until` carry the identical
 * semantics as everywhere else in the quota subsystem.
 */
export interface BrokeredDispatchDecision {
  /** How many slots the broker admitted this wave (0 when refused/cooled). */
  admitted: number;
  /** Admission verdict; `refused_over_budget` ⟹ admitted === 0. */
  admission: BrokerAdmission;
  /** The slot ids admitted (a prefix of the requested slots), in input order. */
  admittedSlotIds: string[];
  /** Deterministic-local token estimate for the admitted slots. */
  estimatedWaveTokens: number;
  /** Persisted cooldown timestamp (ISO) when the pool is cooling, else null. */
  cooldownUntil: string | null;
  /** Which cap bound the decision (mirrors WaveSchedule.binding_cap). */
  bindingCap: WaveBindingCap;
  /** Whether the host was classified capable (above the cold-start floor). */
  capableHost: boolean;
  /** The full underlying wave schedule (for callers that need the detail). */
  schedule: WaveSchedule;
}

/**
 * Per-slot completion the broker hands BACK to O3 unchanged. The broker does no
 * validation of its own — `awaitNextCompletion` returns the RAW worker result so
 * O3's single canonical validator is the only authority (broker-handle edge).
 */
export interface BrokeredCompletion {
  slotId: string;
  /** The raw, unvalidated worker result payload. */
  rawResult: unknown;
}

/**
 * Inputs for one brokered dispatch decision. Everything-agnostic: the caller
 * supplies provider/session/host context; the broker reads quota, sizes the
 * wave, and refuses over-budget — it never names a model or shells out itself.
 */
export interface BrokerDispatchInput {
  providerName: ResolvedProviderName;
  sessionConfig: SessionConfig;
  hostModel: string | null;
  /** Work to dispatch, in priority order. */
  slots: BrokeredDispatchSlot[];
  /** Learned quota state for the pool (carries the persisted cooldown_until). */
  quotaStateEntry?: QuotaStateEntry | null;
  /** Host-reported active-subagent ceiling, if known. */
  hostConcurrencyLimit?: HostConcurrencyLimit | null;
  /** Live remaining-quota snapshot (strongest signal), if probed. */
  quotaSourceSnapshot?: QuotaUsageSnapshot | null;
  /** Discovered RPM/TPM/window from provider query or header extraction. */
  discoveredLimits?: DiscoveredRateLimitsInput | null;
}

/**
 * The pre-shipped F3<->F4 / O3<->F4 seam. F4's concrete broker implements it;
 * F3 and O3 depend ONLY on this interface so they compile before the broker's
 * internals are finalized and cannot reach around it to a provider.
 */
export interface BrokeredRepairDispatch {
  /**
   * Make ONE gated dispatch decision: read quota → deterministic-local estimate
   * → refuse-over-budget → admit a sized wave. Pure with respect to its inputs;
   * any cooldown to persist is returned on the decision (caller persists it
   * through the quota state, single-sourced).
   */
  broker(input: BrokerDispatchInput): BrokeredDispatchDecision;
  /**
   * Hand the next raw worker completion back to the caller (O3) for validation.
   * The broker performs NO validation — the raw result flows straight through.
   */
  awaitNextCompletion(completion: BrokeredCompletion): BrokeredCompletion;
}

/**
 * Deterministic-local per-slot token estimate: byte-derived estimate plus a
 * fixed prompt overhead. Never an API token-count call (token estimates stay
 * local + deterministic — see ~/.claude policy).
 */
export function estimateSlotTokens(slot: BrokeredDispatchSlot): number {
  return estimateTokensFromBytes(slot.payloadBytes) + ESTIMATED_PROMPT_OVERHEAD_TOKENS;
}

/**
 * Classify whether a host is "capable" — i.e. it advertises real concurrency
 * head-room ABOVE the conservative cold-start (first-contact) floor. On first
 * contact, with no learned evidence and no reported host ceiling, a host sits AT
 * the floor and is NOT yet capable; once it reports an active-subagent ceiling
 * (or learned evidence lifts the cap) above the floor, it is. Single-sourced
 * here so both halves classify identically off the SAME floor.
 */
export function classifyCapableHost(input: {
  providerName: ResolvedProviderName;
  sessionConfig: SessionConfig;
  hostConcurrencyLimit?: HostConcurrencyLimit | null;
  quotaStateEntry?: QuotaStateEntry | null;
}): boolean {
  // Cold-start floor comes from the single classifier struct (CE-005) — there is
  // no separable floor constant to re-derive it from. (The former
  // `quota.first_contact_concurrency` override was removed with the invented
  // scheduler caps; concurrency is now governed by the host limit + token-budget
  // gate, and this floor serves only the capable-vs-cold host classification.)
  const floor = Math.max(1, classifyProvider(input.providerName).concurrencyFloor);
  const reported = input.hostConcurrencyLimit?.active_subagents ?? null;
  if (reported != null && reported > floor) return true;
  // Learned evidence (any recorded safe bucket) lifts the host off the floor.
  const buckets = input.quotaStateEntry?.buckets ?? {};
  for (const key of Object.keys(buckets)) {
    const c = Number(key);
    if (Number.isFinite(c) && c > floor) return true;
  }
  return false;
}

/**
 * The over-budget gate: an admitted wave's estimated tokens must fit the pool's
 * usable context budget (resolved window − reserved output, safety-scaled). A
 * single slot that alone exceeds the budget is refused (admitted === 0) rather
 * than dispatched to certain truncation.
 */
function fitWaveToBudget(
  slots: BrokeredDispatchSlot[],
  maxConcurrent: number,
  limits: ResolvedLimits,
): { admittedSlots: BrokeredDispatchSlot[]; estimatedTokens: number; refused: boolean } {
  const budget = resolveContextBudget({
    contextTokens: limits.context_tokens,
    reservedOutputTokens: limits.output_tokens,
  });
  const cap = Math.max(0, Math.min(maxConcurrent, slots.length));
  const admitted: BrokeredDispatchSlot[] = [];
  let total = 0;
  for (let i = 0; i < cap; i++) {
    const slotTokens = estimateSlotTokens(slots[i]);
    if (total + slotTokens > budget) break;
    admitted.push(slots[i]);
    total += slotTokens;
  }
  // Refused-over-budget: even the highest-priority single slot cannot fit.
  const refused = admitted.length === 0 && slots.length > 0;
  return { admittedSlots: admitted, estimatedTokens: total, refused };
}

/**
 * Pool key for the broker's cooldown registry: `provider/<model|*>`, the same
 * `provider/<model>` convention the quota state file uses. Single-sourced here so
 * a cooldown persisted on one decision is read back on the next for the SAME
 * provider+model pool (inv-5 → inv-6).
 */
function brokerPoolKey(providerName: ResolvedProviderName, hostModel: string | null): string {
  return `${providerName}/${hostModel && hostModel.length > 0 ? hostModel : '*'}`;
}

/** Whether an ISO cooldown timestamp is still in the future relative to now. */
function cooldownActive(cooldownUntil: string | null | undefined): boolean {
  if (!cooldownUntil) return false;
  const t = new Date(cooldownUntil).getTime();
  return Number.isFinite(t) && t > Date.now();
}

/**
 * Fire-and-forget durable persistence of a pool cooldown to the on-disk quota
 * state, guarded by the same shared file lock the quota subsystem uses. This is
 * intentionally NOT awaited by `broker()` so the broker keeps its synchronous
 * signature (inv-5 must not turn `broker()` into a Promise — a sibling sync test
 * reads `result.estimatedWaveTokens` synchronously). The in-memory registry below
 * is the authoritative in-process readback; this write makes the cooldown survive
 * across processes. Any failure (no state dir configured, unreadable state) is
 * swallowed: persistence is best-effort and must never reject unhandled.
 */
function persistPoolCooldownBestEffort(poolKey: string, cooldownUntil: string): void {
  let lockPath: string;
  try {
    lockPath = getQuotaStatePath() + '.lock';
  } catch {
    // Quota state dir not configured (e.g. unit context) → nothing to persist to.
    return;
  }
  void withFileLock(lockPath, async () => {
    const state = await readQuotaStateForUpdate("persistPoolCooldown");
    const existing = state.entries[poolKey];
    const entry: QuotaStateEntry = existing ?? {
      updated_at: new Date().toISOString(),
      buckets: {},
      cooldown_until: null,
      last_429_at: null,
    };
    // Keep the later of any already-persisted cooldown and this one.
    const prior = entry.cooldown_until ? new Date(entry.cooldown_until).getTime() : 0;
    const next = new Date(cooldownUntil).getTime();
    if (!Number.isFinite(prior) || next > prior) {
      entry.cooldown_until = cooldownUntil;
    }
    entry.updated_at = new Date().toISOString();
    state.entries[poolKey] = entry;
    await writeQuotaState(state);
  }).catch(() => {
    // Best-effort: durability failure must not surface from a sync decision.
  });
}

/**
 * Create the concrete broker. The single gated chokepoint: it sizes the wave
 * through the shared `scheduleWave` (one wave-scheduling authority), enforces the
 * over-budget refusal, surfaces the persisted cooldown, classifies the host off
 * the cold-start floor, and passes raw completions straight through to O3.
 *
 * inv-5/inv-6 cooldown persistence: when a real-time snapshot drives the schedule
 * into cooldown (remaining_pct<CRITICAL → throttle to 1 + cooldown_until), the
 * broker records that cooldown — synchronously in an in-process per-pool registry
 * AND best-effort to durable quota state — WITHIN the same decision. A later
 * decision with a transiently-null snapshot reads the registered cooldown back
 * (merged into the effective quota-state entry) so `scheduleWave`'s existing
 * active-cooldown path keeps the wave throttled to 1. All of this happens without
 * making `broker()` asynchronous.
 */
export function createBrokeredRepairDispatch(): BrokeredRepairDispatch {
  // In-process, synchronous cooldown registry keyed by `provider/<model|*>`. This
  // is the authoritative readback inside one broker instance; disk persistence is
  // an additional best-effort durability layer (see persistPoolCooldownBestEffort).
  const cooldownRegistry = new Map<string, string>();

  return {
    broker(input: BrokerDispatchInput): BrokeredDispatchDecision {
      const poolKey = brokerPoolKey(input.providerName, input.hostModel ?? null);

      // inv-6: fold any registered (previously persisted) cooldown into the
      // effective quota-state entry so scheduleWave's active-cooldown path keeps
      // the wave at 1 even when this decision's snapshot is transiently null.
      const registered = cooldownRegistry.get(poolKey) ?? null;
      let effectiveQuotaStateEntry = input.quotaStateEntry ?? null;
      if (cooldownActive(registered)) {
        const suppliedActive = cooldownActive(effectiveQuotaStateEntry?.cooldown_until);
        const supplied = suppliedActive ? effectiveQuotaStateEntry!.cooldown_until : null;
        const merged =
          supplied && new Date(supplied).getTime() >= new Date(registered!).getTime()
            ? supplied
            : registered!;
        effectiveQuotaStateEntry = effectiveQuotaStateEntry
          ? { ...effectiveQuotaStateEntry, cooldown_until: merged }
          : {
              updated_at: new Date().toISOString(),
              buckets: {},
              cooldown_until: merged,
              last_429_at: null,
            };
      } else if (registered) {
        // Registered cooldown has expired → drop it so it cannot linger.
        cooldownRegistry.delete(poolKey);
      }

      const estimatedSlotTokens = input.slots.map(estimateSlotTokens);
      const schedule = scheduleWave({
        providerName: input.providerName,
        sessionConfig: input.sessionConfig,
        hostModel: input.hostModel,
        requestedConcurrency: Math.max(1, input.slots.length),
        estimatedSlotTokens,
        quotaStateEntry: effectiveQuotaStateEntry,
        hostConcurrencyLimit: input.hostConcurrencyLimit ?? null,
        quotaSourceSnapshot: input.quotaSourceSnapshot ?? null,
        discoveredLimits: input.discoveredLimits ?? null,
      });

      // inv-5: persist the cooldown surfaced by THIS decision — synchronously into
      // the in-process registry (authoritative readback) and best-effort to disk —
      // so a subsequent null-snapshot decision stays throttled.
      if (cooldownActive(schedule.cooldown_until)) {
        cooldownRegistry.set(poolKey, schedule.cooldown_until!);
        persistPoolCooldownBestEffort(poolKey, schedule.cooldown_until!);
      }

      const capableHost = classifyCapableHost({
        providerName: input.providerName,
        sessionConfig: input.sessionConfig,
        hostConcurrencyLimit: input.hostConcurrencyLimit ?? null,
        quotaStateEntry: input.quotaStateEntry ?? null,
      });

      const { admittedSlots, estimatedTokens, refused } = fitWaveToBudget(
        input.slots,
        schedule.max_concurrent,
        schedule.resolved_limits,
      );

      let admission: BrokerAdmission;
      if (refused) {
        admission = 'refused_over_budget';
      } else if (schedule.cooldown_until && admittedSlots.length === 0) {
        admission = 'cooldown';
      } else {
        admission = 'admitted';
      }

      return {
        admitted: admittedSlots.length,
        admission,
        admittedSlotIds: admittedSlots.map((s) => s.slotId),
        estimatedWaveTokens: estimatedTokens,
        cooldownUntil: schedule.cooldown_until,
        bindingCap: schedule.binding_cap ?? 'none',
        capableHost,
        schedule,
      };
    },

    awaitNextCompletion(completion: BrokeredCompletion): BrokeredCompletion {
      // The broker holds NO artifact-tree lock and does NO validation — O3's
      // single canonical validator is the only authority. Pass the raw result
      // straight through (broker-handle edge: O3<->F4).
      return completion;
    },
  };
}
