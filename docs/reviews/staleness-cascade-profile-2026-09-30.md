<!-- review-routing: no-forward-work -->
# Staleness cascade microprofile — 2026-09-30

Packet 37 measurement, using the production metadata, staleness, DD-9 intent resolver,
charter packet materializer, clarification executor and systemic executor. No cache or
freshness semantics changed.

## Reproduce

From the repository root, with installed dependencies:

```sh
TSX_TSCONFIG_PATH=tsconfig.test.json node --import tsx/esm scripts/profiling/staleness-cascade.mjs > /tmp/staleness-cascade.json
```

The script creates and removes an isolated temporary fixture. Its assertions pin the
observed policy; timings vary with load. Node v24.19.0, Linux, one measured pass per
case. The [complete JSON record](staleness-cascade-profile-2026-09-30.json) includes
changed fields, direct dependency edges, stale/deferred sets, actual producer reruns,
remaining stale artifacts, timings and byte counts.

## Fixture and observations

A 400-line, 49,892-byte requirements document describes tenant isolation and failure
recovery. Two source files exist; one is a charter member. Intent includes the full
requirements prose and a deep review ceiling. Charter content is an empty canonical
register; this measures deterministic preparation and invalidation, not semantic
charter extraction quality or cost.

| Change | Stale artifacts | Deferred | Detection + metadata | Two deterministic producers | Stated packet bytes |
|---|---:|---|---:|---:|---:|
| Confirmation timestamp only | 0 | none | 2.51 ms | not invoked | 53,668 |
| Equivalent scope rewording | 0 | none | 2.20 ms | not invoked | 53,668 |
| Scope excludes tenant isolation | 3 | none | 4.50 ms | 6.36 ms | 53,668 |
| Document adds revocation requirement | 6 | none | 2.92 ms | 1.80 ms | 53,711 |
| Unrelated source content changes | 5 | charter register | 1.66 ms | 1.11 ms | 53,668 |

The equivalent/changed judgments are explicit synthetic, hash-bound test inputs to
the real DD-9 resolver. Equivalent prose retains revision authority and triggers no
cascade. Changed prose stales charter register, clarification and systemic challenge.
Document changes also stale disposition, graph and structure. Unrelated source content
preserves the charter slice comparison while upstream rederivation remains pending;
that result is **deferred**, not a claim the register is fresh. Systemic challenge still
stales against the whole manifest, as required.

The diagnostic replay actually executes clarification and systemic preparation for
stale cases, then stamps only their declared outputs. It does not drain the complete
orchestrator: upstream stale work remains visible in `remaining_stale`. These timings
are isolated producer costs, not a valid schedule for bypassing pending prerequisites.
Packet materialization reads the scenario's actual files and is separately timed.

## Cost limits and decision

No host is invoked, so supplied-to-host bytes are zero; packet bytes measure actual
materialized context only. Actual LLM tokens and estimated tokens are both null. No
LLM latency, billing, or complete cascade cost is claimed. The run demonstrates no
unnecessary invalidation for timestamp or adjudicated-equivalent intent in this
fixture. It does not establish that every prose artifact in every repository avoids
unnecessary invalidation. Keep existing DD-9, slice deferral and whole-manifest
challenge policy. Full semantic rederivation/host cost remains an evidence watch;
this measurement provides no basis for an equivalence cache.
