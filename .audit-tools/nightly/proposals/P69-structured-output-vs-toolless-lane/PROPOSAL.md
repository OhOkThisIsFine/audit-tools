# P69 — The leg-2 lane loses entries to unparseable prose, and the fix collides with the reason the lane is toolless

**Leg 3, nightly 2026-09-24. Proposal only — nothing landed.**

## Recurrence evidence — 258 lost entries across 24 distinct sweep dates

Counted from the sweep logs under `.audit-tools/nightly/`, by error class:

| Error class | Count |
|---|---|
| `no JSON object in response` | 54 |
| `response did not match the triage schema (why, action)` | 48 |
| `response did not match the triage schema (verdict=null, why, action)` | 40 |
| `finish_reason=length` | 26 |
| `Expected property name or '}' in JSON at position 1` | 25 |
| `Expected property name or '}' in JSON at position 2` | 15 |
| `Unexpected non-whitespace character after JSON` | 9 |

Per-date totals reach 40 (2026-08-07), 36 (2026-08-24), 28 (2026-08-11) and 21
(2026-08-22). The class is still live: it took entry `open-bugs#b3ac555e` tonight.

Every one of those is a backlog entry the sweep did NOT classify. The sweep retries
only a call that died in TRANSPORT (`docs/nightly-routine.md`), and a malformed reply
is not a transport death — so the entry is simply lost for the night.

## The mechanism that would end it, and why it was not taken

`scripts/shared/mcp-dispatch-lane.mjs` accepts a `schema` option and ignores it. Its
header states the reason under "DROPPED, NOT FAKED":

> `format` needs an unverified StructuredOutput tool permission this module does not
> depend on

That premise was UNVERIFIED. Tonight it was measured, twice, on the live bridge
(`litellm/medium`, same prompt, same schema, directory `C:/Code-worktrees/probe-format-0924`):

- `agent: "dispatch"` → **completed in 3 seconds.** `result` came back as the PARSED
  object `{"verdict":"yes","why":"7 is greater than 3."}`. No prose, nothing to salvage-parse.
- `agent: "answer"` → **failed.** `{"name":"StructuredOutputError","data":{"message":"Model
  did not produce structured output","retries":0}}`

So the capability exists, and it is gated on the agent having tools.

## The collision — this is why it is a decision, not a fix

`dispatch()` in `mcp-dispatch-lane.mjs` defaults to `mode: 'answer'`, and
`scripts/shared/triage-backlog.mjs` takes that default at both its preflight and its
per-entry call site. The `answer` agent has EVERY tool denied. That is the property
that makes it safe to point the sweep's lane at the main checkout — a toolless worker
cannot write to the tree it is reading.

Structured output is delivered BY a tool. So the two properties are in direct tension:

- Keep the toolless agent, and keep losing entries to unparseable prose.
- Take structured output, and the sweep's worker gains tools while pointed at the repo.

Wiring `format` without changing the agent is strictly WORSE than today: every entry
would fail hard with `StructuredOutputError` instead of sometimes parsing.

## Options for the owner

1. **Move the sweep to the `dispatch` agent and wire `format`.** This ends the largest
   error class structurally. Cost: the worker has tools against the checkout. Mitigation:
   run the sweep's lane against a throwaway worktree, not the main checkout, so a write
   has nowhere harmful to land.
2. **Wire `format` and keep `answer`, only if a toolless structured mode exists.** This
   needs a bridge-side capability that does not exist today, on tonight's measurement.
3. **Leave the lane toolless, and spend the retry budget instead.** The `format` contract
   carries `retryCount`; the sweep could instead retry a MALFORMED reply the way it
   already retries a transport death. This is cheaper and smaller, and it does not end
   the class.
4. **Leave it.** 258 lost entries over 24 dates is the standing cost.

## False-positive surface

Under option 1, a provider inside the `litellm/medium` tier that cannot serve structured
output fails the entry OUTRIGHT rather than returning salvageable prose. Any adoption
keeps the prose path as a fallback rather than deleting it.

## Why no test ships with this proposal

The change is a call-site and agent-selection decision, not a hook or gate, so the
routine's full-patch-and-red-green-tests requirement does not apply. The premise this
proposal rests on was established by live measurement, recorded above, rather than by
a test at HEAD.

## Scope note

The repository half is `scripts/shared/mcp-dispatch-lane.mjs` and
`scripts/shared/triage-backlog.mjs`, and it is filed here. The machine-wide half — that
the agent-dispatch bridge DOES serve `format: json_schema` for a tooled agent and refuses
it for `answer` — is a fact about agent-dispatch, which serves every repository.
