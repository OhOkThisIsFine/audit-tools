# Cost-first dispatch routing — real price, operator-confirmed ordering

Design of record for how dispatch decides *which pool is cheapest*. Pairs with
[`spec/audit/dispatch-admission-control.md`](audit/dispatch-admission-control.md),
which owns the admission loop that *consumes* the cost signal (`AdmissionPool.costRank`).

## The defect this closes

`AdmissionPool` carries two rank fields, `costRank` and `capabilityRank`. Until this
design they were set to the **same value** — `tierRank(pool.rank)`, a tier ordinal
(`small=0, standard=1, deep=2`). So "route to the cheapest capable pool" actually meant
"route to the least-capable pool", and there was no real cost signal at all. The tier
ordinal was only ever a *proxy* for price, forced by the no-hardcoded-models invariant:
before a per-model price dataset existed, no dollar figure was available without baking a
model→price table into the backend (which the invariant forbids).

The models.dev static-metadata resolver (W1) removed that constraint — a vendored,
degrade-to-empty community dataset now yields real per-token price for a model id. This
design spends that data: **cost becomes real dollars, decoupled from capability.**

## Principles

- **Cost is its own axis.** `costRank` answers "how many dollars per unit of work"; it is
  no longer tied to `capabilityRank` ("is this pool strong enough"). Capability still
  routes the biggest packets to the most-capable pool and gates fit (`capacityTokens`);
  those are unchanged and independent.
- **Discovery-first, dataset-as-fallback, never hardcoded.** A model's price is resolved
  from the vendored models.dev snapshot (`resolveModelStatics`). Unknown model id ⇒ no
  price ⇒ fall back, never fabricate. No model→price literal in backend code.
- **The operator confirms the ordering; the tool only suggests it.** At the outset the tool
  proposes a provider/model ordering (ascending real price, capability as the tiebreak) and
  the operator approves or reorders. The *confirmed* ordering is authoritative; models.dev
  price is the *proposal* behind it, not a silent guess. This is where a model whose price
  the dataset can't resolve gets placed by a human instead of guessed.
- **Total order, no scale-mixing.** Within one admission pass every pool resolves its
  `costRank` from the **same rung** (see below), so a dollar value is never compared against
  a tier ordinal. The result is always a well-defined total order.

## The three-rung resolution

`costRank` for a pool resolves top-down, mirroring `resolveLimits`' rung structure:

1. **Operator-confirmed ordering** (highest). When the run carries a confirmed
   provider/model cost ordering (from Gate-0, below), a pool's `costRank` is the confirmed
   integer position of its provider/model. The operator ordered *every* candidate — including
   unknown-price ones — so this rung is total and internally consistent.
2. **models.dev price.** Otherwise `costRank` is the model's **blended price** — a single
   representative $/Mtok scalar = `input · 0.75 + output · 0.25` (a prompt-heavy blend; the
   workload reads far more than it writes, but output price is typically 4–5× input so it is
   not dropped). Cheaper sorts first.
3. **Tier ordinal** (fallback). When neither a confirmed position nor a resolvable price
   exists, `costRank` falls back to `tierRank(pool.rank)` — the pre-existing behavior.

Rungs never mix *within* a pass because a confirmed ordering covers the whole candidate set
or none of it, and (rung 2 vs 3) an unknown-price pool is offset to sort **after** all
priced pools (`PRICE_UNKNOWN_BASE + tierRank`), preserving tier order among the unknowns.
So: all-known ⇒ ordered by real dollars; all-unknown ⇒ ordered by tier (today's behavior,
no regression); mixed ⇒ priced pools first by dollars, unknown-price pools after by tier —
a "route to provably-cheapest first, treat unknown-cost as overflow" policy. The confirmed
rung supersedes all of this whenever the operator has approved an ordering.

## Where the ordering is confirmed (Gate-0)

`provider_confirmation` is the run's first obligation and already presents the discovered
provider pool to the operator. It is extended to be cost-aware:

- **Candidate models are gathered from every knowable source at the step:** the host
  self-reports its model roster (it *is* the agent — the same data as `--host-models`, just
  gathered at confirmation), plus any configured source models (`openai_compatible.model`,
  `sources[].model`). A CLI backend whose roster is not knowable until spawn (e.g. codex)
  contributes at provider granularity, priced "resolved at dispatch" and placed by
  capability tier in the suggestion.
- **The tool prices each candidate** via `resolveModelStatics`, computes the blended $/Mtok,
  and **suggests an ordering** (ascending price, capability tiebreak). Unknown-price
  candidates are flagged and placed last within their tier.
- **The operator confirms or reorders.** The confirmed ordering is persisted on
  `ConfirmedPoolEntry.cost_order` (→ `SessionConfig.confirmed_provider_pool`) and read back at
  dispatch as rung 1. Remediate reads the same persisted confirmation (it has no standalone
  confirmation step; it consumes the audit-side pool).

The suggestion is best-effort at Gate-0 (it prices what is knowable there); the deterministic
price→`costRank` engine at dispatch — where the per-model roster is always known — is the
always-on floor. Gate-0 is the operator's approval/override layer on top of it, not a
replacement for it.

## Invariants

- **No model→price literal in backend code.** Price comes only from the vendored dataset via
  `resolveModelStatics`, consumed degrade-to-empty. (Two-tier dependency policy: the dataset
  is an external community asset, like `smol-toml`/`yaml`.)
- **`costRank` and `capabilityRank` are independent.** A change to cost policy is a change to
  one rung of one field; capability routing and the capacity-fit gate are untouched.
- **Parity.** Audit (`finalizeDispatchQuota`) and remediate (`admissionPoolsFromSchedule`)
  both derive `costRank` through the one shared `deriveCostRank` — they cannot drift.
- **Collision resolution prefers the cheapest/native price** when models.dev lists a model id
  under multiple providers (W1 carried this caveat forward: context windows agreed across
  providers, but price must prefer the native/cheapest to avoid a reseller markup winning).
