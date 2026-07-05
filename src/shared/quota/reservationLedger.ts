import { readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { withFileLock, STALE_LOCK_MS } from "./fileLock.js";
import { getQuotaStatePath } from "./state.js";

// Shared, lock-guarded token-reservation ledger — the proactive layer of the
// dispatch admission-control model (spec/audit/dispatch-admission-control.md).
// This is the ClaimRegistry pattern generalized from TASK claiming to QUOTA
// claiming: instead of `nodeId → single claim`, it holds `resourceKey → leases[]`,
// where a lease reserves an estimated token cost against a shared rate-limit meter
// BEFORE the request is dispatched. Every co-located admission loop leases against
// the SAME file, keyed by `resourceKey = provider#account/model` (the real metered
// account), so two loops on one account cannot each optimistically assume the full
// budget — each sees the others' outstanding leases and serializes on the lock.
//
// SCOPE — proactive only. This ledger is the in-flight reservation layer, NOT the
// safety floor. The always-correct floor is the REACTIVE shared backoff that
// already lives in quota-state (`cooldown_until` per `providerModelKey`, honored by
// the dispatch loop) — a 429 anyone hits collapses admission for every consumer on
// that key. The ledger only reduces co-located OVERSHOOT among consumers that see
// the same file; it is a proxy, never the meter (non-audit-tools clients on the
// same account never touch it), and must never be presented as a hard guarantee.
//
// `budget` is supplied by the caller (the live remaining tokens for the
// resourceKey, derived from the pool's quota snapshot / learned slope) — the
// ledger never discovers limits itself. It subtracts ONLY outstanding in-flight
// leases from that budget, so recorded consumption (already reflected in the
// caller's live budget) is never double-counted. On completion the lease is
// reconciled away; its real cost then surfaces in the next provider snapshot.
//
// Leases carry a TTL and expire (default `STALE_LOCK_MS`, longer for long LLM
// work): a crashed/timed-out consumer never strands budget — the expired lease
// stops counting toward outstanding and the reservation returns automatically,
// exactly mirroring the file lock's own abandoned-holder recovery.

export interface ReservationLease {
  /** Opaque token minted at admit; required to reconcile (free) the reservation. */
  leaseId: string;
  /** Reserved tokens = input estimate + output envelope. */
  cost: number;
  /** Pool the lease was taken for (diagnostic / routing — not part of identity). */
  poolId: string;
  /** Epoch ms after which the lease no longer counts toward outstanding. */
  expiresAt: number;
}

/** Outcome of an admission attempt against one resourceKey's shared budget. */
export interface AdmitDecision {
  admitted: boolean;
  /** Minted only when `admitted`; pass back to `reconcile` on completion. */
  leaseId: string | null;
  /** Live budget minus everyone's outstanding leases, BEFORE this attempt. */
  headroomBefore: number;
  /** Sum of everyone's outstanding (non-expired) leases, BEFORE this attempt. */
  outstandingBefore: number;
  /** The cost this attempt tried to reserve (echoed for the explain-artifact). */
  cost: number;
}

export interface AdmitInput {
  /** `provider#account/model` — the real metered account the budget belongs to. */
  resourceKey: string;
  /** Total reservation: input estimate + output envelope. */
  cost: number;
  /** Caller-computed live remaining tokens for `resourceKey`. Non-finite ⇒ optimistic (unbounded). */
  budget: number;
  /** Pool id for diagnostics. */
  poolId: string;
  /** Lease lifetime in ms; defaults to the ledger's TTL. */
  leaseTtlMs?: number;
}

type LedgerMap = Record<string, ReservationLease[]>;

function mintLeaseId(): string {
  return `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function isLease(value: unknown): value is ReservationLease {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.leaseId === "string" &&
    typeof obj.cost === "number" &&
    Number.isFinite(obj.cost) &&
    typeof obj.poolId === "string" &&
    typeof obj.expiresAt === "number" &&
    Number.isFinite(obj.expiresAt)
  );
}

// Read the ledger, degrading ANY malformed/absent state to an empty map. A corrupt
// ledger must never throw into the dispatch loop — at worst a reservation is missed
// (over-admission), which the reactive floor still catches. Only well-formed leases
// are retained; junk is dropped silently.
async function readLedger(ledgerPath: string): Promise<LedgerMap> {
  let raw: string;
  try {
    raw = await readFile(ledgerPath, "utf8");
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: LedgerMap = {};
  for (const [resourceKey, leases] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Array.isArray(leases)) continue;
    const kept = leases.filter(isLease);
    if (kept.length > 0) out[resourceKey] = kept;
  }
  return out;
}

async function writeLedger(ledgerPath: string, ledger: LedgerMap): Promise<void> {
  await mkdir(dirname(ledgerPath), { recursive: true });
  await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
}

/** Sum of non-expired leases for a key. Expired leases (crashed consumers) don't count. */
function sumOutstanding(leases: ReservationLease[] | undefined, now: number): number {
  if (!leases) return 0;
  let total = 0;
  for (const lease of leases) {
    if (lease.expiresAt > now) total += lease.cost;
  }
  return total;
}

/** Drop expired leases from every key, returning the trimmed map and how many were dropped. */
function pruneExpired(ledger: LedgerMap, now: number): { ledger: LedgerMap; dropped: number } {
  let dropped = 0;
  const out: LedgerMap = {};
  for (const [resourceKey, leases] of Object.entries(ledger)) {
    const live = leases.filter((l) => l.expiresAt > now);
    dropped += leases.length - live.length;
    if (live.length > 0) out[resourceKey] = live;
  }
  return { ledger: out, dropped };
}

/**
 * File-backed token-reservation ledger. The caller owns the path (and may point
 * two dispatch loops at the same file — that is the whole point: shared account
 * budget across co-located consumers). Every mutating op runs its entire
 * read-modify-write inside `withFileLock(ledgerPath + '.lock')`, so
 * reserve-before-dispatch is atomic across processes and optimistic estimates
 * cannot multiply across consumers.
 *
 * The default lease TTL is the file lock's `STALE_LOCK_MS` but is per-op
 * overridable (`leaseTtlMs`): a lease guarding a long LLM dispatch needs a longer
 * lifetime than a short state mutation, so a genuinely in-flight request is never
 * treated as expired mid-flight.
 */
export class ReservationLedger {
  private readonly lockPath: string;
  private readonly defaultTtlMs: number;

  constructor(
    private readonly ledgerPath: string,
    private readonly now: () => number = () => Date.now(),
    defaultTtlMs: number = STALE_LOCK_MS,
  ) {
    this.lockPath = `${ledgerPath}.lock`;
    this.defaultTtlMs = defaultTtlMs;
  }

  /**
   * Attempt to reserve `cost` tokens against `resourceKey`'s shared budget.
   * Admitted iff `budget - Σ outstanding_leases(resourceKey) >= cost`, evaluated
   * atomically under the lock so concurrent admitters serialize and each sees the
   * others' in-flight reservations. A non-finite `budget` is treated as unbounded
   * (optimistic start — the reactive floor still corrects). A non-positive `cost`
   * is always admitted with a lease so completion still reconciles symmetrically.
   * The returned `headroomBefore`/`outstandingBefore`/`cost` feed the per-admission
   * explain record on the dispatch-quota artifact.
   */
  async admit(input: AdmitInput): Promise<AdmitDecision> {
    const ttl = input.leaseTtlMs ?? this.defaultTtlMs;
    return withFileLock(this.lockPath, async () => {
      const now = this.now();
      const { ledger } = pruneExpired(await readLedger(this.ledgerPath), now);
      const outstandingBefore = sumOutstanding(ledger[input.resourceKey], now);
      const budget = Number.isFinite(input.budget) ? input.budget : Number.POSITIVE_INFINITY;
      const headroomBefore = budget - outstandingBefore;
      const cost = Number.isFinite(input.cost) ? input.cost : 0;
      const admitted = cost <= 0 || headroomBefore >= cost;
      if (!admitted) {
        // Persist the prune even on a blocked admission so expired leases don't
        // linger and depress headroom for the next attempt.
        await writeLedger(this.ledgerPath, ledger);
        return { admitted: false, leaseId: null, headroomBefore, outstandingBefore, cost };
      }
      const leaseId = mintLeaseId();
      const lease: ReservationLease = {
        leaseId,
        cost,
        poolId: input.poolId,
        expiresAt: now + ttl,
      };
      ledger[input.resourceKey] = [...(ledger[input.resourceKey] ?? []), lease];
      await writeLedger(this.ledgerPath, ledger);
      return { admitted: true, leaseId, headroomBefore, outstandingBefore, cost };
    });
  }

  /**
   * Free a reservation on completion (success OR failure — the request is no longer
   * in flight either way). Token-checked by `leaseId`: a no-op if the lease is
   * already gone (expired / reconciled). Returns whether a lease was removed. The
   * lease's real cost surfaces in the provider's next quota snapshot; the ledger's
   * job is only to stop reserving it.
   */
  async reconcile(resourceKey: string, leaseId: string): Promise<boolean> {
    return withFileLock(this.lockPath, async () => {
      const now = this.now();
      const { ledger } = pruneExpired(await readLedger(this.ledgerPath), now);
      const leases = ledger[resourceKey];
      if (!leases) {
        await writeLedger(this.ledgerPath, ledger);
        return false;
      }
      const remaining = leases.filter((l) => l.leaseId !== leaseId);
      const removed = remaining.length !== leases.length;
      if (remaining.length > 0) ledger[resourceKey] = remaining;
      else delete ledger[resourceKey];
      await writeLedger(this.ledgerPath, ledger);
      return removed;
    });
  }

  /** Sum of outstanding (non-expired) reservations for `resourceKey`. Read under the lock. */
  async outstanding(resourceKey: string): Promise<number> {
    return withFileLock(this.lockPath, async () => {
      const now = this.now();
      const ledger = await readLedger(this.ledgerPath);
      return sumOutstanding(ledger[resourceKey], now);
    });
  }

  /**
   * Drop every expired lease across all keys, returning how many were freed. Admit
   * prunes lazily, but a long-idle ledger (all consumers gone) benefits from an
   * explicit sweep so a later reader doesn't see stale reservations.
   */
  async reclaimExpired(): Promise<number> {
    return withFileLock(this.lockPath, async () => {
      const now = this.now();
      const { ledger, dropped } = pruneExpired(await readLedger(this.ledgerPath), now);
      if (dropped > 0) await writeLedger(this.ledgerPath, ledger);
      return dropped;
    });
  }

  /**
   * Snapshot of all LIVE (non-expired) leases keyed by resourceKey, for the
   * dispatch-quota explain-artifact. Read under the lock; expired leases are
   * omitted (they no longer bind budget).
   */
  async snapshot(): Promise<LedgerMap> {
    return withFileLock(this.lockPath, async () => {
      const now = this.now();
      const { ledger } = pruneExpired(await readLedger(this.ledgerPath), now);
      return ledger;
    });
  }
}

/**
 * Canonical reservation-ledger path — SINGLE-SOURCED so every co-located consumer
 * (audit host grant, remediate host grant, the in-process rolling engine, a second
 * IDE's run) leases against the SAME file and therefore shares one account budget.
 * Sits beside the learned quota-state file (the same user-scoped quota dir), so it
 * inherits `setQuotaStateDir` redirection in tests and per-user isolation in prod.
 */
export function getReservationLedgerPath(): string {
  // Degrade-safe: when the quota-state dir is not configured (never throws into
  // dispatch), fall back to a per-process temp path. Co-located coordination needs
  // the shared quota dir; without it (a misconfigured/unit context) the ledger still
  // functions locally — the reactive 429 floor remains the always-correct backstop.
  try {
    return join(dirname(getQuotaStatePath()), "reservations.json");
  } catch {
    return join(tmpdir(), `audit-tools-reservations-${process.pid}.json`);
  }
}

/** Construct a ReservationLedger at the canonical shared path. */
export function createReservationLedger(): ReservationLedger {
  return new ReservationLedger(getReservationLedgerPath());
}
