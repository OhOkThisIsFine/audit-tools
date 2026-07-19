# Account metering — design of record (2026-07-19)

**This supersedes the repair direction in every prior round.** Four rounds of fixes were refused
because all four attempted the partition at the CONSUMER, reconstructing from pool identity
(`backend_provider`, `api_key_env`, pool-key head) information the quota PRODUCER already has and
discards. The fix belongs at the producer.

Prior records: [`account-metering-round2-independent-review-2026-07-19.md`](account-metering-round2-independent-review-2026-07-19.md) ·
[`nim-dispatch-single-pool-2026-07-19.md`](nim-dispatch-single-pool-2026-07-19.md).

## The finding

**The two-level structure already exists.** It is expressed as WINDOWS, not as accounts vs models:

- `claudeOAuthQuotaSource.ts:430-435` `topLevelWindows` — `five_hour`→`session`, `seven_day`→`weekly`.
  Its own comment: *"Aggregate windows only."* These are **ACCOUNT-WIDE**: shared by every model on the
  credential.
- `claudeOAuthQuotaSource.ts:378-386` — `limits[]` entries, filtered by `limitAppliesToModel`
  (`:421-426`) on `lim.scope.model`. These are **MODEL-SCOPED** — e.g. a model-family-specific limit
  that does not apply to its siblings. Data-driven, never a hardcoded model name (INV-QD-04).
- `scheduler.ts:536-538` — a pool's budget is the **MIN across its windows**, so "satisfy every
  applicable limit" is already the semantics.

**A window is a TIME-WINDOW, never a model identity** (`quotaSource.ts:4-15`, explicit). Independently
confirmed by two offloaded analyses.

## The root cause

**`QuotaWindow` carries no scope.** `quotaSource.ts:12-19` is `{label, remaining_pct, reset_at,
tokens_remaining}`. `collectWindows` KNOWS whether a window came from `topLevelWindows` (account-wide)
or from a model-scoped `limits[]` entry — it branches on exactly that — and then **throws the
distinction away** at the schema boundary.

So no downstream consumer can tell an account-wide window from a model-scoped one. Every repair
attempt has been trying to re-derive, from pool identity, a fact the producer had and dropped. That is
why each one was a guess, and why each guess broke a different case.

This is [[write-only-data-looks-authoritative]] inverted: not a stored value nobody reads, but a
**known value nobody stores**.

## The correct model

Meter **per WINDOW**. Not per pool (today's bug: N models each get their own full `session` budget ⇒
the N× over-admission) and not per account (kills model-scoped limits, and see the denominator
constraint below).

| Window scope | Ledger key | Rationale |
|---|---|---|
| account-wide (`session`, `weekly`, unscoped `limits[]`) | `(accountKey, label)` | one real allowance shared by every model on the credential |
| model-scoped (`limits[]` with `scope.model`) | `(poolId, label)` | applies to this model alone; sharing it would falsely throttle siblings |

**Admission must satisfy ALL applicable windows — an all-or-nothing multi-constraint reservation**, not
one key. This replaces the current MIN-collapse-then-single-reserve.

**`tokens_per_pct` stays per `(pool, window)` and is CORRECT AS-IS.** It is an exchange rate, not a
budget. Its exclusion from the account fold (`accountId.ts:104-107`) is right by design — the round-2
review treated it as the obstacle to an account budget when it is in fact the conversion that makes one
expressible. Cost against a window = `tokens / tokens_per_pct[pool][label]`.

### ⚠ The constraint that kills the naive repair

**You cannot meter "percent" as a single shared number.** Windows scale on different denominators — a
5-hour `session` vs a 7-day `weekly` — so the same N tokens is a different percentage of each. There is
no common denominator across windows, which is exactly why the reduction to one number
(`remaining_token_budget`) had to happen per-pool in the first place. **The unit of metering is
(window, its own percent), and the ledger must hold one constraint per window.**

This also falsifies the "meter in the shared percent unit" direction recorded earlier the same day —
that framing assumed one denominator existed. It does not.

### What round 2 got right, and what it got wrong

Round 2's `accountKey` derivation is **necessary but insufficient**, not wrong. An account key IS needed
— to key the account-scoped windows. Its error was applying that key to the pool's WHOLE collapsed
budget rather than to the account-scoped windows only. The reviewers' "account-keyed meter, pool-keyed
budget" finding is the SYMPTOM of applying a correct key at the wrong granularity.

## Owner constraints (2026-07-19) — scope is UNIVERSAL, never provider-conditional

**"Whether all providers return per-model snapshots or not, we need to allow for it — explicitly leave
space for it in all cases."**

This is stronger than "Claude happens to expose model-scoped limits", and it is the binding form:

