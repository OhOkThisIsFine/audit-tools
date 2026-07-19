import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { writeJsonFile } from "../io/json.js";
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

/**
 * Lease TTL for a live LLM dispatch — a host-subagent wave grant or an in-process
 * packet run. Real dispatches run MINUTES, not the seconds-scale `STALE_LOCK_MS`
 * default: an expired lease stops counting toward both the pool budget AND the
 * declared-cap in-flight COUNT (`admitBatch` seeds the count from the pruned
 * snapshot), so a mid-flight expiry hands a concurrent co-located admitter a
 * double-grant window on the same account. Normal completion reconciles the lease
 * long before this TTL; it only bounds how long a CRASHED consumer's orphan lease
 * can depress headroom (20 min — the task-claims execution-lease envelope).
 */
export const DISPATCH_LEASE_TTL_MS = 20 * 60_000;

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

/**
 * One metered allowance a dispatch must fit inside. A packet is admitted only if it
 * clears EVERY constraint that applies to it — an account-wide window shared with
 * every sibling model on the credential, plus any window scoped to this model alone.
 *
 * ⚠ **`budget` and `cost` are in the WINDOW's own unit, and the caller owns the
 * conversion.** There is no unit shared across windows: a 5-hour `session` and a
 * 7-day `weekly` scale on different denominators, so the same N tokens is a
 * different fraction of each. The ledger is deliberately unit-agnostic — it only
 * compares `cost` against `budget - Σ outstanding` for one key — which is exactly
 * what lets an account-scoped window meter in the shared percent while each sibling
 * converts its own tokens at its own learned rate.
 */
export interface AdmitConstraint {
  /** The metered allowance's identity — `(accountKey, label)` for an account-wide window, `(poolId, label)` for a model-scoped one. */
  resourceKey: string;
  /** Caller-computed live remaining allowance for `resourceKey`. Non-finite ⇒ optimistic (unbounded). */
  budget: number;
  /** This dispatch's draw against `resourceKey`, in the same unit as `budget`. */
  cost: number;
}

/** How one constraint evaluated during an admission attempt. */
export interface ConstraintOutcome {
  resourceKey: string;
  /** Live budget minus `outstandingBefore` — so it carries that field's carve-out too. */
  headroomBefore: number;
  /**
   * Outstanding (non-expired) leases counted against this key when it was
   * evaluated. This is everyone else's in-flight total — PLUS any draw an earlier
   * constraint in this same attempt already made on the same key (see the
   * duplicate-key note on {@link ReservationLedger.admit}), so it is what this
   * constraint was actually measured against rather than a pure "before" reading.
   */
  outstandingBefore: number;
  /** The cost this attempt tried to reserve against this key (clamped to >= 0). */
  cost: number;
  /** Whether this constraint alone had room. Admission requires ALL to be true. */
  cleared: boolean;
}

/** Outcome of an admission attempt against every constraint that applies. */
export interface AdmitDecision {
  admitted: boolean;
  /** Minted only when `admitted`; pass back to `reconcile` on completion. */
  leaseId: string | null;
  /** Every constraint's evaluation, in input order — the per-admission explain record. */
  constraints: ConstraintOutcome[];
  /**
   * The TIGHTEST constraint — the one closest to blocking this dispatch, by the
   * dimensionless ratio `cost / headroomBefore`. This is the "binding window" a
   * report should name. Null only when no constraints were supplied.
   *
   * ⚠ Deliberately a RATIO, not the smallest `headroomBefore`. Constraints meter in
   * different windows' units, so raw headroom is not comparable across them — "40
   * left of a session window" vs "80 left of a weekly one" says nothing about which
   * binds. The ratio is dimensionless and therefore is comparable. A blocked
   * constraint always outranks a cleared one (its ratio exceeds 1), so this is also
   * independent of the order the caller supplied the constraints in.
   */
  binding: ConstraintOutcome | null;
  /**
   * Whether ANY constraint had outstanding leases against it.
   *
   * This exists because `binding.outstandingBefore` is one key's total and must
   * never be read as "is anything in flight anywhere" — the liveness backstop in
   * the rolling dispatcher needs exactly that aggregate to decide whether waiting
   * could ever help. Given as a computed boolean rather than left to the consumer
   * to derive, so the predicate cannot be reconstructed wrongly from a per-key
   * number (it was, and a blocked model window with an idle account window would
   * have force-dispatched into overshoot).
   */
  anyOutstanding: boolean;
}

