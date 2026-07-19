import type { AdmitConstraint } from "./reservationLedger.js";
import type { QuotaWindowScope } from "./quotaSource.js";
import type { WindowBudget } from "./types.js";

// The one place that turns a pool's per-window allowances into ledger constraints.
//
// Both admission paths go through here — the host grant (`admissionLoop`) and the
// in-process rolling engine (`rollingDispatch`). That is deliberate: the metering
// PARTITION is decided at the producer (`WindowBudget.scope` and
// `CapacityPool.accountKey`) and merely CARRIED here, because the moment a call site
// composes its own resource key from pool identity it is re-deriving the partition —
// which is what five refused repair rounds each did differently and each got wrong.
//
// (`rollingDispatch` keeps a literal single-constraint fallback for the case where no
// resolver is wired at all; that is an absence-of-config path, not a second
// derivation.)

/**
 * The ledger key one window meters against.
 *
 *  - `account` → `(accountKey, label)`: ONE allowance shared by every model on the
 *    credential. `accountKey` comes from the PRODUCER (`CapacityPool.accountKey`,
 *    set from the source declaration) — it is deliberately NOT derived here from
 *    `poolId`, because an explicitly declared `source.id` is returned verbatim as the
 *    pool key and carries no recoverable credential. Parsing it back out is what kept
 *    the motivating `nim-nano`/`nim-super` case broken across five rounds.
 *  - `model` → `(poolId, label)`: applies to this model alone; sharing it would
 *    falsely throttle siblings the limit does not cover.
 *
 * ⚠ The two are NAMESPACED (`acct:` / `pool:`). Without that they collide whenever
 * `accountKey === poolId` — which is exactly the unattributable-source fallback — and
 * an account-scoped and a model-scoped window sharing a label would silently meter as
 * one allowance, destroying the partition on the pool class that most needs it.
 */
export function windowResourceKey(
  scope: QuotaWindowScope,
  label: string,
  poolId: string,
  accountKey: string,
): string {
  return scope === "account" ? `acct:${accountKey}::${label}` : `pool:${poolId}::${label}`;
}

/**
 * What `tokens` costs against one window, in that window's own unit. Returns null
 * when the window cannot price the draw — a `percent` window whose learned slope is
 * missing or non-positive. A null must never be silently treated as free: the caller
 * drops the whole pool to the cold-start path rather than admitting unmetered.
 */
export function windowCost(window: WindowBudget, tokens: number): number | null {
  const draw = Math.max(0, tokens);
  if (window.unit === "tokens") return draw;
  const slope = window.tokensPerPct;
  if (typeof slope !== "number" || !Number.isFinite(slope) || slope <= 0) return null;
  return draw / slope;
}

/**
 * Build the constraint array a packet of `tokens` must clear to be admitted on this
 * pool — one constraint per window, all-or-nothing at the ledger.
 *
 * An EMPTY `windows` list falls back to a single pool-keyed constraint carrying
 * `fallbackBudget` — the no-live-signal case (no snapshot, or the cooldown path where
 * derivation is skipped). ⚠ The fallback MUST be the pool's own scalar budget, not
 * `+Infinity`: a caller still holding a finite `remaining_token_budget` would
 * otherwise have its ceiling silently discarded and over-admit. In production the two
 * coincide (no windows ⇒ null budget ⇒ unbounded), so this is the belt that stops a
 * future divergence from failing open.
 *
 * A window that cannot price the draw is DROPPED from the array and reported in
 * `unpriced`, so the caller can refuse rather than admit against a partial set —
 * silently omitting it would meter the packet against fewer allowances than apply to
 * it, which is the fail-open direction.
 */
export interface PoolConstraintResolution {
  constraints: AdmitConstraint[];
  /**
   * Windows that apply to the packet but could not price it. NON-EMPTY MEANS REFUSE:
   * admitting on `constraints` alone would meter the packet against fewer allowances
   * than actually bind it.
   */
  unpriced: WindowBudget[];
}

export function windowConstraintsFor(
  poolId: string,
  accountKey: string,
  windows: WindowBudget[] | undefined,
  tokens: number,
  fallbackBudget: number = Number.POSITIVE_INFINITY,
): PoolConstraintResolution {
  if (!windows || windows.length === 0) {
    return {
      constraints: [{ resourceKey: poolId, budget: fallbackBudget, cost: Math.max(0, tokens) }],
      unpriced: [],
    };
  }
  const constraints: AdmitConstraint[] = [];
  const unpriced: WindowBudget[] = [];
  for (const window of windows) {
    const cost = windowCost(window, tokens);
    if (cost === null) {
      unpriced.push(window);
      continue;
    }
    constraints.push({
      resourceKey: windowResourceKey(window.scope, window.label, poolId, accountKey),
      budget: window.budget,
      cost,
    });
  }
  return { constraints, unpriced };
}
