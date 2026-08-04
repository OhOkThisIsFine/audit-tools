# Unified dispatch worker model

Design of record for how dispatch reaches a model. Concrete provider/model ordering,
health, and failover belong to an external broker. Audit-tools declares only stable pool
intents and retains the enforcement that must remain local: packet fit, capability floors,
quota/headroom, concurrency, validation, and self-spawn safety.

**Scope note.** This is a concept doc: the durable model, its invariants, and the constraints
that are easy to get wrong. It carries no build sequence, no per-commit status, and no dated
narrative — what shipped is in `git log`; what is open and in what order is in
[`docs/HANDOFF.md`](../docs/HANDOFF.md) (sequencing) and [`docs/backlog.md`](../docs/backlog.md)
(per-item detail).

## Principle

There is ONE shared dispatch core; audit and remediate are two **draws** of it
([[dissolve-auditor-remediator-distinction]]). The core dispatches **work nodes** to **workers**.
A worker is one of three *kinds*, distinguished by how it reaches a model and whether it can use
tools. Backend diversity (running on a non-Claude model) is a property of the **worker kind and the
current auditor's environment** — never of the repo or the run. Dispatch inventory is
resolved **per-auditor at dispatch time**, extending
[[capability-is-per-auditor-not-per-audit]] from quota to the whole backend/model set.

## The worker taxonomy

| Kind | Reaches a model via | Tools / file access | Backend diversity via | proxy overlay |
|---|---|---|---|---|
| **Claude-harness agentic** — the host and its `claude` subagents (host fan-out); `claude -p` when headless, shipped as the `claude-worker` provider (`CLAUDE_WORKER_PROVIDER_NAME`) | the Anthropic `/v1/messages` wire protocol, redirectable by `ANTHROPIC_BASE_URL` | full (Read/Edit/Bash) | pointing the harness at a proxy → backend | ✅ **its lane** |
| **CLI agentic** — codex, agy, opencode (spawned subprocess harnesses) | the CLI's own model provider (OpenAI / Gemini), its own config | full | *being a different agent* | ❌ own harness/backend |
| **Single-shot API** — NIM / vLLM direct | a direct `POST /chat/completions`, one shot | **none** (no tool loop) | *is* the backend | ❌ a proxy is just another endpoint to it |

The kinds are not interchangeable per node: a node needing file access (all of remediate implement;
any audit review packet whose granted files exceed the inline caps) requires an **agentic** worker
(kind 1 or 2). Single-shot workers (kind 3) can only take self-contained packets that inline within
the caps — that is their permanent ceiling, not a bug to fix.

## The proxy overlay — an explicit kind-1 launch transport

The proxy overlay is a **base-URL redirect**: an explicit `claude-worker` source names a reachable
Anthropic-compatible endpoint and a broker pool intent such as `pool/coding`. The worker is launched
with `ANTHROPIC_BASE_URL` pointed at that endpoint, so the Claude harness's `/v1/messages` traffic
lands on the broker-selected backend.

Audit-tools never enumerates the endpoint's concrete model roster. There is no proxy catalog,
populate cache, `top_k`, or model-info enrichment path. The source carries only the adapter facts
needed to launch and meter the worker; the broker owns concrete candidates and failover.

**There is no repair function.** The retired transport validated/repaired a weak backend's tool
calls; nothing does that now. Whether a backend can drive the harness's tool loop is a
capability/quality fact, handled where such facts live: capability ranking and the capability floor
decide routing, and the reactive lane quarantine catches a backend that lies reachably. A transport
must not carry correctness semantics.

- **remediate implement is the case that needs this lane** — those workers Read/Edit/Bash/run
  tests, so a node needing file access on a non-Claude backend requires an agentic worker reached
  through the proxy overlay. The concrete class is the `claude-worker` provider: it spawns
  `claude -p` with a required `ANTHROPIC_BASE_URL` overlay and passes the declared broker pool intent
  to `--model` verbatim. Its pool/quota identity keys on the declared `service[#account]/model`,
  never on `claude-worker` itself — the transport never enters the quota key (see
  [`cross-provider-quota-matrix.md`](cross-provider-quota-matrix.md)).
- **audit review host-fanout** uses the same lane (agentic claude subagents reading source +
  emitting findings); audit review *can* also be done single-shot, where no overlay is involved.
- Same mechanism, two owner uses: (a) continue working past a usage wall by invisibly routing to a
  backend until quota resets; (b) dispatch — proxy the dispatched claude subagents. Both are kind-1.

**What it cannot serve, and why that is structural.** **Kind-3** workers gain nothing from an
overlay: they already POST to whatever OpenAI-compatible endpoint they are given — a proxy endpoint
is just one more backend to a kind-3 worker, a *source*, not a transport. **Kind-2 (CLI)** workers
cannot use it: codex speaks OpenAI on its own config, agy speaks Gemini — they are their own
harnesses with their own backends, spawned as subprocesses via `spawnLoggedCommand` and never
redirected. The overlay exists only where a harness honors a redirected `/v1/messages` base URL —
kind 1.

