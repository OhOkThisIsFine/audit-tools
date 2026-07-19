# Account-scoped metering, round 2 — independent review (2026-07-19)

**Verdict: SIGN-OFF REFUSED, 3 of 3 independent lenses, unanimous.** Target: `e500672f` on
`wip/capability-evidence`. This is the fourth-party review `docs/HANDOFF.md` named as the next action.
Defect statement + the author's own round-1/round-2 account: [`nim-dispatch-single-pool-2026-07-19.md`](nim-dispatch-single-pool-2026-07-19.md).

Three lenses ran independently, none seeing the others' output, each instructed to treat the author's
review record as a lead requiring verification and to default to refusing under uncertainty:
**defect-class sweep**, **partition correctness**, **verification quality**. Two of the three built a
worktree at `e500672f` and executed scenarios through the real producer chain rather than reasoning
from source alone.

## The one that matters most — found independently by two lenses

**The lease key moved to account scope; the budget it is compared against did not.** `critical`

- `src/shared/dispatch/admissionLoop.ts:239-241` — `resourceKey: pool.account_key` (account-scoped)
  paired with `budget: pool.remaining_token_budget` (pool-scoped).
- `src/shared/dispatch/rollingDispatch.ts:1005-1011` — same split.
- `src/shared/dispatch/unifiedRolling.ts:99,108` — `budgetByPool` keyed on `alloc.pool_id`, never
  touched by this commit.

The contract is violated in-tree: `src/shared/quota/reservationLedger.ts:78` documents `budget` as
"Caller-computed live remaining tokens for `resourceKey`", and `admit` computes
`budget − Σ outstanding(resourceKey)`. The two operands are now on different partitions.

**Executed, not argued** (partition lens, real producers at `e500672f`): one account, pools
`nvidia_nim/big` (budget 1000) and `nvidia_nim/small` (budget 200), 20 packets × 100 tokens →
**10 granted, all on `big`; `small` granted 0.** Order-independent. Two consequences:

1. The effective account ceiling becomes the **MAX** sibling budget, not any real limit — because
   `tokens_per_pct` is learned per *pool* and is explicitly excluded from the account fold
   (`accountId.ts:104-107`), so siblings derive different budgets.
2. An uncalibrated sibling has a null budget → `+Infinity` (`admissionLoop.ts:241`,
   `unifiedRolling.ts:108`) → the shared ceiling is **not enforced at all** while any one sibling is
   new, which is the common case when adding a model to an existing credential.

**Why this is the sharpest possible finding against this change:** it is the author's own rejection
argument, verbatim. `admissionLoop.ts:624-628` states that keying the cap per-account would "make the
effective ceiling the MAX cap across an account's pools rather than any real limit, permanently
starving its lowest-cap pool" — and that reasoning is exactly why round 2 reverted the concurrency-cap
change. The identical flaw was then shipped on the budget axis the change *did* alter. Diagnosed for
one axis, unapplied to the other.

Invisible to the suite because every author fixture uses equal sibling budgets
(`tests/shared/account-scoped-metering.test.mjs:182` — `250/250/250`).

## The motivating case is STILL not fixed — third consecutive round

`accountId.ts:37` requires `api_key_env`. But `api_key` (inline) is a documented, supported credential
field that `openAiCompatibleSource` explicitly copies (`apiPool.ts:450-453`). So:

```
{id:"nim-nano",  provider:"openai-compatible", endpoint:"…/v1", api_key:"sk-…", model:"nano"}
{id:"nim-super", provider:"openai-compatible", endpoint:"…/v1", api_key:"sk-…", model:"super"}
```

→ `accountKey` = `"nim-nano"` / `"nim-super"`, **not merged**. Per-model budgets, per-model cooldowns —
the original bug verbatim, silently, no warning. Round 2 fixes the motivating scenario only on the
`api_key_env` branch. Round 1 claimed this case fixed and it was not; round 2 repeats the pattern on a
neighbouring config shape. This is [[fix-the-defect-class-not-the-named-instance]] for the third time on
one defect.

## The evidence apparatus is itself fail-open

The pinning gate was this round's central credibility claim. It is a real improvement — the
verification lens independently confirmed all 7 declared sites are genuinely pinned (failure counts
1/3/1/1/1/1/1), and confirmed the author's fix to its original fail-open parse. **But:**

