# P13 — a tracked doc or example that names a CONCRETE broker pool rots silently

**Leg 3 (recurring-problem solutions). Proposal only — nothing was applied.**

## The recurrence

The same defect has been fixed four times, each time only at the instance that happened to
bite, while every other copy of the same hardcoded roster stayed in the tree.

| date | instance | how it surfaced |
|---|---|---|
| 2026-08-05 | `scripts/shared/triage-backlog.mjs` default `TRIAGE_MODEL = 'pool/fast'` | hard 400 from the relay; leg 2 swept 0 entries (P11) |
| 2026-08-06 | same script | owner decision sol-4: resolve the pool target LIVE from llm-relay. Its docblock now records the reason: *"a hardcoded pool name is a hand-held copy of the relay's config and went stale twice (pool/fast + pool/coding died at relay v0.15.4)"* |
| 2026-08-07 | `docs/HANDOFF.md` | nightly decision `2994bbdaf341d0c4` — owner: *"Drop the pool names from the HANDOFF routing sentence (llm-relay owns the roster; naming pools here is a standing drift source)"* |
| 2026-08-08 | seven more tracked files, below | this run |

Four distinct dates, one class. Three fixes; none of them swept.

## What is still broken at HEAD

`pool/fast`, `pool/coding` and `pool/reasoning` were removed from llm-relay at v0.15.4. The
live relay refuses them outright:

```
$ curl -s -X POST http://127.0.0.1:8791/v1/chat/completions \
    -d '{"model":"pool/coding","messages":[{"role":"user","content":"hi"}],"max_tokens":5}'
{"type":"error","error":{"type":"api_error","message":"llm-relay routing: no pool \"coding\"
 configured (available: low, medium, high, xhigh, credits-low, credits-medium,
 credits-high, credits-xhigh)"}}
```

Still shipping those three names:

- `examples/catalog/sources-declared.json` — **all three sources**. `examples/README.md` tells
  the operator to copy this file to `~/.audit-code/sources-declared.json`. Every dispatch
  through it 400s. This is the operator-facing half and the reason the item is not cosmetic.
- `examples/README.md:45` — *"names only `pool/fast`, `pool/coding`, and `pool/reasoning`"*
- `docs/audit-pkg/operator-guide.md:193-195` — the same JSON, inline
- `spec/dispatch-quota.md:532-533` — *"Each declared broker pool is one source intent
  (`pool/fast`, `pool/coding`, or `pool/reasoning`)"*, stated as an enumeration
- `spec/backend-identity-axes.md:25`, `spec/unified-dispatch-worker-model.md:40` — as examples
- `docs/backlog/durable-traps.md:207` — *"Use `pool/fast`, `pool/coding`, or `pool/reasoning`"*,
  written as live guidance

## Why "just update the names" is the wrong fix

It is the fix that has already failed three times. The repo's own conviction says so directly:
`CLAUDE.md` → *never make us hand-maintain a model/price/limit table*, and A4
*everything-agnostic*. A pool roster is another machine's config; a copy of it in this tree is a
hand-maintained table by definition, and bumping it to `low/medium/high/xhigh` just re-arms the
same trap for whenever llm-relay next renames a pool.

The owner already stated the rule on 2026-08-07 for `HANDOFF.md`. This proposal is that rule
made mechanical instead of remembered.

## Proposed mechanism

A check, not a hook — this is a property of the tree, not something detectable at a tool call.

`scripts/check-broker-pool-names.mjs`, wired into `verify:checks`: fail the build when a tracked
`*.md`, or any `*.json` under `examples/`, contains `pool/<name>` where `<name>` is anything but
the placeholder form. Placeholder allowed: `pool/<name>`, `pool/<your-pool>`.

It must NOT ask the live relay. A gate that queries a local service is exactly the
[[a-gate-must-not-ask-the-local-disk]] shape — it would pass or fail on whether a daemon happens
to be up, and it would still be wrong on any other operator's box. The gate's claim is narrower
and offline-decidable: *this repo does not name another system's pools*.

Excluded, by construction, the same record channels the doc manifest already excludes:
`docs/reviews/**`, `.audit-tools/nightly/proposals/**`, `docs/nightly-inbox.md`. Those quote
history; rewriting them would be falsifying a record.

**False-positive surface.** One real class: a doc quoting a relay error message verbatim (this
proposal does it twice above — hence the proposals exclusion). Outside the excluded paths the
gate has no legitimate exception, which is what makes it gate-able rather than advisory.

## What it would have caught

Every row of the recurrence table, on the day it landed — and the `examples/` config, which no
existing gate reaches: `check:doc-code-citations` verifies paths and symbols inside the repo, and
a pool name is neither.

## The part that is NOT mechanical — the owner's call

The gate says "don't name a pool". It cannot say what the shipped example should name instead,
and that decision changes what the example *is*:

1. **Placeholder** (`"model": "pool/<name>"` + a line in the README saying to substitute a pool
   the operator's broker actually defines). Honest and drift-proof; no longer copy-paste runnable.
2. **Concrete current names** (`low`/`medium`/`high`/`xhigh`). Copy-paste runnable today against
   this box's relay; re-arms the drift, and bakes one broker's vocabulary into a
   broker-neutral example.
3. **Drop the example config entirely** and document the shape only.

That choice is escalated as a leg-1 item this run; the gate lands after it, because the gate
would fail the tree until the example is decided.

## Patch

Not written. The gate is ~40 lines and mechanical, but it fails the tree on seven files the
moment it lands, so it cannot be applied ahead of the option-1/2/3 decision above — writing the
patch now would mean guessing that decision. `PATCH.md` follows the answer.