export interface AdmitInput {
  /**
   * Every allowance this dispatch draws against. Admission is ALL-OR-NOTHING: one
   * lease id is recorded under each key, or none are. An empty array is admitted
   * unmetered (a lease is still minted so completion reconciles symmetrically).
   */
  constraints: AdmitConstraint[];
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

/**
 * Atomic (temp + rename, via the shared `writeJsonFile`). A truncating in-place
 * write leaves a permanently-torn ledger behind a crash mid-write, and `readLedger`
 * degrades malformed content to `{}` — i.e. "zero outstanding leases" — so the
 * failure direction is over-admission. Same fail-open class as the quota-state
 * torn read (INV-QD-15).
 */
async function writeLedger(ledgerPath: string, ledger: LedgerMap): Promise<void> {
  await writeJsonFile(ledgerPath, ledger);
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

/**
 * How close a constraint came to blocking, as a dimensionless ratio of the draw to
 * the room available for it. Comparable ACROSS windows that meter in different
 * units, which raw headroom is not. Higher = tighter; > 1 means it blocked.
 */
function tightness(outcome: ConstraintOutcome): number {
  // Order matters. A zero-cost constraint ALWAYS clears — including on an exhausted
  // window — so it must rank loosest, not tightest. Testing headroom first returned
  // +Infinity for `cost 0, headroom 0` and let a constraint that cleared outrank one
  // that actually blocked. With this order the invariant below is exact: cleared
  // ⇒ tightness <= 1 (cost <= 0 ⇒ 0, else headroom >= cost ⇒ ratio <= 1), and
  // blocked ⇒ > 1 or +Infinity.
  if (outcome.cost <= 0) return 0;
  if (outcome.headroomBefore <= 0) return Number.POSITIVE_INFINITY;
  return outcome.cost / outcome.headroomBefore;
}

/**
 * The constraint closest to blocking — what a report should name as the binding
 * window. Replaces the MIN-collapse that used to happen before the ledger was
 * reached. Ranked by {@link tightness}, so the result does not depend on the order
 * the caller listed the constraints in, and a blocked constraint always wins.
 */
function pickBinding(outcomes: ConstraintOutcome[]): ConstraintOutcome | null {
  if (outcomes.length === 0) return null;
  return outcomes.reduce((tightest, o) => {
    const a = tightness(o);
    const b = tightness(tightest);
    if (a !== b) return a > b ? o : tightest;
    // Ties are reachable (two exhausted windows both score +Infinity; equal ratios).
    // Break them on the key so the answer is a property of the ledger state, not of
    // the order the caller happened to list the constraints in.
    return o.resourceKey < tightest.resourceKey ? o : tightest;
  });
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
   * Attempt to reserve against EVERY constraint that applies to this dispatch.
   * Each is admitted iff `budget - Σ outstanding_leases(resourceKey) >= cost`, and
   * the dispatch is admitted iff every one clears — **all-or-nothing**: either one
   * lease id is recorded under each key, or nothing is written. A partial
   * reservation (fits the account window, overruns its model window) is therefore
   * unrepresentable, which is what makes `reconcile` by lease id total.
   *
   * The whole evaluation runs atomically under the lock, so concurrent admitters
   * serialize and each sees the others' in-flight reservations across every key.
   * A non-finite `budget` is unbounded (optimistic start — the reactive floor still
   * corrects); a non-positive `cost` always clears its own constraint so completion
   * still reconciles symmetrically. Every constraint is evaluated even after one
   * blocks, so the explain record shows the full picture rather than the first
   * failure.
   *
   * Two constraints on the same `resourceKey` accumulate within the attempt — the
   * second sees the first's draw as outstanding — so a caller that supplies a key
   * twice cannot double-spend one allowance.
   */
  async admit(input: AdmitInput): Promise<AdmitDecision> {
    const ttl = input.leaseTtlMs ?? this.defaultTtlMs;
    return withFileLock(this.lockPath, async () => {
      const now = this.now();
      const { ledger } = pruneExpired(await readLedger(this.ledgerPath), now);

      // Draws already committed by EARLIER constraints in this same attempt, so a
      // repeated resourceKey is metered once against its real allowance.
      const pendingByKey = new Map<string, number>();
      const outcomes: ConstraintOutcome[] = [];
      let anyOutstanding = false;
      for (const constraint of input.constraints) {
        const pending = pendingByKey.get(constraint.resourceKey) ?? 0;
        const priorOutstanding = sumOutstanding(ledger[constraint.resourceKey], now);
        if (priorOutstanding > 0) anyOutstanding = true;
        const outstandingBefore = priorOutstanding + pending;
        const budget = Number.isFinite(constraint.budget) ? constraint.budget : Number.POSITIVE_INFINITY;
        const headroomBefore = budget - outstandingBefore;
        // Normalize ONCE: the value validated against headroom, accumulated for a
        // repeated key, and persisted on the lease must be the same number. A
        // negative cost reaching the lease would subtract from the key's outstanding
        // total and manufacture headroom that does not exist for every peer.
        const cost = Number.isFinite(constraint.cost) ? Math.max(0, constraint.cost) : 0;
        outcomes.push({
          resourceKey: constraint.resourceKey,
          headroomBefore,
          outstandingBefore,
          cost,
          cleared: cost <= 0 || headroomBefore >= cost,
        });
        pendingByKey.set(constraint.resourceKey, pending + cost);
      }

      const admitted = outcomes.every((o) => o.cleared);
      const binding = pickBinding(outcomes);
      if (!admitted) {
        // Persist the prune even on a blocked admission so expired leases don't
        // linger and depress headroom for the next attempt.
        await writeLedger(this.ledgerPath, ledger);
        return { admitted: false, leaseId: null, constraints: outcomes, binding, anyOutstanding };
      }

      const leaseId = mintLeaseId();
      const expiresAt = now + ttl;
      for (const outcome of outcomes) {
        const lease: ReservationLease = { leaseId, cost: outcome.cost, poolId: input.poolId, expiresAt };
        ledger[outcome.resourceKey] = [...(ledger[outcome.resourceKey] ?? []), lease];
      }
      await writeLedger(this.ledgerPath, ledger);
      return { admitted: true, leaseId, constraints: outcomes, binding, anyOutstanding };
    });
  }

  /**
   * Free a reservation on completion (success OR failure — the request is no longer
   * in flight either way). Token-checked by `leaseId` and swept across EVERY key, so
   * a multi-constraint reservation is released in full or not at all — the caller
   * cannot leak one window's reservation by forgetting which keys it took. A no-op
   * if the lease is already gone (expired / reconciled). Returns whether anything was
   * removed. The lease's real cost surfaces in the provider's next quota snapshot;
   * the ledger's job is only to stop reserving it.
   */
  async reconcile(leaseId: string): Promise<boolean> {
    return withFileLock(this.lockPath, async () => {
      const now = this.now();
      const { ledger } = pruneExpired(await readLedger(this.ledgerPath), now);
      let removed = false;
      for (const [resourceKey, leases] of Object.entries(ledger)) {
        const remaining = leases.filter((l) => l.leaseId !== leaseId);
        if (remaining.length === leases.length) continue;
        removed = true;
        if (remaining.length > 0) ledger[resourceKey] = remaining;
        else delete ledger[resourceKey];
      }
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