### Graceful degradation — OPTIONAL, never required

**Dispatch works whether or not this adapter is declared.** The overlay is an optional kind-1
source, not a dependency. Its endpoint is reach-verified per auditor like every other declared
lane, and its absence degrades cleanly to the host's normal dispatch:

- **No `claude-worker` source or endpoint unavailable** → the source is dropped with a reason and
  the normal host/other source pools remain available.
- **Incompatible host** — only harnesses that honor `ANTHROPIC_BASE_URL` for the workers they spawn
  (Claude Desktop, the `claude` CLI with an isolated `CLAUDE_CONFIG_DIR`) can use the proxy
  transport. A host that spawns its subagents on Claude directly reports no proxy-transport
  capability in the handshake → direct dispatch.

The dispatch core NEVER assumes this adapter exists, NEVER requires a compatible IDE, NEVER depends
on a particular proxy implementation, and NEVER fails a run for the lane's absence. Whether the
auditor can proxy its workers is one more per-auditor capability, present or absent, resolved at dispatch —
exactly like every other environment-discovered capability
([[enforce-robustness-in-tooling-not-host-discretion]]).

## The one cut — INTENT vs CAPABILITY vs EFFECTIVE

Applied everywhere:

- **INTENT** — repo-persisted, durable, auditor-independent: audit scope/lenses/synthesis/analyzers/
  design-review/graph + **budgeting policy** (safety_margin, reserved-output fraction,
  confirm_threshold, max_packets, risk_mass_budget). It contains no provider/model ordering.
- **CAPABILITY** — per-invocation, per-auditor, off-repo, NEVER inherited: the reachable backend ×
  pool intent × {tools-vs-chat rank, quota headroom, cost} catalog + the driver's own model window(s) /
  subagent ceiling / launch transports. Carried by ONE structured `AuditorDescriptor`
  (`--auditor <json>`) that rides every invocation.
- **EFFECTIVE** = `resolve(intent, descriptor)` — in-memory only, never a persistable type.

**The representational move:** the persisted TYPE is split. `RepoSessionIntent` (the only thing the
store reads/writes) carries no dispatch/capability fields — they do not exist on the type, so
persist-back contamination and stale inheritance are *unrepresentable*, not guarded. Enforced at BOTH
read boundaries by a validator, not by TS alone.

**The tools-vs-chat axis is the worker-kind router** (tool-capable → agentic kind-1/2; chat-only →
single-shot kind-3). The catalog is not a handful of config scalars; it is a capability catalog.

**Where capability lives, and where it must not:**

- **NOT the repo.** Two auditors on one repo have different catalogs → a repo-stored inventory
  cross-contaminates. This is the coupling the whole model exists to kill.
- **NOT env vars.** A live model/capability/quota/cost catalog is too rich for flat scalars.
- **Per-auditor**, built from the host handshake plus explicit source declarations intersected with
  ambient reach. Broker pool intents remain opaque; audit-tools does not rebuild their registries.

### The descriptor splits along ENVIRONMENT vs SELF

Not every field is knowable the same way, and conflating them is a live bug source:

- **Environment-class** (`sources[]`, provider identity, dispatch capability) — the backends THIS
  PROCESS spawns. **Resolved in-process; no handshake is needed or wanted.**
- **Self-class** (`model_id`, `context_tokens`, `output_tokens`, `roster`) — "I am model X with an
  N-token window." **Genuinely unknowable to a spawned CLI**: the running agent's model identity is
  not on PATH, not an env var, not a file. Irreducibly handshake-reported. Absent ⇒ the conservative
  floor — a fidelity degradation, never a block.

A caller with no handshake but a real environment therefore wants an **ambient descriptor**, not a
null one. Null means "resolve NO pool" — a strictly stronger statement, and passing it where ambient
was meant is a silent capability loss ([[silent-fail-closed-on-one-draw]]).

## Source resolution — in-process, by construction

