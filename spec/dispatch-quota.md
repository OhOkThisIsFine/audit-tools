# Dispatch & quota — the design of record

This spec owns the whole dispatch/quota model as one subject: which quotas a run tracks and why;
how quota pools are identified and metered; how work is admitted against a shared, account-keyed
reservation ledger; how the candidate pools for a packet are ordered by an operator-set policy
along the cost↔throughput frontier; how a packet's exclusivity claim is separated from its
routing so a backend is chosen just-in-time at launch; and what the tool enforces mechanically
rather than leaving to host discretion. It is a conceptual spec, not an implementation log:
everything below is a durable contract, invariant, or the rationale that fixes its shape. Per-provider
recipes (endpoints, credential locations, response shapes) live in
[`cross-provider-quota-matrix.md`](cross-provider-quota-matrix.md); worker kinds and per-auditor
capability live in [`unified-dispatch-worker-model.md`](unified-dispatch-worker-model.md).

---

## 1. The one routing decision

There is exactly one dispatch decision, made per packet at the moment of launch:

```
route(packet) = capability floor           (hard: eligible pools only)
              × live capacity              (budget headroom, declared caps, cooldowns)
              × ordering policy            (the operator's cost↔throughput dial)
              × claim-before-assign        (exclusivity, pool-agnostic)
              , reserved against the shared ledger before the provider is called
```

Every subsequent section is one factor of that product. The factors compose in a fixed order and
never substitute for each other: capability gates *eligibility*, the ordering policy chooses *among
eligible pools*, capacity decides *whether the chosen pool can take it now*, and the claim decides
*whether anyone else already owns the work*. The ordering policy reorders; it never un-gates.

### 1.1 The defects this shape closes

- **Capability inherited from the run, not the current driver.** A run started under one host and
  resumed by a different auditor must not size against — or charge — the original host's quota.
  Resolving the dispatch pool from a stored `sessionConfig.provider` does exactly that — sizing
  the resumed driver against the original provider's `provider_default` quota (a declared
  concurrency of 6 granted 2 slots) — and is wrong for both auditors. The active pool set is therefore **per-invocation**, derived from the
  driver actually present.
- **`concurrency` is the wrong primitive.** It is not a real fixed quantity: pools appear and
  vanish, estimates drift from actuals, and a hard "max in flight" exists only for the subset of
  hosts that genuinely declare one. Precomputing `max_concurrent_agents = N` bakes a snapshot of a
  continuously moving thing and invites an LLM to *guess* a number anchored to nothing.
- **Pre-binding work to backends.** Assigning packets to pools at plan time makes three false
  promises at once: that plan-time headroom still holds at launch, that the planned pool is still
  the best (or any) route, and that a packet waiting on a saturated pool should not run on an idle
  one. Each staleness window produces a real failure class — phantom walls from stale grants,
  packets queued behind a saturated pool while capacity idles elsewhere, re-plan churn when a pool
  drops mid-run.
- **Capability used as a proxy for price.** Ranking cost by tier ordinal makes "route to the
  cheapest capable pool" mean "route to the least-capable pool". Cost is its own axis.

### 1.2 Principles

- **Capability is per-pool; the active pool set is per-invocation.** Dispatch is a *fleet* — this
  host's subagents, a NIM endpoint, a Codex backend, a second IDE's host, a local subprocess,
  possibly several at once. The unit is a self-describing pool, never "the auditor" and certainly
  never "the audit."
- **Enforce in tooling, for every install.** No correctness property may rest on host-side config
  that does not ship in the package. The tool must hold even when the host reports garbage.
- **The LLM is structurally excluded from the number.** No pool's concurrency or budget is ever
  supplied by an LLM. Concurrency is derived/emergent; the host contributes at most a verifiable
  identity and gets *measured*.
- **Tolerate wrong or absent declared facts.** Start optimistically; let measured actuals and 429s
  correct any over-declaration. Never *trust* a declared window.
- **No fabrication from stale config.** The tool never adds a pool that is not confirmed present
  this invocation. `sessionConfig.provider` authority is confined to the headless in-process path
  (where that provider is itself a pool doing the work); it is never the dispatch/quota authority
  for host-driven or multi-pool dispatch.
- **Discovery-first, dataset-as-fallback, never hardcoded.** Price, concurrency and limits come
  from what the provider/host/registry already states, or from a vendored community dataset
  consumed degrade-to-empty — never from a model→price or model→concurrency literal in backend code.

---

## 2. The frame: conversation-first, inside a host IDE

The product runs as a **conversation inside a host IDE/agent**. The conversational agent IS the
orchestrator's primary worker: it reads the rendered step, does the bounded unit, calls back. The
CLI is a backend/fallback, not the product.

Everything about quota follows from this. There is no central server with a god's-eye view of all
providers. There is **one running instance, hosted by one IDE**, and that instance reasons only
about the quota *it itself* consumes.

---

## 3. Quota tracking scope — exactly what this run touches, nothing else

> The conversational agent tracks **all** quotas it interacts with, and **only** those.

    scope(run) = { the host provider } ∪ { each dispatch-target provider actually used this run }

### 3.1 Role A — host provider (self). Always tracked, the primary

The provider backing the IDE that runs the conversation (Claude Desktop → Claude; Codex Desktop →
Codex/OpenAI; any future host → its own backing provider). The host provider's quota gates the
**whole run**: every step, including the act of dispatching, spends the host's budget through the
conversational agent. If the host is out of quota, nothing proceeds.

**Each supported host must have a way to discover its OWN quota.** This is a hard requirement of
adding a host, not an afterthought. A host with a discoverable proactive endpoint gets a
`QuotaSource` (Claude → `oauth/usage`; Codex → `wham/usage`). A host with none degrades to the
**reactive host-session source** — parsing a session-limit notice out of the worker channel — which
is still own-quota, just lower-fidelity. Either way the host is tracked.

### 3.2 Role B — dispatch-target providers (subagent backends). Tracked only when used

If — and only if — a run fans work out to subagents on other providers, those providers' quotas are
tracked too, each as its own pool: NVIDIA NIM, Claude CLI, Ollama, OpenRouter, vLLM or any
openai-compatible endpoint. A provider not dispatched to this run is never probed.

### 3.3 Red lines

- **An IDE never tracks another IDE's host quota.** There is no cross-IDE quota sharing,
  federation, or peeking; each IDE instance is self-contained with respect to its own host quota.
- **Never automate another IDE's GUI** — no keystrokes, clicks, screenshots, or computer-use.
  Dispatch targets are headless backends (CLIs, HTTP endpoints, local servers) only.
- **Self-monitoring only.** A run touches a provider's quota endpoint only for a provider it hosts
  or is actively dispatching to. No speculative or inventory probing.
