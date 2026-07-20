# Backend identity — the three axes

> Durable concept doc. What a "backend" IS, the axes that identify one, and which axis each
> downstream question binds to. The recurring defect class this closes: a consumer picking the
> wrong axis, silently, and no one noticing because every axis is a `string`.

## The problem this exists to end

One word — `provider` — carried two unrelated concepts, and a third field (`endpoint`) carried two
unrelated shapes. Every downstream keyspace then had to independently rediscover which concept it
needed. They did not all get it right:

- the **quota ledger** correctly keyed on the serving vendor (`backend_provider ?? provider`);
- the **Gate-0 confirmation gate** keyed on `model_id ?? provider`, dropping the vendor entirely —
  a confirmation BYPASS (confirming one vendor's model approved another vendor's identically-named
  model), fixed in v0.33.11;
- the **exclusion matcher** keyed on the transport, which is correct for its own question but was
  briefly proposed as the single unified identity — which would have been fail-OPEN.

Three consumers, three answers, one of them a security defect. The cause is not carelessness. It is
that the domain has **more than one identity**, the type system expressed none of them, and the
naming actively pointed the wrong way.

## The three axes

A dispatchable backend is identified by three ORTHOGONAL axes plus the model. They are orthogonal in
the strict sense: fixing any two leaves the third genuinely free.

| Axis | Answers | Namespace | Examples |
|---|---|---|---|
| **transport** | *How* we talk to it — the adapter / code path | **CLOSED** (~10) | `openai-compatible`, `codex`, `claude-worker` |
| **service** | *Who* serves the model — whose capacity, account, rate limit, bill | **OPEN** | `nim`, `openrouter`, `anthropic` |
| **locus** | *Where* it is — the concrete address dialed or command spawned | open, two SHAPES | `https://…/v1`, `claude` |

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
| "What does this cost?" | **model** (+service for declared price) | Prices are per-model; a service may declare an override. |

**Different questions legitimately bind to different axes. That is the domain, not a defect.** The
instinct to collapse them into "one identity function" is wrong and was tried: it produces either a
gate that approves backends the operator never saw, or an exclusion rule that matches nothing.

## The invariant that replaces "one identity"

> **Co-locate and name; do not unify.**

Every axis-derived key is produced by a named function in ONE module, each documented with the
question it answers. Divergence between them is then visible in a single file rather than
rediscovered per-consumer.

```
serviceIdentity(ref)        → "nim:z-ai/glm-5.2"      // the confirmation gate
quotaPoolKey(ref, account)  → "nim#acct/z-ai/glm-5.2" // the ledger
transportRoute(ref)         → "claude-worker:z-ai/glm-5.2"
```

They are near-identical strings answering different questions. Adjacency is the safeguard — a reader
choosing one is shown the others.

## Normalization at the chokepoint

`service` is **never optional downstream.** It is normalized once, at the single source-gather
chokepoint, as `declared_service ?? transport`:

- a direct source has service == transport (`openai-compatible` reaching its own endpoint), and
- a fronted source declares the service it routes to.

This kills a real fragility: while `service` was optional, a direct source that simply omitted it got
identity `openai-compatible:model` while its proxied twin got `nim:model` — so the two **stopped
folding**, and the operator was re-asked about a backend they had already approved. The fold must not
depend on whether a declaration happened to include an optional field.

## `locus` is a discriminated union, not a string

The old `endpoint` field held *either* a URL (API transports) *or* a launcher command (CLI
transports), typed as one `string`. A reader cannot tell which without already knowing the transport.

Two honest notes on the strength of this argument, because an earlier draft of this document
overstated it. There is **no live parsing bug**: `endpointHosts` guards on `includes("//")` and falls
through to a raw-literal match, so hostname parsing never runs over a launcher command. What is
actually wrong is a CONFLATION — the tier called "host" silently doubles as a raw command matcher, so
its name is a lie for CLI sources. That conflation is tolerable while the tier is inferred and
undocumented; it becomes untenable the moment the grammar names its axes out loud, because an
operator writing `host:` on a CLI source is then being told something false about what they matched.

So the union is justified BY the grammar redesign rather than independently of it, and on its own it
would be a lower-priority cleanup.

```ts
type Locus = { kind: "url"; url: string } | { kind: "command"; command: string };
```

Host-tier rules apply only to `kind: "url"`. A command is not a host and must be unrepresentable as
one.

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
model:glm-5.2                       that model, wherever it is served
```

Three properties follow, and each retires a known defect:

1. **Unambiguous against open namespaces.** The axis is stated, never inferred, so an open `service`
   namespace costs nothing. The same pattern string means the same thing on every machine.
2. **An unknown axis is a PARSE ERROR, not an inert rule.** The "typo'd rule persists happily and
   matches nothing, silently" defect becomes impossible — the rule is rejected where it is authored.
3. **`service:nim` closes every transport reaching nim, including transports discovered later.** The
   multi-transport residue is gone, and gone *durably* — a snapshot of today's transports would have
   decayed the moment proxy expansion added a route.

The autonomous fail-closed write emits the **service** axis, because that is the axis that does not
decay.

## What this deliberately does NOT do

- **It does not unify the keyspaces.** See above; that is the mistake this document exists to prevent.
- **It does not make `service` a closed set.** Vendors arrive from registry expansion at runtime.
  Any design requiring an enumeration of them is a design requiring us to hand-maintain a vendor
  table, which is forbidden.
- **It does not give `transport` vendor semantics.** A transport is a code path. If a genuinely
  bespoke vendor protocol ever appears, it earns a transport because of the *protocol*, not the brand.