- **`assert-sites-pinned.mjs` measures "the suite went red", not "a test asserting THIS behavior went
  red."** Proved: renaming the `resolvePoolAccountKey` export so importers crash produced `71 failed`
  and the gate reported `PINNED … All 1 site(s) individually pinned.` There is no binding between a
  site and an expected-failing test name. **The same fail-open shape the tool was built to catch,
  relocated one level up.**
- **The spec is an author-chosen subset.** 7 sites declared; the commit has ≥11 substantive src hunks.
  "All 7 changed sites individually pinned" is literally true and materially misleading — 7 is the
  author's own denominator.
- **The two hunks that ARE the fix's core claim are outside the subset and invisible to everything:**
  `schedulePool`'s stamp (`capacity.ts:725`) and `buildHostModelPool`'s stamp (`apiPool.ts:276`). Revert
  either to the pre-fix value and `tsc` is clean and the full suite is byte-identical to baseline.
  Reverting `buildHostModelPool` makes host pools meter per-model — *the exact defect this change
  exists to fix* — with zero signal.
- **Reversions were authored to fit the tool, not derived from pre-fix code.** Three dead imports
  (`admissionLoop.ts:26`, `rollingDispatch.ts:66`, `apiPool.ts:12`) exist only to make the gate's
  `replace` text compile. Sites 5–6 revert to feature-OFF rather than to the old derivation, so they
  pin "a fold happens", not "it groups on `accountKey`" — and the actual delta stays untested.

## Remaining findings

- **The `concurrency_cap` revert reasoning is a non-sequitur, and its residual hole is undisclosed.**
  `high` The contract claim was verified TRUE (`sessionConfig.ts` — `max_concurrent` is per-ENDPOINT).
  But enforcement keys on `poolId` (`admissionLoop.ts:631-640`), and N models on one endpoint are N
  pools. Two models declaring `max_concurrent: 2` on one endpoint **admitted 4**. "It's per-endpoint,
  therefore keep it per-pool" does not follow — neither `poolId` nor `accountKey` is the endpoint. The
  commit presents the revert as contract-faithful without naming the surviving N× over-admission.
- **Rung 1 discards the credential — mirror-image over-merge.** `medium-high` `accountId.ts:91` ignores
  `api_key_env` when `backend_provider` is set. Two different NVIDIA accounts behind one
  `backend_provider` → one budget, one cooldown. The docstring offers explicit `account` as the
  safeguard, which requires the operator to remember — barred by *auditor-agnostic robustness*.
- **The degraded `"proxy"` bucket newly merges budgets across unrelated backends.** `medium-high`
  `proxyCatalog.ts:546` assigns `provider = "proxy"` when an advert carries no provider. Two such lanes
  share one budget and cooldown. Pre-commit the budget axis was per-pool, so this is a **new**
  over-merge — round 1's "a free lane's 429 stalls an unrelated paid lane" surviving in the degradation
  rung.
- **The `provider !== "openai-compatible"` guard was deleted; the docstring still asserts it.** `medium`
  `accountId.ts:26-27` states "Returns null when: the source isn't `openai-compatible`" — describing
  removed behavior. Rung 2 now applies to provider classes never analyzed (two `worker-command` sources
  sharing endpoint+key now merge). Unpinned: restoring the guard leaves the suite green.
  *Enumeration note:* the sweep lens grepped every caller of `deriveLocalAccountId` — exactly one
  (`resolvePoolAccountKey`). So there is **no** over-merge re-entry through a second caller. That
  hypothesis is dead.
- **Cooldown fold silently widened to every pool.** `medium` `apiPool.ts:784` deleted
  `if (!accountId) return pool`. Two `codex`/`agy` pools for different models now share a 429 cooldown —
  correct for a subscription, wrong for per-model TPM/RPM. Not in the commit's scope statement.
- **Budget and cooldown split partitions on the host-pool class.** `medium`
  `foldAccountCooldownAcrossPools` is called only at `apiPool.ts:670`, on the source-pool path.
  `buildHostModelPools` pools never fold, yet now share a budget meter. For source pools the two axes
  genuinely do share the partition; for host pools they do not.
