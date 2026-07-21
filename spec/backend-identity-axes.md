# Backend identity — the axes

> Durable concept doc. What a "backend" IS, the axes that identify one, and which axis each
> downstream question binds to. The recurring defect class this closes: a consumer picking the
> wrong axis, silently, and no one noticing because every axis is a `string`.

## The problem this exists to end

One word — `provider` — carried two unrelated concepts, and a third field (`endpoint`) carried two
unrelated shapes. Every downstream keyspace then had to independently rediscover which concept it
needed. They did not all get it right:

- the **quota ledger** keys on the serving vendor in ONE branch of `dispatchableSourceId` — and
  only there. An earlier draft of this document claimed quota "already keys on service"; that is
  **materially overstated** and was refuted. When no `backend_provider` is declared it returns an
  arbitrary explicit `source.id`, or keys on the transport; host quota pools, the `quota` CLI, and
  the remediate host-session keys all key on host/transport identity; and `quotaPoolKey`
  normalizes nothing — it embeds whatever string its caller supplies. The accurate statement is:
  *some* source pools key on the declared service; fallback source pools and every host pool still
  key on transport or host identity. The inconsistency is wider than the defect that exposed it;
- the **Gate-0 confirmation gate** keyed on `model_id ?? provider`, dropping the vendor entirely —
  a confirmation BYPASS (confirming one vendor's model approved another vendor's identically-named
  model), fixed in v0.33.11;
- the **exclusion matcher** keyed on the transport, which is correct for its own question but was
  briefly proposed as the single unified identity — which would have been fail-OPEN;
- the **Gate-0 source fold** deduped on the bare model id, dropping any source that merely shared a
  model string with a host tier or configured pool on a DIFFERENT service.

Four consumers, four answers, one of them a security defect. The cause is not carelessness. It is that
the domain has **more than one identity**, the type system expressed none of them, and the naming
actively pointed the wrong way.

**The fold is the clearest lesson in this document, so do not skip it.** While the gate key was
bare-model, the fold's collision was invisible — it silently *matched*, which WAS the bypass.
Service-qualifying the gate key (v0.33.11) turned that same collision into a LIVELOCK: the source was
dropped from the confirmed record, so it deltaed, the operator confirmed it, the fold dropped it again,
forever. One defect, two faces — fail-open from one side, wedged-shut from the other. Fixing an
identity WITHOUT fixing every filter that feeds it converts a silent bypass into a visible wedge. When
changing any key here, enumerate what filters the input, not just what consumes the output.

## The axes

A dispatchable backend is identified by four axes plus the model. They are *largely* independent —
fixing three usually leaves the fourth free — but the claim of strict orthogonality was challenged and
is not defended here: `transport` and `locus` are correlated (a CLI transport implies a command target),
and `account` is only meaningful within a `service`. What matters is not orthogonality but that each is
separately observable, and that no two can be substituted for one another.

| Axis | Answers | Namespace | Examples |
|---|---|---|---|
| **transport** | *How* we talk to it — the adapter / code path | **CLOSED** (~10) | `openai-compatible`, `codex`, `claude-worker` |
| **service** | *Who* serves the model — whose capacity, account, rate limit, bill | **OPEN** | `nim`, `openrouter`, `anthropic` |
| **account** | *Whose* credential/tenant within a service — the double-grant boundary | open | `nim#work`, `nim#personal` |
| **locus** | *Where* it is — the address dialed and/or the command spawned | open, MULTI-shape | `https://…/v1`, `claude` |

`account` is a first-class axis, not a parenthetical under `service`. Two sources can agree on
transport, service, locus AND model while drawing on independent budgets — and the canonical quota key
is already `(provider, account, model)`. Any model that treats account as a detail of service will
mis-key quota the moment one vendor is used under two credentials.

⚠ `locus` is **not** a two-arm `url | command` union. That was proposed and refuted: a `claude-worker`
lane has a proxy URL *and* a launcher command simultaneously; `subprocess-template` carries a command
ARRAY; `worker-command` carries a per-node command. Any honest model needs a *network target* and a
*launch target* as separate optional facets, not one discriminated union. Until that is designed, the
current single field stands — see the caveat below.

Two things sit OUTSIDE the axes and must not be smuggled into them:

