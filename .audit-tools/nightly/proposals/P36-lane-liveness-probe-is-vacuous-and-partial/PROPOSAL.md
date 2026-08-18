# P36 — The lane-liveness guard probes one lane of several, and that one probe cannot fail

## The problem

`.claude/hooks/session-start-guards.mjs` carries an "Offload-lane liveness" leg
whose stated purpose is to convert a mid-lap stall into a known constraint at
session start. It has two independent defects, both proven mechanically tonight.

### (a) It probes ONE lane, and the repo declares more than one

The leg hardcodes a single URL:

```js
const PROXY_URL = process.env.AUDIT_TOOLS_OFFLOAD_PROBE_URL ?? 'http://127.0.0.1:3001/health';
```

Its comment states the premise that makes one URL sufficient:

> The local router is the free offload lane and it has no standalone fallback

That premise is false against `~/.claude/CLAUDE.md`, which declares **three**
delegation lanes over **two** distinct transports:

| lane | transport | probed? |
|---|---|---|
| FreeLLMAPI pool (`claude.ps1`) | `127.0.0.1:3001` | yes |
| `codex exec` | headroom `127.0.0.1:8787` | **no** |
| `agy -p` | client-bound, no proxy | n/a |

Tonight (2026-08-18) headroom was **down**. The Codex lane was therefore dead for
the whole run, and no guard said so. The run discovered it the way the guard
exists to prevent — by dispatching into it and reading:

```
ERROR: ... actively refused it. (os error 10061)
ERROR: stream disconnected before completion: error sending request for url (http://127.0.0.1:8787/v1/responses)
```

The same structural gap is already recorded for a third axis: the pool lane's
workspace trust (P33 / `durable-traps.md:75`), whose entry states the uncovered
half in as many words — *"no guard checks lane workspace trust;
`session-start-guards.mjs`'s offload leg probes [only the router]"*.

### (b) The one probe it does run is vacuous

`/health` is not an endpoint on that server. The SPA catch-all answers **200 for
any unmatched path**, so the probe passes whenever *a web server is listening* —
regardless of whether the API surface works. Measured tonight:

```
/health                        -> 200
/this-path-does-not-exist-xyz  -> 200      <- same status, no such route
/v1/models                     -> 401      <- real route, auth-gated
```

`res.statusCode < 500` is therefore true for a router whose inference surface is
entirely broken. This is a liveness probe that **cannot fail for the reason it
exists** — the "false GREEN" shape the repo already treats as corrosive
([[false-red-is-as-corrosive-as-false-green]], [[a-script-in-no-gate-is-not-a-gate]]).

`/v1/models` is the readiness signal: it is a real route, it is what the triage
sweep already resolves its model target from, and `401` versus connection-refused
distinguishes "router up, key wrong" from "router down".

## Recurrence

6 records across 5 distinct dates. The failure is always the same one: *a lane's
unavailability is discovered by dispatching into it, after the run has already
planned around delegation.*

- `docs/backlog/durable-traps.md:100` — **2026-07-28**: "Dead-lane detection is
  NOT automatic any more. The helper that preflighted `/health` and exited 3
  naming the restart command was retired ... and nothing replaced it ...
  otherwise a dead lane is indistinguishable from a slow one."
- `.audit-tools/nightly/proposals/P11-leg2-lane-cannot-sweep-the-backlog/` —
  **2026-08-06** (owner decision sol-4): "Three consecutive nights degraded
  silently to a partial sweep, each for a different transport fault."
- `.audit-tools/nightly/proposals/P5-triage-lane-masks-429/` — a lane fault the
  caller could not see.
- `docs/backlog/durable-traps.md:66-77` + P33 — **2026-08-15**: pool lane
  untrusted, fabricated a closeout; filed UNENFORCED naming this same guard's
  uncovered half.
- `docs/backlog/durable-traps.md:171` — "endpoint-alive is not model-alive ...
  probe it with a real round-trip".
- **2026-08-18 (tonight)** — headroom down, Codex lane dead all run, guard silent;
  and the `/health` probe proven vacuous.

## The mechanism — declared lane data, not a hardcoded URL

The repo already has the pattern for exactly this: `scripts/guard-reach-data.mjs`
holds guard wiring and reach as **declared data**, reconciled by
`npm run check:guard-reach`, precisely because prose describing coverage drifts
from the coverage. Lane coverage is the same shape and earns the same treatment.

1. **`scripts/shared/offload-lane-data.mjs`** (new) — one row per declared lane:
   `{ id, label, transport, probe, remedy }`, where `probe` is either
   `{ url, expectStatus[] }` or `{ kind: 'workspace-trust', configPath, project }`
   or `null`. The rows are the lanes `~/.claude/CLAUDE.md` declares.
2. **`session-start-guards.mjs`** iterates the registry instead of hardcoding one
   URL, and reports each down lane with its own remedy line. A lane with no
   probe (`agy`) is reported as *unprobeable*, which is the honest answer rather
   than an absent row.
3. **The router probe moves to `/v1/models`** and accepts `200` or `401` —
   anything else, including a catch-all `200` from a path that does not route, is
   down.

This removes the trap rather than guarding it in two places: there is one list of
lanes, and a lane absent from it cannot be silently assumed live.

**False-positive surface.** Small and bounded. Each probe adds ~2s at session
start; the existing leg already budgets 2s and every lane is loopback. Accepting
`401` means a *revoked key* reads as up — deliberate: that is a different failure
with a different remedy, and conflating the two is what makes a probe
untrustworthy. `agy` is genuinely unprobeable without spending quota, so it is
declared unprobeable rather than guessed at.

**What it would have caught.** Tonight's dead Codex lane, at session start,
before leg 1 planned around two independent lanes and got one. The 2026-08-15
fabrication (as an untrusted-workspace row). The 2026-07-28
"indistinguishable from a slow one" case. And, in the reconciliation check, any
future lane added to `~/.claude/CLAUDE.md` with no probe row.

## Patch

Not written. The registry's row set encodes *which lanes are declared*, and its
source of truth is `~/.claude/CLAUDE.md` — an instruction file this routine may
never edit, and whose lane list is the owner's to fix. Leg 3 is propose-only.
Once the row set is approved the implementation is mechanical.

The **red-green test** belongs at `tests/shared/offload-lane-probe.test.ts` —
under `tests/`, because Vitest excludes `.claude/**` and a test beside a hook
never runs:

- RED (a) — a fake server answering `200` on every path must classify **down**.
  Fails today: `/health` plus `statusCode < 500` classifies it up.
- RED (b) — the registry must contain a row whose transport is headroom
  `127.0.0.1:8787`. Fails today: no registry exists.
- GREEN — a server routing `/v1/models` to `401` and everything else to a
  catch-all `200` classifies **up**; with the port closed it classifies **down**,
  and the reported remedy names the restart command.

## The question for the owner

Three ways to go, and the do-nothing one is real:

1. **Registry plus `/v1/models` probe** (recommended) — fixes both halves, one
   list of lanes, reconciled the way guard reach already is.
2. **Fix only the vacuous probe** (`/health` to `/v1/models`) — one line, removes
   the false GREEN, but leaves headroom and workspace trust uncovered, which is
   the half that bit tonight.
3. **Leave it as advice** — record in `durable-traps.md` that a caller probes
   each lane itself before a long dispatch. That is what the 2026-07-28 entry
   already says; it has not held for three weeks, and recording it again is the
   shape this routine treats as a non-fix.
