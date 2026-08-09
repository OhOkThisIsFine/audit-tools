# Backend identity — the axes

> Durable concept doc. Concrete provider/model routing belongs to the external broker;
> this document defines only the identities audit-tools still needs for local enforcement.

## Why more than one identity remains

`provider` historically mixed the adapter used to launch work with the vendor serving a
model. Those are different questions. Dispatch inversion removes provider approval and
ordering from audit-tools, but it does not remove the identities required for quota,
launch, reachability, and self-spawn safety.

The rule is:

> **Name the question, then use the narrowest axis that answers it. Do not invent one
> universal backend key.**

## Axes

| Axis | Answers | Example |
|---|---|---|
| **transport** | Which adapter or process launches the work? | `openai-compatible`, `codex`, `claude-worker` |
| **service** | Which declared capacity/account boundary serves it? | a broker service name or the transport fallback |
| **account** | Which credential/tenant owns the quota? | an opaque account id |
| **model** | Which stable broker intent or explicitly selected model is requested? | `pool/<name>` |
| **locus** | Where is the endpoint or launcher? | `http://127.0.0.1:8791`, `codex` |

`source.id` is an operator-provided pool-id override, not an axis. `worker_kind`
(`agentic` versus `single_shot`) is a capability, not an identity.

For a broker-backed source, the broker's concrete provider and model remain behind the
boundary. Audit-tools identities the stable source intent it actually launches; it does
not reproduce the broker's registry.

## Which axis each local question uses

| Question | Identity |
|---|---|
| "Which constructor launches this?" | `transport` |
| "Would this recursively launch the active host agent?" | `transport` |
| "Which learned quota/cooldown ledger applies?" | `service + account + model`, unless explicit `source.id` overrides the pool id |
| "Can this process reach the source right now?" | transport-specific proof over `locus` and credential reference |
| "Can this packet fit?" | the source's declared/resolved context capability, not identity |
| "Which concrete provider/model should run next?" | **not an audit-tools question; the broker owns it** |

## Mechanical self-spawn exclusion

`buildSelfSpawnExclusion` emits only `transport:<name>` patterns derived from active
host-session markers. This pattern is not an operator policy language and has no
provider/model ordering semantics. It exists solely to prevent recursive same-agent
launches before any process starts.

The guard must remain transport-keyed. A broker can change its concrete serving model
without changing whether audit-tools would recursively spawn `codex`, `claude`, or
another active host CLI.

## Quota identity

Quota identity is deliberately richer than self-spawn identity. Two sources sharing a
service, account, and model intent share one learned budget even if reached through
different transports; two accounts on the same service must not collapse into one
budget. `quotaPoolKey` is the canonical formatter.

An explicit `source.id` outranks derivation because it is an intentional pool-id override.
Auto-discovery must never stamp one: a tool-stamped transport-shaped id could split two
routes that should share a quota boundary.

## Locus remains transport-shaped

The existing `endpoint` field can be a URL for HTTP transports or a launcher command for
CLI transports. `claude-worker` also has an endpoint plus an implicit launcher. A simple
`url | command` union therefore does not honestly model every transport. Consumers must
interpret the field through the transport adapter until a richer network-target and
launch-target shape is introduced.

## Invariants

- No provider approval, provider ordering, or model-order confirmation key exists in
  audit-tools.
- Concrete broker candidates never enter repo intent, source declarations, or the local
  quota key.
- Self-spawn safety is transport-only and mechanically derived.
- Account remains load-bearing in quota identity.
- Reachability is re-verified by the process that will launch the source.
- Adding or changing a broker provider/model requires zero audit-tools source changes.