- **Every window from every producer carries a `scope`. There is no path that omits it.** A provider
  that cannot distinguish account-wide from model-scoped emits `scope: "account"` for all its windows —
  and that IS the documented fallback ("if they only provide account-wide quota, apply that value to all
  their models"), not a bypass. Making the field required, with no default, is what stops the next
  provider from being special-cased.
- **The learned slope stays individual to each model**, unconditionally — including under an
  account-wide-only provider, where N models share ONE window's percent but each converts it to tokens
  at its own rate. This is precisely why the shared resource must be the window's percent and the
  per-model quantity must be the exchange rate. Confirms `tokens_per_pct` per `(pool, window)`.

### Deferred seam — sibling-derived slope priors

An uncalibrated pool has no exchange rate for a window and so cannot price a constraint. This design
routes it through the existing cold-start probe path. **Better, and explicitly left open: seed the prior
from SIBLING models on the same provider whose slope is already learned** (Bayesian-style update rather
than start-from-nothing), so a newly-added model is not maximally ignorant.

**Deliberately NOT bundled into the partition fix.** It is an estimator improvement, independent of the
partition; bundling it means metering cannot land until the estimator is also right, and the estimator
wants live data to validate. The seam to preserve: slope lookup must be a function of `(pool, window)`
with a single resolution point, so a prior can be injected there later without touching admission.
Tracked in `docs/backlog.md`.

## Step 1 status — LANDED (scope plumbing only), with two named residuals

Step 1 below is implemented and green. It is **foundation only: `scope` is carried but not yet
consumed, so metering behavior is UNCHANGED.** Do not read "scope landed" as "the N× over-admission is
fixed" — it is not, until steps 2–4 land.

Two independent adversarial review rounds ran against it; both REFUSED and both were right. Round 1
found three defects (label-only dedup swallowing a model-scoped window; `display_name ?? id` returning
`""` and misclassifying a scoped limit as account-wide; the guard living inside `deriveTokenBudget`,
which an active cooldown skips). Round 2 found that the *fixes* were themselves wrong — most sharply
that scope was being derived by extracting a model NAME, so a `scope.model` present with blank
identifiers still fell through to `account`. **Scope now keys on the PRESENCE of `scope.model`;
naming is a separate concern used only for matching.** Each fix is individually red-green pinned.

**Residual 1 — the guard is on the metering path only.** `assertWindowScopes` runs in `scheduleWave`.
Other snapshot consumers (`quotaSnapshotWindowPctMap` / `foldSlopeObservationFromSnapshots` in
`state.ts`, `tokenBudgetView.ts`) do not call it.

⚠ **CORRECTED 2026-07-19 by step 2's execution — the premise below was FALSE.** This said "in
production this cannot fire — every producer stamps scope — so it is defense-in-depth completeness,
not a live bug." Live producers do stamp scope, but consumers are also fed **persisted** snapshots
read back from `dispatch-quota.json` with no schema parse, and those predate scope: **12 of 12
windows across all 9 on-disk artifacts carry none.** Once step 2 put scope into the slope key, those
windows keyed as `"undefined:<label>"` — silently orphaned. So this was a live bug, and step 2 made
it materially worse before fixing it.

**The "validate ONCE at the producer boundary" prescription was also attempted and REVERTED** — it is
not mechanical. Every production caller swallows a throw from `probeQuotaSource` into
`status: "degraded"`, and `compositeQuotaSource` bypasses that boundary entirely, so asserting there
fails quietly rather than loudly. What shipped instead splits by input provenance: the LIVE path
(`scheduleWave`) still throws; the PERSISTED path (`quotaSnapshotWindowPctMap`) skips-and-warns,
because it sits under a function contracted never to throw. The genuine producer-boundary fix needs a
distinct error class the degrade-catches deliberately re-throw — tracked in `docs/backlog.md`.

**Residual 2 — `tokens_per_pct` is keyed by label alone, within a pool.** An account-scoped and a
model-scoped window sharing a group name (both `session`) therefore share one learned slope entry.
Harmless today (scope is unconsumed) but **step 2 MUST key the slope map by `(scope, label)`**, or the
two partitions will silently share an exchange rate. This is why the dedup key carries scope while the
emitted label does not — mangling the label would have orphaned every previously-learned slope.

## Work breakdown

1. **`QuotaWindow.scope`** — add `scope: "account" | "model"`, **required, no default, no back-compat
   shim** (per ideal-code, and per the owner constraint above: a default is how a provider gets
   silently special-cased). Stamp it in EVERY producer — `claudeOAuthQuotaSource.collectWindows`
   (topLevel ⇒ `account`; `limits[]` with `scope.model` ⇒ `model`; unscoped `limits[]` ⇒ `account`),
   `codexQuotaSource`, `hostSessionQuotaSource`, and every other `QuotaSource` implementation, including
   ones that only ever emit `account`. Required-with-no-default means `tsc` enumerates the producers for
   us rather than us trusting a grep.
2. **`ReservationLedger` → multi-constraint.** `admit` takes `constraints: Array<{resourceKey, budget,
   cost}>`; admitted iff EVERY constraint clears; one `leaseId` recorded under each key; `reconcile`
   releases all. Currently single-key (`reservationLedger.ts:202-236`).
3. **Budget derivation emits per-window constraints** instead of collapsing to MIN
   (`scheduler.ts:512-540`). The MIN is still useful for *reporting* the binding window; it stops being
   the metering unit.
4. **Admission wiring** — `admissionLoop.ts:239-241`, `rollingDispatch.ts:1005-1011`,
   `unifiedRolling.ts:99` build constraint arrays rather than a single `{resourceKey, budget}`.
5. **Tests** — per-site, bound to expected-failing test names (the pinning gate's own defect, see
   backlog). Must include: unequal sibling budgets; an uncalibrated sibling; account-wide vs
   model-scoped windows diverging; two accounts on one backend_provider.
6. **Independent review** by lenses that did not author it.

## Standing constraints

- **Loop-core** (`src/shared/quota/`, `src/shared/dispatch/`) → green + independent review +
  attestation before landing.
- The **cold-start** path (`COLD_START_PROBE_BATCH`) absorbs the uncalibrated-sibling case that
  currently becomes `+Infinity` — a pool with no exchange rate for a window cannot price a constraint
  and must go through the probe path, not be waved through.
- The `concurrency_cap` residual (per-endpoint contract, per-pool enforcement ⇒ N models on one
  endpoint admit N× the cap) is a SEPARATE axis. Not fixed by this design. Name it or fix it; do not
  let it ride silently again.