The effective routable set is `declared ∩ ambient-verifiable-by-this-process` ∪ self. A declared lane
enters a pool only if this process proves reach (key env present / launcher on PATH / proxy port
listening / cred readable) — never `declared ∪ stored`. The declaration is machine-level and operator-
owned; an explicit descriptor-supplied `sources[]` still wins (the operator's escape hatch).

**In-process is a CORRECTNESS property, not an optimization.** A provider reads its key from
`process.env` **at launch**. Resolving in-process makes the reach check and the launch read the SAME
env — they cannot disagree. Relaying through the host opens a gap between what was promised and what
is true at the moment of use. The precondition holds: no host-exclusive credential case exists — every
dispatchable provider takes its credential from an env var, a home-dir file, an inline config value, or
the CLI's own ambient auth. The two providers that touch host-exclusive stores (Copilot, Antigravity)
are excluded from the dispatchable set by design.

Resolution is local and cheap: intersect the declaration with right-now ambient reach at the moment
of use. Model discovery and ranking occur behind the broker boundary and never populate an
audit-tools cache.

**A credential is NAMED, never pasted** — `api_key_env` is the only way to declare one, and an inline
`api_key` is refused at validation. Refusing it at the reach gate was the earlier answer, but a shape an
operator can still declare makes the rule opt-out by construction (possession ≠ reach) and leaves an
always-passes lane whose only catcher is the reactive lies-reachably quarantine. Deleting the shape
closes that by making it unrepresentable; it also keeps one key from splitting into two metered
accounts, since identity compares references.

**No auditor id is needed for multi-IDE isolation.** Each IDE spawns its own process, which inherits
THAT IDE's env, so each intersects the same declaration against its own real reach. Nothing is shared,
so nothing can contaminate. An id is only meaningful for shared *transient run-state*, which is where
never-inherit enforcement (below) puts it — and the load-bearing double-grant boundary is the
`(provider, account)` consumption ledger, not auditor identity.

## Never-inherit — three complementary mechanisms

1. **Unrepresentable in the persisted type** (the cut above).
2. **Transient run-state is stamped** with the auditor's identity; a differing id on resume DISCARDS
   prior inventory before deciding — checks identity, not "we re-sent the flags."
3. **`declared ∩ ambient-verifiable-by-this-process` ∪ self** (source resolution above).

## Resolved decisions

**Routing ownership is inverted.** An external broker owns concrete providers, model ids, health,
ordering, cooldowns, and failover. Audit-tools carries only stable pool intents across its generic
source boundary. It never persists a provider confirmation, asks the operator to order providers, or
reconstructs the broker's candidate ladder.

**Quota/block_quota split by "asserts capability vs asserts policy":** windows / host model /
subagent limit / per-source quota = capability (descriptor, never persisted; per-source quota travels
with the declared source); safety margins and packet thresholds = dimensionless policy (repo intent);
learned RPM/TPM = the account-keyed shared ledger, not config. Budget = policy × freshly measured
capacity.

⚠ **This split is narrower than it looks, and the difference matters.** Nothing *writes*
`quota`/`block_quota` — they are operator-authored. An operator-authored override keyed by MODEL NAME
(a model's window is the same for every auditor) is legitimately inherited and legitimately outranks
discovery; that is an escape hatch, not contamination. Only a field asserting **who the current auditor
is** is capability. Before moving a field here, grep who WRITES it
([[grep-the-writers-before-believing-inheritance]]).

## Mechanical self-spawn exclusion

Routing preference is external, but same-agent recursion remains a local safety property. Every source
pool passes through `buildSelfSpawnExclusion`, which derives only transport-level exclusions from the
active host environment. There is no operator override and no model/provider preference hidden in the
matcher. If the guard removes every source, the run records a `self_spawn_zeroed_capacity` friction
event and leaves the work for a non-colliding host or source.

Quota identity remains separate: `service[#account]/model` is the load-bearing key for learned quota
and double-grant prevention. The self-spawn guard keys only on launch transport because it answers a
different question: "would this process recursively launch the active agent?"

## Honest residuals — loud reactive degrade, NOT guarantees

- A host that **lies reachably** (real endpoint, overstated window, wrong-account key) is caught only
  on first oversize/402/tool-corruption → quarantine-the-lane + friction.
- **Auditor identity is best-effort.** The `(provider, account)` consumption ledger, not auditor
  identity, is the load-bearing double-grant boundary.

## Invariants

- Backend diversity is a property of the **worker kind + the current auditor's environment**, never a
  repo-stored provider order.
- The proxy overlay serves **only kind-1** (agentic claude-harness workers): a kind-3 worker reaches
  an endpoint directly — a proxy is just another endpoint to it, not a transport — and a kind-2
  worker is its own harness on a foreign wire protocol.
- Dispatch inventory is resolved **per-auditor per-invocation**; the repo session-config holds intent
  only.
- **A `claude-worker` proxy source is optional, explicit, and reach-verified per auditor**; its absence
  degrades cleanly. Audit-tools never discovers or ranks the concrete models behind it.
- **Pool ASSEMBLY is one shared function with per-mode policy hooks**, not two mirrored copies. The
  engine (drive loop, capacity, admission, scheduling, token estimation) is single-sourced; assembly is
  too. Legitimately per-mode = a genuinely different INPUT draw or the terminal/result-routing adapter —
  never the algorithm ([[dispatch-engine-shared-assembly-was-forked]]).
- A refactor that removes a capability from the shared core **must restore it for EVERY draw, or fail
  loudly for the draws it drops**. A silent fail-closed on one half of "one core, two draws" is
  indistinguishable from working ([[silent-fail-closed-on-one-draw]]).