- **Untypechecked test tree hides a fixture-wide over-merge.** `medium` ~46 test files build
  pool-shaped literals; 3 set `accountKey`. With the deleted guard, `p.accountKey === accountId` matches
  across all `undefined`-keyed fixtures, so fixtures now silently exercise the over-merge branch — which
  is what would mask a real over-merge regression.
- **Dead imports.** `low` Flagged independently by all three lenses.

## Correction to the record — the "sole failure" claim was wrong

`e500672f`'s commit message and `docs/HANDOFF.md` both stated a **sole** failure, resolved by name to
`INV-shared-core-14`. A clean-worktree run at that commit measured **two** pre-existing failures —
`linux-cycle-regression.test.mjs` also fails and went unmentioned. Same file/test totals, different
failure count, so this is env-sensitive rather than a disagreement about scope.

The claim was made after correctly resolving one failure by name and then **stopping at the first
explanation that fit** — which is the same shape as the defect under review: verify the instance, then
generalize. `CLAUDE.md`'s rule is that "N failed" must be resolved to NAMED files, plural, before any
baseline attribution. One name was produced; the count was not reconciled against it.

## ⚠ Owner ruling 2026-07-19 — the reviewers' budget diagnosis is REFRAMED

**"Under the same account, different models can have different quotas/limits, and tokens burn quota at
different rates with different models."** (owner)

This does not rescue the change — the starvation the reviewers executed is real — but it **falsifies the
repair they implied**, and the option this review originally recommended. Verified from source:
`scheduler.ts:418-421` derives `remaining_token_budget` as `tokens_per_pct[label] × remaining_pct × 100`.
So:

- The **shared account resource is `remaining_pct`** — a percentage of the account's quota window.
- **`tokens_per_pct` is a per-model EXCHANGE RATE**, converting that percentage into one model's token
  units.
- `remaining_token_budget` is therefore a **per-model denomination of the same shared allowance**, not
  an independent budget.

**Consequence: an account-level `tokens_per_pct` cannot exist.** There is no common token unit across
models on one account, because they burn at different rates. `tokens_per_pct` being learned per-pool and
excluded from the account fold (`accountId.ts:104-107`) is **correct by design** — this review treated it
as the obstacle to an account-scoped budget when it is in fact the conversion that makes one possible.

Two pools on one account reading 1000 and 200 are not necessarily two budgets. They may be **the same
10% of quota**, priced in two currencies.

**The implied direction (needs its own design pass, not yet verified in depth): meter in the SHARED
unit.** `resourceKey` = account (round 2 got this right), budget = the account's `remaining_pct`, and a
packet's token cost converts through *its own pool's* `tokens_per_pct` before reaching the ledger. Both
operands then sit in one currency on one partition, and the uncalibrated-sibling `+Infinity` hole becomes
an ordinary cold start with no exchange rate yet — which already has a bootstrap path
(`COLD_START_PROBE_BATCH`).

**Second half of the ruling, NOT yet analyzed:** different models on one account may also carry their own
distinct quotas/limits. That implies a **two-level** structure — an account allowance AND a per-model
limit, with admission required to satisfy both — rather than the single partition this whole change
assumes. Whether the existing per-window quota-state shape already expresses that, or whether it needs a
new level, is the first thing the next round should establish. **Do not start coding until it is
settled** — a repair that assumes one level will be the fifth refusal.

## What the next round must do

1. **Start from the owner ruling above, not from this review's original framing.** The budget operand and
   the lease key must end up in the same unit; the open question is which unit and how many levels, not
   whether to revert to pool scope.
2. **Settle the credential-shape question:** `api_key_env` vs inline `api_key` (and any other supported
   credential field). Enumerate the field set from source; do not fix the named one.
3. **Name the `concurrency_cap` residual explicitly** or fix it. The revert is defensible; presenting it
   as contract-faithful while an N× hole survives is not.
4. **Bind the pinning gate to expected-failing TEST NAMES**, and derive its spec from the diff rather
   than by hand, so "all sites pinned" cannot be true over an author-chosen subset. Until then its
   output is not admissible as attestation evidence.
5. Re-review after, with lenses that did not author the fix.