- **Read-only credential use; never break the host's auth.** A probe reuses a provider's own
  credential read-only. The single allowed exception is refreshing that provider's OWN rotating
  credential when it would otherwise go dark, and only atomically under a lock. Never
  refresh-and-rewrite a *third-party* provider's cred store from a probe.

### 3.4 The `QuotaSource` contract and its self-gating

Every provider — host or target — has a `QuotaSource` conforming to one contract:

    queryCurrentUsage(providerModelKey) → QuotaUsageSnapshot { remaining_pct (0–1), reset_at, … }

**Signal preference, always:** proactive endpoint > reactive headers on a completion > reactive
dated-limit (429) error > local consumption estimate.

`buildQuotaSource` (`src/shared/quota/compositeQuotaSource.ts`) registers ALL known proactive
sources in one composite. This is not "track everything" — it is the opposite. Each source **gates
on the provider name** (`handlesProvider`) and returns null with **zero I/O and zero credential
reads** for a key it does not own. The caller passes only the keys actually in play: the host's,
plus each active target's. The identical registered composite therefore "self-monitors whichever
IDE hosts the run" purely because the caller feeds it own-provider + active-target keys and nothing
else. A Claude-host run never touches Codex/Copilot/Gemini endpoints or creds; a Codex-host run has
the same property with a different host.

### 3.5 An unsupported environment is LOUD, not silent — `quota_coverage`

Coverage widens progressively, and the orchestrator must **see** a gap rather than silently
degrading to reactive 429. Each host pool carries a `quota_coverage` status on the dispatch-quota
contract's `capacity_pools[]`, classified by the pure no-creds capability check
(`QuotaSource.coversProvider`, `src/shared/quota/coverage.ts`):

- **`established`** — a proactive source in code covers this provider. Whether live credentials are
  present is the orthogonal `quota_signal_degraded` flag.
- **`reactive_only`** — the provider has no proactive surface BY NATURE (static API key or local
  model: NIM, vLLM, Ollama, worker-command, generic openai-compatible). Not a gap; reactive 429 is
  correct here and no nudge fires.
- **`unestablished`** — no source covers this provider; the environment is not supported yet.