- **`source.id` — an operator OVERRIDE, not an axis.** A declared id becomes the capacity/learned-quota
  key verbatim, even when it is not shaped like any axis. It outranks derivation by design.
- **`worker_kind`** (agentic harness vs. single-shot HTTP) — a dispatch CAPABILITY that changes how
  packets and context overhead are handled, and is overridable independently of transport. It
  identifies nothing.

`transport` is emphatically **not** "vendor". There is no `nim` transport, because NIM ships no
bespoke protocol — it speaks OpenAI-compatible, so it is reached *through* the `openai-compatible`
adapter, or through a proxy via `claude-worker`. This is the single most confusing thing in the area
and the reason the old name has to go.

The same service+model reached two ways:

```
{ transport: "openai-compatible", service: "nim", locus: url("https://integrate.api.nvidia.com/v1"), model: "z-ai/glm-5.2" }
{ transport: "claude-worker",     service: "nim", locus: url("http://127.0.0.1:8791"),               model: "z-ai/glm-5.2" }
```

Same service, same model, different adapter, different address. Every hard question in dispatch is a
question about *which of those columns you meant*.

## Which axis each question binds to

This table is the load-bearing content of this document. A new consumer picks its row; it does not
invent an identity.

| Question | Axis | Why |
|---|---|---|
| "How much quota is left?" | **service** (+account) | The rate limit lives with the vendor. Two transports onto one service share one budget. |
| "Did the operator approve this?" | **service** + model | Approval is about whose model you consume, not the road taken. |
| "Does this operator rule drop this source?" | **whichever axis the rule names** | Policy is authored per-axis — see the grammar below. |
| "Which config block builds this?" | **transport** | The adapter decides the constructor. |
| "Is this backend me (self-spawn)?" | **transport** | Self-spawn is about the process, not the vendor. |
| "What does this cost?" | **model**, disambiguated by **service** | The price table is vendor-keyed. Passing the transport here silently yields the cheapest-collision default — fixed 2026-07-19 (both call sites now pass `sourceService(source)`), and per `docs/backlog.md` inert at HEAD regardless since the current price snapshot carries no cross-provider collisions. A declared per-source price outranks the table. |

**Different questions legitimately bind to different axes. That is the domain, not a defect.** The
instinct to collapse them into "one identity function" is wrong and was tried: it produces either a
gate that approves backends the operator never saw, or an exclusion rule that matches nothing.

## The invariant that replaces "one identity"

> **Co-locate and name; do not unify.**

Every axis-derived key is produced by a named function in ONE module, each documented with the
question it answers. Divergence between them is then visible in a single file rather than
rediscovered per-consumer. They are near-identical strings answering different questions, and that is
exactly why adjacency is the safeguard: a reader choosing one is shown the others.

**Today:** all four projections live in `src/shared/providers/identity.ts`, a leaf module that the
Gate-0 delta, confirmed set, source fold, quota ledger, and routing filter can all import:

```
backendIdentity(model, service)   → "nim:z-ai/glm-5.2"            // the confirmation gate
quotaPoolKey(ref, account)        → "nim#acct/z-ai/glm-5.2"       // the ledger
exclusionPattern(model, transport) → "transport:claude-worker/z-ai/glm-5.2"  // what the routing filter drops
```

## Normalization at the chokepoint

`service` is **never optional downstream.** It is normalized once, at the single source-gather
chokepoint, as `declared_service ?? transport`:

- a direct source has service == transport (`openai-compatible` reaching its own endpoint), and
- a fronted source declares the service it routes to.

This kills a real fragility: while `service` was optional, a direct source that simply omitted it got
identity `openai-compatible:model` while its proxied twin got `nim:model` — so the two **stopped
folding**, and the operator was re-asked about a backend they had already approved. The fold must not
depend on whether a declaration happened to include an optional field.

## `locus`: known-wrong, deliberately unresolved

The old `endpoint` field holds *either* a URL (API transports) *or* a launcher command (CLI
transports) in one `string`. A reader cannot tell which without already knowing the transport.

Two claims made for fixing it did NOT survive review, and are recorded so they are not re-made:

1. **There is no live hostname-parsing bug.** `endpointHosts` guards on `//` and otherwise returns the
   raw lowercased literal, so URL parsing never runs over a launcher command.
