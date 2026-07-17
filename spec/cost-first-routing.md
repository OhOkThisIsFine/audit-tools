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

## The four-rung resolution

`costRank` for a pool resolves top-down, mirroring `resolveLimits`' rung structure:

1. **Operator-confirmed ordering** (highest). When the run carries a confirmed
   provider/model cost ordering (from Gate-0, below), a pool's `costRank` is the confirmed
   integer position of its provider/model. The operator ordered *every* candidate — including
   unknown-price ones — so this rung is total and internally consistent.
2. **Operator-declared per-source price** (rung 2a). When a pool's own configured source
   declares a `$/Mtok` (`declaredCostPerMtok`), that value is authoritative over the generic
   models.dev catalog — the operator knows their own endpoint's cost (e.g. a free arbitrage
   backend declares `0`, sorting free-first). A negative/non-finite declared value is ignored
   and falls through to the next rung.
3. **models.dev price** (rung 2b). Otherwise `costRank` is the model's **blended price** — a
   single representative $/Mtok scalar = `input · 0.75 + output · 0.25` (a prompt-heavy blend;
   the workload reads far more than it writes, but output price is typically 4–5× input so it
   is not dropped). Cheaper sorts first.
4. **Tier ordinal** (fallback). When neither a confirmed position, a declared price, nor a
   resolvable models.dev price exists, `costRank` falls back to `tierRank(pool.rank)` — the
   pre-existing behavior.

Rungs never mix *within* a pass because a confirmed ordering covers the whole candidate set
or none of it, and (rung 2a/2b vs 3) an unknown-price pool is offset to sort **after** all
priced pools (`UNKNOWN_PRICE_BAND_BASE + tierRank`), preserving tier order among the unknowns.
So: all-known ⇒ ordered by real dollars; all-unknown ⇒ ordered by tier (today's behavior,
no regression); mixed ⇒ priced pools first by dollars, unknown-price pools after by tier —
a "route to provably-cheapest first, treat unknown-cost as overflow" policy. The confirmed
rung supersedes all of this whenever the operator has approved an ordering.

## Where the ordering is confirmed (Gate-0)

`provider_confirmation` is the run's first obligation. On the conversation-first audit CLI
path it is an **interactive host-delegation step** (parallel to `confirm_intent`): the tool
renders the suggested priced pool and the host confirms or reorders it. Headless
(`advanceAudit`, no CLI host) auto-completes with the tool's suggestion, so nothing blocks
when there is no operator.

- **Candidate models are gathered from every knowable source at the step:** any configured
  source models (`openai_compatible.model`, `codex.model`) are priced at the outset; the host
  **self-reports its own model roster** in the step's input (`host_models` — it *is* the agent,
  so the roster is knowable at confirmation), and those host-native tiers are then priced +
  ordered here too rather than only at dispatch. A CLI backend whose roster is not knowable
  until spawn (e.g. codex) contributes at provider granularity, priced "resolved at dispatch"
  and placed by capability tier in the suggestion.
- **The tool prices each candidate** via `resolveModelStatics`, computes the blended $/Mtok,
  and **suggests an ordering** (ascending price, capability tiebreak). Unknown-price
  candidates are flagged and placed last within their tier.
- **Dispatchable sources fold into the SAME unified ordering** — configured `sources[]` pools and
  ambient expansions (NIM/opencode endpoints, claude-worker lanes from the repair-proxy registry)
  are ranked alongside provider/host candidates, not in a separate list. Source candidates are
  keyed under a `source::` namespace internally so a source id can never collide with a provider
  name, but the operator's `cost_order` may name a source by its **displayed bare id** — the bare
  form is an accepted alias (exact candidate keys always win a token). Declared cost wins pricing
  precedence for a source (`sources[].cost_per_mtok`, the operator's cost-relationship to the
  backend — e.g. a genuinely-free tier); registry/catalog list price is the fallback.
- **The operator confirms or reorders — input/envelope split.** The host writes a plain
  `provider-confirmation.input.json` (schema `provider-confirmation-input/v1`: an optional
  `cost_order` list of provider/model keys, `exclude`/`include`, and `host_models`); the tool
  owns the canonical envelope. Its presence is the "operator has acted" signal that flips the
  gate from *emit the step* to *consume the input*: the deterministic executor then promotes
  the submission into BOTH canonical artifacts — the per-tool `provider_confirmation.json`
  seam and the shared `provider-confirmation.json` — with the tool-owned cost annotation, and
  then DELETES the submission (consume-and-invalidate: a spent input must not auto-satisfy a
  later reconciliation it never answered). The operator supplies only ordering intent + a model
  roster; the tool never asks it to hand-author prices or capability flags. The confirmed order
  is persisted on `PersistedPoolEntry.cost_order` (provider pools — `ConfirmedPoolEntry` is the
  in-memory Gate-0 render DTO and by design never reaches disk) and `host_model_cost_order`
  (host tiers), both read back at dispatch as rung 1 via a single model-keyed positions map.
  Remediate reads the same persisted confirmation (it has no standalone confirmation step; it
  consumes the audit-side pool).
- **The gate fires on every interactive run** (audit CLI path), even with one or zero
  auto-detected providers: the operator may want to reorder, exclude, self-report a host roster,
  or **add a provider discovery missed** (an OpenAI-compatible endpoint or a CLI backend they've
  configured but that wasn't surfaced). Only the headless path (`advanceAudit`, no CLI host)
  auto-completes without pausing.

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
- **Parity.** Audit (`finalizeDispatchQuota`) and remediate (`waveScheduling.ts`, via
  `schedule.capacity_pools`) both build their `AdmissionPool[]` through the one shared
  `admissionPoolsFromSummaries`, which internally derives `costRank` via `deriveCostRank` —
  they cannot drift.
- **Collision resolution prefers the cheapest priced candidate.**
  `scripts/shared/update-models.mjs`'s `flatten()` visits providers alphabetically, and on a
  cross-provider model-id collision keeps the entry with the lowest blended price (ties broken
  by sorted-provider order, and an unpriced record always loses to a priced one). Every
  provider's own record is still indexed under `byProvider` so a provider-scoped lookup can pin
  the native price instead of the cheapest-collision default.