On `unestablished` the dispatch step prompt emits a **host-agent nudge once per environment**
(per-provider marker in the artifact dir, terse status thereafter —
`src/shared/quota/quotaCoverageNudge.ts`, surfaced by `src/shared/quota/apiPool.ts` and both
orchestrators' dispatch prompts), offering two conversation-first paths: (1) if the host has
built-in access to its own usage, report it so the run can pace from it and it can be wired in;
(2) otherwise OFFER to research the provider's quota endpoint or a third-party tool that solved it,
and on the user's consent report the findings (endpoint, credential location, response shape) so a
new `QuotaSource` is added. That is the progressive-coverage flywheel.

A scheduled dev-side routine widens the same coverage from the other end: scan for additional
providers worth supporting, research each candidate's quota-read recipe in the
`cross-provider-quota-matrix.md` form, and re-verify existing sources' methodologies for drift or
newly-exposed capabilities. Findings land as matrix updates proposing new sources or fixes.

---

## 4. Pool identity — quota is account-level

Quota is billed and reset **per account**, not per provider and not per surface. Pool identity is
therefore the pair **(provider, account)**, refined to **(provider, account, model)** where a
provider exposes per-model windows. Two consumers share a pool **iff** they resolve to the same
`(provider, account)` — because that is the meter that returns the 429. This is exactly what
`pool_id` names: `codex#<account-uuid>/<model>` = `provider # account / model`.

- **Same provider, SAME account → ONE pool.** A Claude Desktop host plus Claude CLI subagents on
  the same account resolve to one `(claude, acct-A)` pool: a single `/usage` reading governs both,
  and consumption on either surface draws down the same windows. Probing both credentials returns
  the same numbers; collapse to one source.
- **Same provider, DIFFERENT accounts → TWO independent pools.** Host on account A, subagent CLI on
  account B ⇒ `(claude, acct-A)` and `(claude, acct-B)`, each with its own reading, remaining-%,
  reset, sizing and throttling. They do not share budget: exhausting A's 5-hour window does not
  touch B. Fanning subagents onto a second account's CLI is the intended way to get more aggregate
  throughput, so the design must keep the readings separate rather than letting one credential's
  snapshot masquerade as both.
- **Different providers → independent pools, always.** Sized and throttled separately, then
  combined into one dispatch-capacity figure.

**Account identity is read from the credential, never guessed.** Each provider's credential already
carries it (Claude OAuth: the account/org on the token; Codex: `account_id` in its auth file). The
host pool's account comes from the host credential; each target pool's from that target's. Same
provider + equal account id → merge (one pool); differing ids → keep separate.

**The one exception is handled by derivation, not by guessing.** Bare-API-key and proxy-fronted
sources have no credential handshake to read an identity from, so `deriveAccountKey`
(`src/shared/quota/accountId.ts`) derives a LOCAL, credential-value-free key —
`(service, endpoint, api_key_env)`, or `(service, explicit-account)`. It is a third deterministic
mechanism, neither read-from-credential nor guessed, and it is **service-scoped** so that several
backends behind ONE proxy — which share the proxy's endpoint and master key — stay distinct
accounts.

That single `accountKey` is carried on `CapacityPool.accountKey`. It is the SAME partition the
budget ledger meters against AND the cooldown fold groups by: one derivation, never re-derived at a
consumer. Key resolution and stamping are realized across `src/shared/providers/identity.ts`
(`quotaPoolKey`), `src/shared/quota/httpQuotaSource.ts` (`parseProviderModelKey`),
`src/shared/quota/quotaSource.ts` (`resolveAccountIdSafe`), `src/shared/quota/apiPool.ts`
(`buildHostModelPools` / `buildSourcePool`), `src/shared/quota/accountId.ts`, and
`src/shared/quota/compositeQuotaSource.ts` (`buildAccountScopedQuotaSource`).

A bare `provider/model` key suffices only while there is exactly one account for that provider in
the run; once a second same-provider account is a dispatch target the account segment is mandatory
so the two pools never alias. The §3.4 self-gating holds per pool: a source answers for the
`(provider, account)` it owns and is null-with-no-I/O otherwise, so account B's CLI source never
probes account A's endpoint with A's token.

### 4.1 Worked scope examples

| Host IDE | Dispatch targets this run | Quotas tracked |
|---|---|---|
| Claude Desktop | none (all work in-conversation) | Claude (host) only |
| Claude Desktop (acct A) | Claude CLI subagents (acct A) | Claude only — same account → ONE pool |
| Claude Desktop (acct A) | Claude CLI subagents (acct B) | TWO Claude pools — `(claude,A)` host + `(claude,B)` target, separate budgets |
| Claude Desktop | NVIDIA NIM + Ollama | Claude (host) + NIM (reactive) + Ollama (unbounded-local) |
| Codex Desktop | none | Codex (host) only |
| Codex Desktop | OpenRouter | Codex (host) + OpenRouter |
| Codex Desktop | — | NEVER Claude Desktop's quota |

### 4.2 Why it is built this way

- **No central authority exists** in a conversation-first product, so quota reasoning is local to
  the running instance. A run can only honestly account for budget it itself spends.
- **Self-monitoring is the safety boundary.** Probing only own + chosen-target providers keeps the
  tool off endpoints and creds it has no business touching, and makes the all-sources-registered
  composite safe: it is inert for unused providers.
- **Host-first because the host gates everything.** Even a run that offloads heavily to cheap
  subagents still pays host tokens per orchestration step; exhausting the host stops the run
  regardless of target headroom.

---

## 5. Admission control — concurrency is emergent, not computed

Dispatch is not fixed-N waves. It is continuous admission control against a live budget. One task
is admitted at a time; how many end up in flight is whatever the budget allows at that instant, and
it moves as the budget moves.

```
state: a set of LIVE pools, each with:
         - pool identity: provider # account / model
         - live headroom per active quota window
         - optional hard in-flight cap, IF that pool declares one
loop:  while tasks remain:
         t = next task;  cost(t) = deterministic estimateTokensFromBytes(packet)
         find a live pool p, capable of t, whose EVERY window clears cost(t)
           (and which is under p's declared cap, if any)
         -> admit t to p; RESERVE cost(t) against p's window keys before dispatch
         -> none available? block until an in-flight task completes
on complete:  reconcile the reservation with ACTUAL tokens; update learned quota
on 429/limit: collapse headroom + set backoff on the key
              -> every consumer keyed to it drops out of admission until reset
on crash/timeout: the reservation lease expires -> budget returns automatically
```

A "fixed-limit IDE" is not the model — it is *one pool that declares an in-flight cap* as an
optional constraint. Heterogeneity is native: each admitted task goes to whichever live pool has
headroom, and pools join or leave between admissions (cooperative multi-agent). The admission gate
is the **single broker chokepoint**: every task passes it, and it enforces per-pool budget,
attribution and backoff mechanically. This subsumes the old scalar — a "token budget of N fit at
once" is just the instantaneous width of the admission window, never a stored number.

**Concurrency is not a computed quantity.** There is no "how many agents" number to derive, report,
or make emergent; the count is entirely a function of quota headroom. The ONLY place an explicit
agent count exists is where a *specific environment declares a hard in-flight cap* — one pool's
optional declared constraint, passed through verbatim, never a value the tool computes. A declared
cap is enforced by COUNT of that pool's outstanding ledger leases (cross-process) plus the current
batch's grants. The host-dispatch path likewise reports no live "emergent number": the tool admits
the set that budget and any declared cap allow, and hands the host exactly that granted set. The
granted set IS the instantaneous admission width. Budget is the thing to think about, not
concurrency.

### 5.1 The shared resource, and how clobbering is avoided

The shared resource is **the provider's rate-limit meter for your credential** — metered against
your account/key/subscription as a windowed budget. It lives on the provider side and is
decremented by every request authenticating as you. Independent admission loops clobber it when
they draw on the *same remote meter* with private optimistic estimates: two IDEs on one account, a
host plus its subagents, a cooperative agent on the same subscription. A self-hosted endpoint or a
login on a different account is a *different* meter. "Shared" is therefore defined by **the
granularity the provider enforces at** — the credential/account (§4).

### 5.2 One shared, lock-guarded reservation ledger

Every admission loop leases against the *same* ledger (`src/shared/quota/reservationLedger.ts`),
keyed by the constraint's resource key — not per-run and not a per-pool copy:

```
admit(task, pool):
  withFileLock(ledger[key]):
    headroom = shared_budget
             - Σ outstanding_leases(key)          # EVERYONE's in-flight, not just mine
             - recorded_consumption(key)
    if EVERY applicable key clears estimate(task):
        write lease{ id, estimate, expires_at, resource_keys[] }   # reserve BEFORE dispatch
        admit
    else: block
on complete:      withFileLock -> replace lease with recorded ACTUAL tokens
on 429/limit:     withFileLock -> collapse headroom + backoff on the key
on crash/timeout: lease expires -> budget returns (no stranded reservation)
```

Properties that stop clobbering:

- **Reserve-before-dispatch under the lock** ⇒ concurrent admitters serialize on the reservation
  and each sees the others' outstanding leases; optimistic estimates cannot multiply across
  consumers. Optimism is bounded by *one* budget.
- **Shared backoff** ⇒ a 429 anyone hits collapses headroom for every consumer on that account, not
  just the loop that tripped it.
- **Leases expire** ⇒ a dead IDE or agent does not strand budget. This reuses the token-checked
  stale-lock cleanup in `src/shared/quota/fileLock.ts`.
- **Reconcile on completion** ⇒ estimate error self-corrects; the ledger tracks *measured* actuals,
  so a wrong up-front estimate cannot compound.
- **Fairness is arrival order.** Co-located consumers serialize on the ledger lock FIFO; there are
  no per-consumer shares. A share mechanism is warranted only against observed starvation on a real
  double-run.

### 5.3 Proactive vs reactive — an honest boundary

A **local** ledger can only coordinate consumers that see the same ledger file.

- **Co-located** (same machine / shared FS / user-scope quota state): *proactive* — reserve against
  the shared account-keyed ledger before dispatch.
- **Cross-machine, same account**: *reactive* — the local ledger cannot see the other machine's
  in-flight work, so the only true defence is shared-key 429/backoff learning on the same key after
  the wall.

Both key to the same `provider#account/model`. **Reactive backoff is the primary, always-correct
safety mechanism; proactive reservation is a refinement layered on top of it, never in place of
it.** The full proactive ledger is the endpoint, not a reactive-only minimal core — but the
ordering of authority between the two is fixed and does not invert.

**The ledger is a proxy, and that is accepted.** Non-audit-tools clients on the same account never
touch it, so proactive reservation is optimistic relative to true meter state. It reduces
co-located overshoot; it never claims to be the meter, and **must not be presented — in any
artifact or prompt — as a hard guarantee.**

### 5.4 Output tokens — reserve an envelope, learn the ratio

A lease reserves `cost(t) = input_estimate + output_reservation`, where `output_reservation` is the
packet's declared output cap while the `(resourceKey, lens)` has no learned history, and the
learned empirical output/input ratio once completions have measured it. On completion the lease
reconciles against **actual (input + output)** tokens, which updates the learned ratio. Output —
the binding constraint in practice — is thereby first-class in the reservation instead of an
ignored axis. Reactive 429/backoff still catches residual under-reservation.

### 5.5 Cold start — probe then widen, only when unknown

When a key has no learned slope, the first admission window is deliberately narrow: admit a small
N, then widen as the first completions calibrate the learned tokens-per-percent and output ratio.
When a learned slope *does* exist for that key, size against it directly — no artificial narrow
probe. Cold start is a measurement bootstrap per `(pool, window)`, never an invented cap.

### 5.6 Legibility — every decision leaves a deterministic trace

Every admit AND every refusal or strand carries the FULL constraint-outcome array it was decided
on: which keys were consulted, each key's headroom before, the packet's cost against it, and which
key refused. The trace is assembled deterministically from ledger state the tool already holds — no
judgment, no sampling.

**A decision path that writes no explain at all is itself a defect of this invariant.** Concretely,
the host-path explain record carries `constraints: ConstraintOutcomeRecord[]` (the decisive
attempt's full evaluation), `binding` (the tightest or refusing key as a full outcome row, never a
one-of-N scalar), and `attempts` (every pool consulted and refused before the decision, with cap
counts and unpriceable-window labels); the lease record names EVERY key it was recorded under
(`resource_keys`). Plan-only display grants write a `planned` explain — no lease, by design, since
the engine decides at dispatch — and that explain is mandatory, not optional. The in-process engine
emits every per-packet decision (admit, ledger block, strand with per-pool why-not) as a stamped
record through one chokepoint (`createDispatchDecisionLog`,
`src/shared/dispatch/dispatchDecisionLog.ts`), wired to the run dir's append-only
`dispatch-explains.jsonl`, or written to stderr when no sink is wired. The fallback is emission,
never silence.

---

## 6. The admission constraints — per-window, never one collapsed number

Admission does not compare a task's cost against one collapsed scalar. **Each active quota window
on a pool becomes its own ledger constraint, and a packet is admitted only when every constraint
clears simultaneously — all-or-nothing at the ledger.** The derivation is single-sourced in
`windowConstraintsFor` (`src/shared/quota/windowConstraints.ts`), the one seam both admission paths
go through — the host grant (`src/shared/dispatch/admissionLoop.ts`) and the in-process rolling
engine — and is consumed identically by audit and remediate.

A MIN-collapsed scalar budget is the **rejected** model: collapsing loses *which* window binds
(illegible refusals) and cannot meter an account-shared window separately from a per-model one.

- **Provider-neutral snapshot.** Every quota source normalizes to
  `QuotaUsageSnapshot { remaining_pct (0–1), reset_at, requests_remaining, tokens_remaining,
  windows[] }`. Each `windows[]` entry is
  `{ label, scope, remaining_pct, reset_at, tokens_remaining? }`, and `scope` is **REQUIRED**
  (`'account' | 'model'`, no default): it declares which partition the allowance belongs to, is
  decided by the PRODUCER (the quota source or source declaration), and is only carried downstream,
  never re-derived at a consumer. The derivation reads only this shape, so a Claude pool, a Codex
  pool and a NIM pool run through identical code.
- **Scope decides the ledger key** (`windowResourceKey`). An `account`-scoped window meters as
  `acct:<accountKey>::<label>` — one allowance shared by every model on the credential, with
  `accountKey` travelling from `CapacityPool.accountKey` as stamped at the producer. A
  `model`-scoped window meters as `pool:<poolId>::<label>` — this model alone, so siblings the
  limit does not cover are never falsely throttled. The namespaces are deliberate: without them the
  two keyspaces collide exactly on the unattributable-source fallback (`accountKey === poolId`),
  and an account window sharing a label with a model window would silently meter as one allowance.
- **Per-window budgets in per-window units.** A `WindowBudget` carries its remaining allowance in
  its own unit: absolute `tokens`, or `percent` with a learned `tokensPerPct` slope. A provider
  exposes several concurrent windows with different denominators (a 5-hour session window plus a
  7-day weekly one; a primary-5h plus a secondary-weekly). The same N tokens is a large percent of
  the small window and a tiny percent of the big one, so slopes are learned per
  `(pool-key, window-label)`. The top-level `remaining_pct` remains the min (binding) window for
  other consumers; admission itself is per-window.
- **A window that cannot price the draw REFUSES the pool.** A `percent` window with no learned
  slope cannot convert the packet's tokens into its unit. Such windows are returned separately
  (`unpriced`; non-empty means REFUSE) and the caller routes the pool through the cold-start clamp
  rather than admitting against the partial constraint set. Silently omitting an unpriceable window
  would meter the packet against fewer allowances than actually bind it — the fail-open direction.
- **No windows at all** (no live signal, or the cooldown path that skips derivation) → one
  pool-keyed fallback constraint carrying the pool's own scalar budget, deliberately **never
  `+Infinity`**, so a caller still holding a finite `remaining_token_budget` keeps its ceiling
  instead of silently over-admitting.
- **`openai_compatible` converges onto the same source-pool shape.** A legacy `openai_compatible`
  config block carries its own `quota` (the same `QuotaModelLimits` shape a `sources[]` entry
  carries) and runs through identical constraint derivation rather than falling to a generic
  default-token floor.
- **Learning wiring.** The rolling engine samples the pool's snapshot around dispatch and attributes
  spend: `slope_sample = Δtokens_dispatched / Δutilization_percent`, folded into a per-key EWMA in
  `quota-state.json` — the same learned-limits machinery as RPM/TPM learning, degrading to cold
  when there is no history.
- **Pool-level `resourceKey` is a reporting label.** Once per-window budgets are populated they are
  the metering basis; the pool-level key survives for the explain artifact's pool label, and the
  pool-level scalar `budget` survives as the cold-start batch sizer's rough magnitude and as the
  ceiling of the empty-windows fallback constraint.

`hostConcurrencyLimit` (where a host declares one) and real RPM/TPM still clamp the admitted set;
`reset_at` bounds how long a fully-spent pool stays parked before it refills.

**Where a host reports usage, the slope learns from it.** On the claude-code host path the slope
learns from host-reported `token_usage` when the host stamps it
(`recordHostTokenUsageObservation`, `src/audit/cli/dispatch/tokenUsageObservation.ts`) and degrades
to percent-only otherwise. In the degraded case the operative constraint set is the declared-cap
output envelope (§5.4) plus the reactive 429 floor: the ledger prevents co-located double-counting
but never gates on an absolute token ceiling. The absolute token-budget path is live ONLY where a
provider reports usage (NIM/openai-compatible).

---

## 7. Candidate ordering — an operator-customizable policy

Among the pools *capable* of a packet, two independent axes rank a pool:

- **cost** — `costRank` (dollars per unit work; §7.2). Lower is cheaper.
- **throughput** — how fast the pool sustainably absorbs work (§7.3). Higher is faster.

These trade off: the cheapest pool is rarely the fastest, and the set of non-dominated
(cost, throughput) pools is a discrete Pareto frontier. **Ordering is therefore a policy the
operator sets, not a fixed rule of the system.** A single durable scalar — the **dispatch bias**
λ ∈ [0,1] — picks the operating point on that frontier:

- **λ = 0** → pure cost. Cheapest-capable-fill, the frontier's minimum-cost corner.
- **λ = 1** → pure throughput. Route to the fastest capable pool regardless of price.
- **0 < λ < 1** → a blended operating point between the two.

λ = 0 is the **default**, so an operator who says nothing gets cheapest-capable-first. That is one
setting of the dial, not an unconditional property of dispatch. The dial is **1D** — cost ↔
throughput — with capability as a hard floor rather than a tradeable axis.

### 7.1 Capability is a hard floor, never traded

`capable()` runs first and gates eligibility; the dial ranks only among pools that pass. The floor
composes size-fit (`capacityTokens >= packet.cost`, inert when the pool declares no capacity) with
a per-packet capability floor computed **relatively over the currently-available pool set** — never
from a named-model→tier map — and it fails OPEN on a pool with no capability signal rather than
blocking dispatch.

**Quality as a second tradeable axis (a true 2D dial) is declined on the shape of the quantity, not
on effort: capability does not degrade smoothly.** A model above the floor produces usable output;
one below it does not produce cheaper, slightly-worse output — it produces output that fails review
and costs a full retry plus the wasted first attempt. A tradeable axis presumes a continuum that
buys something at the low end, and here the low end has negative value. That is exactly what a
floor encodes, so the floor is not a simplification of a 2D model, it is the correct shape. A 2D
dial would also require a per-task "what is better output worth here" weighting that does not
exist, is not derivable from anything measured, and would land as an operator knob — which this
project treats as a bug signal.

**The invariant: capability gates eligibility and is never traded away for price or speed.**

### 7.2 The cost axis — `costRank`, four rungs

`costRank` answers "how many dollars per unit of work". It is **independent of `capabilityRank`**
("is this pool strong enough"): a change to cost policy is a change to one rung of one field, and
capability routing plus the capacity-fit gate are untouched. `deriveCostRank`
(`src/shared/dispatch/costRank.ts`) resolves top-down, mirroring `resolveLimits`' rung structure:

1. **Operator-confirmed ordering** (highest). When the run carries a confirmed provider/model cost
   ordering (§7.5), a pool's `costRank` is the confirmed integer position of its provider/model.
   The operator ordered *every* candidate — including unknown-price ones — so this rung is total
   and internally consistent. A pool that appeared after confirmation carries no confirmed position
   and falls through to price/tier, sorting AFTER the confirmed ones.
2. **Operator-declared per-source price.** When a pool's own configured source declares a `$/Mtok`
   (`sources[].cost_per_mtok`, mapped into `CostRankInput.declaredCostPerMtok`), that value is authoritative over the generic catalog — the operator
   knows their own endpoint's cost, and a free arbitrage backend declaring `0` sorts free-first. A
   negative or non-finite declared value is ignored and falls to the next rung, never trusted as
   "free".
3. **Dataset price.** Otherwise `costRank` is the model's **blended price**: a single representative
   $/Mtok scalar = `input · 0.75 + output · 0.25`. The blend is prompt-heavy because the workload
   reads far more than it writes, but output price is typically 4–5× input so it is not dropped.
   Cheaper sorts first. Price resolves from the vendored models.dev snapshot via
   `resolveModelStatics`, consumed degrade-to-empty: unknown model id ⇒ no price ⇒ fall through,
   never fabricate.
4. **Tier ordinal** (fallback). With no confirmed position, no declared price and no resolvable
   dataset price, `costRank` falls back to `tierRank(pool.rank)`.

**Total order, no scale-mixing.** Rungs never interleave within a pass: the band bases are
disjoint, so the order stays total even when a pool appearing after confirmation falls through to
price/tier, and an unknown-price pool is offset to sort after all priced
pools (`UNKNOWN_PRICE_BAND_BASE + tierRank`), preserving tier order among the unknowns. So
all-known ⇒ ordered by real dollars; all-unknown ⇒ ordered by tier; mixed ⇒ priced pools first by
dollars, unknown-price pools after by tier — "route to the provably-cheapest first, treat
unknown-cost as overflow". A dollar value is never compared against a tier ordinal.

**Collision resolution prefers the cheapest priced candidate.** The snapshot flattener
(`scripts/shared/update-models.mjs`) visits providers alphabetically and, on a cross-provider
model-id collision, keeps the entry with the lowest blended price (ties broken by sorted-provider
order; an unpriced record always loses to a priced one). Every provider's own record stays indexed
under `byProvider`, so a provider-scoped lookup can pin the native price instead of taking the
cheapest-collision default.

### 7.3 The speed axis — auto-derived concurrency, pool-class-aware

**Throughput is the pool's declared CONCURRENCY — how many packets it runs in parallel — derived
automatically from what the provider already states. Nothing is learned, measured, or
hand-declared.** Two constraints fix this shape:

- *Concurrency is declared or absent, never learned.* There is no learned or adaptive concurrency
  ceiling, and no measured tokens/sec signal — that is the class of learned dispatch signal this
  design excludes.
- *A needed manual flag is a bug signal.* The operator must not have to hand-declare a per-pool
  rate to get correct speed routing, so the signal comes from what is already known, never from a
  new operator field.

The signal satisfying both is **effective parallelism**, and it must be derived **pool-class-aware**
— reading it off `declaredCap` is a trap. `declaredCap == null` means *opposite* things on the two
pool classes: "hardware-parallel, genuinely fast" for a backend source, but "no subagent budget
declared ⇒ effectively sequential" for the conversation host. Reusing that one ambiguous sentinel
for the speed rank crowns the zero-declaration default host as fastest and lets it monopolize the
wave at λ=1 — the exact opposite of the dial's intent.

`deriveThroughputConcurrency({ isConversationHost, hostActiveSubagents, sourceConcurrencyCap })`
(higher = faster; `src/shared/dispatch/admissionLoop.ts`) keys on the host-vs-source discriminator,
which `admissionPoolsFromSummaries` projects automatically from
`DispatchCapacityPoolSummary.is_conversation_host` (a pool built from a backend `CapacityPool.source`
is a source; one without is the host):

- **Backend source** — an endpoint accepting concurrent requests: `source.quota.max_concurrent` when
  declared, else **`+Infinity`** (uncapped ⇒ hardware-parallel ⇒ fastest; a local inference server
  is hardware-bound and the operator's config is authoritative).
- **Conversation host** — its parallelism IS its subagent budget:
  `host_concurrency_limit.active_subagents` when declared, else **`1`** (unspecified ⇒ effectively
  sequential ⇒ ranks slowest). This is what stops λ=1 from crowning the default host over a metered
  parallel source, with no manual declaration.

So at λ=1 an uncapped or high-concurrency source out-ranks a sequential host and the dial toward
speed actually pushes work onto the parallel pool. `declaredCap` still separately feeds the hard
in-flight cap gate in the spill loop; the throughput rank is its own pool-class-aware quantity, not
a reuse of the cap's ambiguous null. Declared rate limits (TPM/RPM) are **not** part of the
throughput rank — mixing a tokens/min magnitude with a concurrency count is unsound — and their
effect already appears in the pool's *budget*, which gates admission separately (§6).

A discovery probe that reads an endpoint's concurrency or context window at run time is a legitimate
future enrichment of this signal, provided it stays auto (never a hand-declared rate) and
sanity-clamps a probed value before it reaches the rank, so a poisoned probe cannot over-admit.

### 7.4 The blend — ordinal, total order preserved

`costRank` lives in disjoint numeric bands (§7.2) and a $/Mtok value cannot be linearly blended
against a concurrency count. The blend is therefore over **per-axis ordinals within the current
candidate set**, computed *after* the capability filter, in `orderCandidates`
(`src/shared/dispatch/admissionLoop.ts`):

```
candidates    = pools.filter(capable(·, packet))          // capability hard floor
costOrdinal   = rank by costRank ascending                // 0 = cheapest
speedOrdinal  = rank by throughput descending             // 0 = fastest
blended(pool) = (1 − λ)·costOrdinal + λ·speedOrdinal
sort by blended ascending, tiebreak capabilityRank descending, then cost, then poolId
```

Properties:

- **λ ≤ 0, or a single candidate ⇒ the pure cost comparator**, returned directly without computing
  ordinals. Above zero the blended comparator applies. The ordering is thus exactly cost-first at
  the default and only at the default.
- **Total order preserved.** Ordinals are dense integers over the same candidate set, so the blend
  is always a well-defined total order — no scale-mixing, matching the cost axis's own no-scale-mixing
  property. Deterministic pool-id tiebreaks make the ordinal assignment stable.
- **Frontier walk.** As λ rises the blend's argmin walks the non-dominated (cost, throughput) pools
  from the min-cost corner toward the max-throughput corner.
- **The λ clamp is enforced at the chokepoint.** `admitBatch` clamps λ into [0,1] and coerces a
  non-finite value to 0, so no caller can make the single ordering seam emit a NaN comparator
  (callers pre-clamp as well; this is the enforced floor).

**The blend enters at exactly one place** — `orderCandidates` feeding the per-packet loop in
`admitBatch`, the single point where pool ordering is decided. Spill (walking to the next pool on
budget or cap exhaustion), the reservation ledger, and claim-before-assign are unchanged by it: the
dial reorders *which pool is tried first*, never weakens a headroom or safety gate.

### 7.5 Where the policy is set — Gate-0

Both the cost ordering and λ are **durable policy captured once**, at the `provider_confirmation`
step — the run's first obligation — and never a per-packet menu (which would tax conversation-first
context and risk livelock).

On the conversation-first audit CLI path this is an **interactive host-delegation step** parallel to
`confirm_intent`: the tool renders a suggested priced ordering and the host confirms or reorders it.
The headless path (`advanceAudit`, no CLI host) auto-completes with the tool's suggestion and
`dispatch_bias = 0`, so nothing blocks when there is no operator and the default is the safe
minimum-cost corner.

- **Candidates are gathered from every knowable source at the step.** Configured source models are
  priced at the outset; the host **self-reports its own model roster** in the step's input
  (`host_models` — it *is* the agent, so the roster is knowable at confirmation), and those
  host-native tiers are priced and ordered here rather than only at dispatch. A CLI backend whose
  roster is not knowable until spawn contributes at provider granularity, priced "resolved at
  dispatch" and placed by capability tier in the suggestion.
- **The tool prices each candidate** via `resolveModelStatics`, computes the blended $/Mtok, and
  **suggests** an ordering (ascending price, capability tiebreak). Unknown-price candidates are
  flagged and placed last within their tier.
- **Dispatchable sources fold into the SAME unified ordering.** Configured `sources[]` pools and
  ambient expansions are ranked alongside provider/host candidates, not in a separate list
  (`collectDispatchableSources`, `src/shared/quota/apiPool.ts`). Source candidates
  are keyed under a `source::` namespace internally so a source id can never collide with a
  provider name, but the operator's `cost_order` may name a source by its **displayed bare id** —
  the bare form is an accepted alias, and exact candidate keys always win a token. Declared cost
  wins pricing precedence for a source; registry/catalog list price is the fallback.
- **The operator confirms or reorders — input/envelope split.** The host writes a plain
  `provider-confirmation.input.json` (schema `provider-confirmation-input/v1`,
  `src/shared/types/providerConfirmation.ts`: an optional `cost_order` list of provider/model keys,
  `exclude`/`include`, `host_models`, and an optional **`dispatch_bias` ∈ [0,1], default 0**); the
  tool owns the canonical envelope. The input's presence is the "operator has acted" signal that
  flips the gate from *emit the step* to *consume the input*. The deterministic executor promotes
  the submission into both canonical artifacts — the per-tool `provider_confirmation.json` seam and
  the shared `provider-confirmation.json` —
  with the tool-owned cost annotation, then DELETES the submission (consume-and-invalidate: a spent
  input must not auto-satisfy a later reconciliation it never answered).
- **The operator supplies ordering intent and a roster; never prices or capability flags.** The
  confirmed order persists on `PersistedPoolEntry.cost_order` for provider pools and
  `host_model_cost_order` for host tiers, read back at dispatch as rung 1 through a single
  model-keyed positions map (`readConfirmedCostPositions`,
  `src/shared/providers/sharedProviderConfirmation.ts`); λ persists beside it and is read back by
  the sibling `readConfirmedDispatchBias`, both threaded into `admitBatch`. `ConfirmedPoolEntry` is
  the in-memory render DTO and by design never reaches disk. Remediate has no standalone
  confirmation step: it consumes the same persisted confirmation.
- **The gate fires on every interactive run**, even with one or zero auto-detected providers — the
  operator may want to reorder, exclude, self-report a roster, or **add a provider discovery
  missed** (an OpenAI-compatible endpoint or a configured CLI backend that was not surfaced).

**Static policy, dynamic execution.** Gate-0 fixes the *policy* (the ordering and λ); the router
*realizes* it against the LIVE frontier at every dispatch. Declared limits, live budget headroom,
cooldowns and contention all shift under rolling dispatch and parallel IDEs, so the policy applies
to whatever the candidate set actually is at admission time, never to a frozen Gate-0 snapshot. The
Gate-0 suggestion is best-effort (it prices what is knowable there); the deterministic
price→`costRank` engine at dispatch — where the per-model roster is always known — is the always-on
floor, and Gate-0 is the operator's approval/override layer on top of it, not a replacement.

### 7.6 Free-pool maximization falls out of the frontier

Price-0 pools carry the minimum `costRank`, so at every operating point with λ < 1 they are
first-fill ahead of any paid pool: free capacity saturates before paid capacity **automatically**,
as a property of the frontier rather than a separate mechanism. "Saturated" means filled to the
pool's declared sustainable ceiling — declared cap, rate limits, and the reactive 429 floor — not
flooded; the naive free-flood failure mode is precisely what those gates already prevent.

Registering actual free sources as price-0 pools is a separate concern (the arbitrage-tier track).
This spec guarantees only that a registered price-0 pool is first-fill, which `costRank` already
delivers.

---

## 8. Claims, capability feed, and JIT reservation

Pre-binding conflates three separable things. They are separated:

- **CLAIM — exclusivity, not routing.** A claim on a node/packet says *someone is working on this*,
  never *on which backend*. The `ClaimRegistry` (`src/shared/quota/claimRegistry.ts`) owns
  exclusivity — lease, TTL, ownership — and decides grants on **presence and staleness only**: a
  node is claimable when unclaimed or when the existing claim's heartbeat is older than the stale
  window. No routing decision is encoded in, or read from, a claim.
- **`poolId` on a claim is the OWNER IDENTITY, not a backend binding.** It names who holds the
  claim, and two paths depend on that identity: `claimMany` re-grants a node already held by the
  SAME `poolId` (heartbeat refreshed), which makes a caller that re-runs its partition under a
  stable id idempotent while pools still partition disjointly; and `releaseOwned` releases, in one
  lock-held pass, only the claims still held by that `poolId`. Exclusivity itself never consults
  it.
- **CAPABILITY FEED — live metadata, not assignments.** The dispatch planner feeds the orchestrator
  a current view per source: quota headroom, rate state (RPM/TPM, cooldowns), cost, capability
  rank, worker kind. It recommends; it never binds.
- **JIT RESERVATION — quota is reserved at the moment of launch.** The orchestrator selects a
  backend for a claimed packet *right before calling the provider*, reserving quota against the live
  ledger then, not at plan time. A reservation is short-lived and releases on completion or failure
  — the same lease/reconcile machinery of §5.2, applied at the latest correct moment.

    effective route = claim (who)
                    × live feed (what is open)
                    × selection policy (λ over cost↔throughput, capability floor)
                    , resolved at launch time

**Nothing persists a packet→pool binding. A binding that cannot be represented cannot go stale.**

### 8.1 Invariants

- One pool identity ⇒ one launchable source (`service[#account]/model`); the claim never duplicates
  or overrides that identity.
- The only legitimate holds on a runnable packet are a true predecessor unlock, a quota-window
  refresh, or rate limiting. "Planned onto a busy pool" is not a hold.
- Selection is per-packet at launch — per-worker backend routing rides this, at the same moment a
  proxied worker lane composes its namespaced model string.
- **Degradation is uncapped-but-loud.** With no live feed (blind pools), selection falls back to
  declared/ambient ordering; the tool never invents a ceiling.
- **Multi-agent.** Claims stay valid under concurrent admitters; reservation contention resolves at
  the ledger (account-keyed), never by partitioning packets up front.
- Reservation TTLs reuse the existing lease/reconcile paths; a lease that outlives its worker
  expires and returns budget.
- The in-process rolling engine already approximates this endpoint (slot-pull,
  dispatch-to-capacity, refill-on-completion); the host path is the remaining deviation — §9
  pins the shape it converges onto.

---

## 9. Host-path admission shape

The model hands the host exactly the granted set. That has more than one faithful implementation,
so the shape is pinned — an any-strength builder must land the same one without re-deriving it
(auditor-agnostic robustness). It applies to the host-dispatch prompt path in BOTH orchestrators
(audit `dispatch_review`, remediate rolling session).

- **The plan stays whole; a `granted_packet_ids` list carries the admission.** The dispatch plan is
  NOT re-emitted as a shrinking subset each step. The tool runs ledger admission at the dispatch
  step and writes the admitted ids plus the per-admission explain records
  (`{packet_id, pool_id, admitted, reason, constraints[], binding, attempts[], cost}`, §5.6) onto
  the dispatch-quota artifact; the host dispatches EXACTLY `granted_packet_ids` and nothing else.
  This keeps the plan a stable content-addressed artifact (one home for the packet set), puts the
  granted set and its explains in one place, and makes the host's rule trivial: dispatch these ids.
  Leases are taken at grant and reconciled at result-ingest (merge-and-ingest / accept-node); the
  next `next-step` re-grants from the still-pending remainder until the plan is exhausted. The
  granted set's size is the instantaneous admission width — emergent, never a computed or reported
  number. *Rejected alternative:* emitting only the granted subset into the plan/prompt each step —
  it forks the plan artifact across steps and loses the stable whole-plan identity.
- **Admission is orthogonal to the top-K coverage budget — two distinct axes, applied in order.**
  The `max_packets` top-K cap (`filterPackets` → `deferred_packet_ids`,
  `src/audit/cli/dispatch/packetFilter.ts`) is a COVERAGE budget: which packets are in scope for
  the whole run. Ledger admission is a QUOTA gate: how many in-scope packets are granted THIS step.
  Top-K filters first, bounding the plan; admission then grants a subset of the survivors. They
  never fold into each other — a top-K deferral is permanent for the run (out of scope), an
  admission deferral is transient (re-granted next step once a lease frees). Both may be present at
  once: the plan carries the top-K survivors, `granted_packet_ids` the admitted subset of those.
- **The constraints admitted against come from the pool's live quota snapshot, not a new source.**
  `windowConstraintsFor` (§6) turns the pool's window allowances into one ledger constraint per
  window, using the slope the rolling engine already learns
  (`recordTokensPerPctObservation`) and the snapshot the quota source already supplies. Cold start
  routes through probe-then-widen (§5.5).

---

## 10. What the tooling enforces

Not host memory, not a shipped instruction — these hold on every install:

- The broker admission gate is the single chokepoint; every task passes it.
- Quota is attributed per real account key, always: a Claude fan-out can never be charged against
  Codex's meter, nor a NIM pool against Codex.
- The active pool set is per-invocation; no pool is fabricated from stale `sessionConfig`, and
  `sessionConfig.provider` is demoted to the headless in-process pool only.
- The current driver's descriptor rides the returned continue-command, so it survives that driver's
  own steps without the host "remembering"; a *different* driver entering through its own loader
  overrides with its own descriptor. This is deliberately not "persist to the run", which froze one
  auditor's identity onto another — the descriptor rides the conversation that owns it.
- **ONE fan-out over the eligible pool set; the primary backend is always a source pool.** A
  configured in-process backend (codex / opencode / openai-compatible / agy, plus the
  command-shaped backends under remediate's policy) folds into the source-pool set
  UNCONDITIONALLY (`primaryInProcessSource` via `collectDispatchableSources`); there is no demote
  flag and no monopoly branch. The attended/headless split is **pool-set membership, not a
  predicate pair**: attended (`host_can_dispatch_subagents: true`, the conversation-first default)
  means the conversation host participates — remediate as a member pool, audit as the
  coverage-driven complement reviewer and never a coordinator claimant — and the frontier fans
  across host + backend + endpoint concurrently; headless means no attended host in the set, so the
  engine drives the whole frontier. Same fan-out, degenerate case.
- **Host-pool identity is decoupled from the folded source.** The host keys to the conversation host
  (`resolveHostDispatchProviderName`, single-sourced in
  `src/shared/providers/providerPathGuard.ts`) while the backend's own source pool keys to the
  backend. A same-agent collision — conversation host provider equals the primary backend, one
  credential/account, where two pools would double-book the meter and could collide on one
  `pool_id` — resolves through the shared cross-class dedup (`dedupHostAndSourcePools`): on a
  provider+account identity collision the SOURCE/engine pool survives when its provider is an
  in-process worker (the engine drives that single account), and the HOST pool survives otherwise.
- **There is no reported concurrency number.** The operator override for the in-flight subagent cap
  (the `--auditor` descriptor's `self.max_active_subagents`) is an explicit operator-only hard cap —
  one pool's optional in-flight constraint — never the primary source and never an LLM's answer to
  "how many?". There is no precomputed `max_concurrent_agents`; fan-out width is emergent.
- **The shared reservation ledger** sits alongside the learned-quota store
  (`readQuotaState` / `recordWaveOutcome`), under the same `withFileLock`, keyed by resource key
  (the dispatch-quota schema's `in_flight_tokens`, `remaining_token_budget`).

### 10.1 Parity — one shared path, not two kept in step

- **One `AdmissionPool` builder.** Both orchestrators construct their `AdmissionPool[]` through the
  single shared `admissionPoolsFromSummaries(summaries, confirmedCostPositions)` — audit summarizes
  its dispatch capacity (`finalizeDispatchQuota`, `src/audit/cli/dispatch/quotaPool.ts`), remediate
  passes `schedule.capacity_pools`
  (`src/remediate/steps/dispatch/waveScheduling.ts`) — and that function derives budget,
  declaredCap, costRank, capabilityRank, throughputConcurrency and capacityTokens once. There is no
  per-orchestrator pool-construction map to drift.
- **One ordering path.** Both derive candidate ordering through the one shared `admitBatch`, with λ
  threaded identically via `computeDispatchAdmission`.
- **One driver-identity resolver.** `resolveHostDispatchProviderName` returns the conversation host
  for a headless primary and otherwise delegates to `resolveHostProviderName`. Both orchestrators
  call that same function (`src/remediate/steps/dispatch/waveScheduling.ts`,
  `src/audit/cli/semanticReviewStep.ts`); `src/audit/cli/rollingAuditDispatch.ts` only RE-EXPORTS
  it. There is no audit-side wrapper and no per-mode fallback: the asymmetry is removed rather than
  documented.
- **One constraint derivation.** `windowConstraintsFor` is the single seam for the host grant and
  the in-process rolling engine alike.

---

## 11. Failure and pause semantics

- **429 / rate limit** → collapse headroom and set backoff on the key. Every consumer keyed to it
  drops out of admission until reset. Shared-key reactive backoff is the always-correct floor
  (§5.3).
- **Quota-death is a retryable pause, never a node failure.** A detected session/rate-limit worker
  death is a pause-until-`reset_at` plus preserve-worktree plus re-dispatch — an early return before
  worktree removal in `acceptNodeWorktree` — so quota-killed work is distinguished from real
  failure and partial worktrees are not lost.
- **Crash / timeout** → the reservation lease expires and budget returns automatically; no stranded
  reservation, no manual cleanup.
- **Over-declared window** → early actuals or a 429 pull admission back down; the run pauses
  gracefully rather than crashing.
- **No capable pool for a packet** → an explicit `no_capable_pool` refusal with its explain record,
  not a silent drop.
- **Unpriceable window** → refuse the pool and route through the cold-start clamp (§6), never admit
  against a partial constraint set.
- **No live feed at all** → declared/ambient ordering, uncapped-but-loud; never an invented ceiling.

---

## 12. Observable invariants

- A flagless resume by a *different* auditor never sizes against, or charges, the original
  auditor's quota.
- Two co-located runs on one account never collectively exceed the account budget (no 429 storm)
  when a metered provider and a large target actually exercise the wall. `AUDIT_TOOLS_LIVE_QUOTA=1`
  enables only the live-credential test probe in `tests/audit/inv2.test.ts`; it does not force a
  production wall.
- A wrong (over-large) declared window self-corrects: early actuals or a 429 pull admission back
  down and the run pauses gracefully.
- The dispatch-quota artifact explains every admission well enough that a human can reconstruct why
  the fan-out was the width it was — and every decision path writes an explain (§5.6).
- **λ = 0 ordering is exactly the cost-first ordering.** The dial is additive and its default
  operating point is the min-cost corner; a test asserts the λ=0 admission order over a mixed pool
  set equals the pure cost-first order.
- **Throughput is auto-derived, pool-class-aware effective parallelism** — a pure function of the
  declared source cap or host subagent budget plus the `is_conversation_host` discriminator. No
  learned ceiling, no measured tokens/sec, no EWMA over speed, and no new operator rate field.
- **Capability stays a hard floor**; the dial ranks only among capable pools.
- **The dial reorders, never un-gates**: declaredCap, ledger headroom, cooldowns and
  claim-before-assign all apply after the ordering, unchanged.
- **`costRank` and `capabilityRank` are independent.**
- **No model→price and no model→concurrency literal in backend code.** Price comes from the vendored
  dataset via `resolveModelStatics` (consumed degrade-to-empty) or an operator's own declaration;
  throughput comes from the provider's declared concurrency or a future discovered probe.
- **Admission is all-or-nothing across a pool's windows**; no MIN-collapsed scalar decides a grant.
- **A claim decides on presence and staleness only**; `poolId` is owner identity and never routes.

---

## 13. Relationship to the surrounding machinery

This design generalizes and unifies what already exists: the `--auditor` descriptor's `self.roster`
model pools, endpoint spill pool overrides, `capacity_pools[]`, the `ClaimRegistry`, the host-session
quota source, and the learned per-`(provider, model)` quota store — all already account-aware in the
`pool_id`. They compose under **one per-invocation pool descriptor plus one admission gate**: the
`ClaimRegistry` coordinates *task* claiming across agents, and the ledger adds *quota* claiming
(token leases) on the same shared, account-keyed, lock-guarded pattern.