2. **Literal command matching is deliberate, supported, and tested** — a rule naming a launcher command
   path matches exactly that command. A `url | command` union would REMOVE a working feature.

And the union is not an honest model anyway: `claude-worker` has a proxy URL and a launcher command at
once, `subprocess-template` has a command array, `worker-command` has a per-node command. The real
shape is a *network target* and a *launch target* as separate optional facets.

**So this is deliberately left alone.** It is the weakest item in this document; the honest status is
"the type is a lie, the proposed fix was worse, a richer launch/network-target model may be worth it
later." Do not implement the two-arm union.

## The exclusion grammar: axis-explicit

The old grammar inferred its tier from the head token against the closed transport-name set. That
worked only while every addressable axis was closed — and `service` is open, so the moment services
became addressable the inference broke. Worse, its failure mode was silent: an unrecognized head fell
through to the host tier, so `nim:z-ai/glm-5.2` parsed as a *well-formed, permanently inert host
rule*. Nothing reported it.

Rules name their axis explicitly:

```
transport:codex                     every model on that adapter
transport:openai-compatible/glm-5.2 one model on that adapter
service:nim                         every model from that vendor, HOWEVER reached
service:nim/z-ai/glm-5.2            one model from that vendor
host:localhost:8000                 by address
```

There is deliberately **no `model:` axis** — see the third precondition below for why a cross-service
model rule is dangerous rather than merely convenient.

Three properties follow, and each retires a known defect:

1. **Unambiguous against open namespaces.** The axis is stated, never inferred, so an open `service`
   namespace costs nothing. The same pattern string means the same thing on every machine.
2. **An unknown axis is a PARSE ERROR, not an inert rule.** The "typo'd rule persists happily and
   matches nothing, silently" defect becomes impossible — the rule is rejected where it is authored.
3. **`service:nim` closes every transport reaching nim, including transports discovered later.** The
   multi-transport residue is gone, and gone *durably* — a snapshot of today's transports would have
   decayed the moment proxy expansion added a route.

The autonomous fail-closed write emits the **service** axis, because that is the axis that does not
decay. The interactive confirmation prompt still renders the narrower `transport:` pattern beside
each backend — an operator deciding one reachable backend is ruling out the lane in front of them,
not every future transport reaching that vendor.

### Three conditions this change must satisfy — it is NOT "strictly better" without them

An earlier draft called the axis-explicit grammar strictly better. That was refuted, and the objections
are real preconditions rather than reasons to abandon it:

- **It is a breaking migration, not an additive one.** Persisted operator policy, the Gate-0 prompt
  template that teaches operators the syntax, and several test fixtures all encode the bare forms.
  Ship a one-shot migration of persisted patterns together with the parser and the prompt text, in one
  atomic change. Do NOT leave a dual parser standing — that reintroduces exactly the "two answers"
  disease this document exists to end.
- **A `model:` axis is DANGEROUS and is deliberately excluded.** A model-only rule matches one model
  string across every service — which recombines precisely the identities the gate exists to keep
  apart, and contradicts the Gate-0 promise that a rendered rule excludes *that* backend and not its
  siblings. If a cross-service model rule is ever genuinely wanted, it needs its own explicit,
  loudly-labeled affordance. It is not an axis.
- **`service:` rules can zero out dispatch capacity, and nothing currently notices.** A single
  `service:nim` can remove every reachable lane; `buildSourcePools` filters and returns `[]` without
  complaint, the headless remediate path has no host fallback, and the autonomous writer persists
  exclusions without ever building the resulting capacity set. The run only strands later, reported
  generically as `partial_reason: "empty_pool"`. **A capacity guard at the point of authorship — "this
  rule removes all dispatch capacity" — is a prerequisite of the service axis, not a follow-up.**

## What this deliberately does NOT do

- **It does not unify the keyspaces.** See above; that is the mistake this document exists to prevent.
- **It does not make `service` a closed set.** Vendors arrive from registry expansion at runtime.
  Any design requiring an enumeration of them is a design requiring us to hand-maintain a vendor
  table, which is forbidden.
- **It does not give `transport` vendor semantics.** A transport is a code path. If a genuinely
  bespoke vendor protocol ever appears, it earns a transport because of the *protocol*, not the brand.
