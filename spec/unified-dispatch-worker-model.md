# Unified dispatch worker model

Design of record for how dispatch reaches a model. Supersedes the retired
`repair-proxy-dispatch-integration.md` and the repair-proxy transport it described: the
tool-call-repair function no longer exists, and its successor — the generic **proxy overlay**
described here — is a plain launch transport with no repair semantics and no named
implementation. A declared `repair_proxy` key is rejected at parse; the declaration is a
`proxy` block.

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
current auditor's environment** — never of the repo, the run, or a "provider pool" the tool
cost-ranks. Dispatch inventory is resolved **per-auditor at dispatch time**, extending
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

## The proxy overlay — the kind-1 launch transport

The proxy overlay is a **base-URL redirect**: a declared `proxy` block names a reachable proxy
endpoint fronting a roster of backends, and a kind-1 worker is launched with `ANTHROPIC_BASE_URL`
pointed at it, so the Claude harness's `/v1/messages` traffic lands on a non-Claude backend.

**The declaration is implementation-agnostic by contract.** The `proxy` block is machine-level and
operator-owned (`{endpoint, api_key_env?, top_k?, cost_per_mtok?}`); *any* proxy that answers the
discovery contract qualifies — `GET /v1/models` for the roster, `GET /model/info` for cost/context
enrichment (degrading gracefully when absent). The tool names no proxy product anywhere in code or
contract; which implementation is listening at the endpoint is invisible to dispatch, and swapping
it changes zero tool source.

**There is no repair function.** The retired transport validated/repaired a weak backend's tool
calls; nothing does that now. Whether a backend can drive the harness's tool loop is a
capability/quality fact, handled where such facts live: capability ranking and the capability floor
decide routing, and the reactive lane quarantine catches a backend that lies reachably. A transport
must not carry correctness semantics.

- **remediate implement is the case that needs this lane** — those workers Read/Edit/Bash/run
  tests, so a node needing file access on a non-Claude backend requires an agentic worker reached
  through the proxy overlay. The concrete class is the `claude-worker` provider: it spawns
  `claude -p` with a required `ANTHROPIC_BASE_URL` overlay onto the declared proxy and a
  `<backend_provider>/<model>` routing namespace, so a proxied `claude-worker` is a full agentic
  worker on a free backend (a host-subagent-equivalent, off Anthropic quota). Its pool/quota
  identity keys on the real `backend_provider[#account]/model`, never on `claude-worker` itself —
  the transport never enters the quota key (see
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

**Dispatch works whether or not a proxy is installed — any proxy, or none.** The overlay is an
*enhancement* to kind-1 workers, not a dependency. The declared endpoint is reach-verified per
auditor like every other declared lane (conversation-first — no manual flag), and its absence
degrades cleanly to **direct dispatch**:

- **No proxy declared or none listening** → kind-1 workers run directly on Claude (the normal host
  fan-out). The run proceeds unchanged; it forgoes backend diversity via the proxy.
- **Incompatible host** — only harnesses that honor `ANTHROPIC_BASE_URL` for the workers they spawn
  (Claude Desktop, the `claude` CLI with an isolated `CLAUDE_CONFIG_DIR`) can use the proxy
  transport. A host that spawns its subagents on Claude directly reports no proxy-transport
  capability in the handshake → direct dispatch.

The dispatch core NEVER assumes a proxy exists, NEVER requires a compatible IDE, NEVER depends on a
particular proxy implementation, and NEVER fails a run for the lane's absence. Whether the auditor
can proxy its workers is one more per-auditor capability, present or absent, resolved at dispatch —
exactly like every other environment-discovered capability
([[enforce-robustness-in-tooling-not-host-discretion]]).

## The one cut — INTENT vs CAPABILITY vs EFFECTIVE

Applied everywhere:

- **INTENT** — repo-persisted, durable, auditor-independent: audit scope/lenses/synthesis/analyzers/
  design-review/graph + **budgeting policy** (safety_margin, reserved-output fraction,
  confirm_threshold, max_packets, risk_mass_budget, cost↔throughput λ) + the operator's route
  **DECISIONS** (exclusions, cost ordering, confirmed flag). Policy names *rules*, never *reachable
  endpoints*.
- **CAPABILITY** — per-invocation, per-auditor, off-repo, NEVER inherited: the reachable backend ×
  model × {tools-vs-chat rank, quota headroom, cost} catalog + the driver's own model window(s) /
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
- **Per-auditor**, built by querying what THIS auditor can reach, reusing existing machinery: the
  `models.dev` snapshot (windows/price), live quota sources (headroom), CLI detection, and the
  declared proxy's `/v1/models` + `/model/info` as a per-auditor *discovery feeder* — never a repo
  source-pool.

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

**POPULATE and RESOLVE are different operations — do not bundle them.** *Populate* (query models.dev /
live quota / `/registry` → the rich catalog) is expensive, network-bound, and genuinely wants a cache.
*Resolve* (intersect the declaration with right-now ambient reach) is local, cheap, and **must run at
the moment of use to be correct**. Bundling them forces resolve onto populate's schedule — and, if the
merge is handed back to the host, straight into the host-discretion anti-pattern: an LLM hand-composing
`{self, sources}` JSON, whose failure mode is an empty pool indistinguishable from an unreachable
machine. Populate lands behind the resolve seam, never in front of it.

**Inline `api_key` is refused** as not ambient-verifiable: possession ≠ reach, and it is the one shape
an operator can always choose, which would make the rule opt-out by construction. Its only catcher is
the reactive lies-reachably quarantine.

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

**The confirmed pool → SPLIT along policy-vs-reach.** Persist the operator's route DECISION
(exclusions + cost ordering + confirmed flag); re-resolve the concrete pool per-auditor each
invocation; apply the decision as a **set-difference FILTER** over freshly-discovered reach, never
additively. Audit→remediate transports zero reachability.

The cut applies to the confirmation **ARTIFACT**, not to a session-config field: that artifact is where
reachability inheritance actually happened (one auditor wrote discovered reach, another's dispatch read
it verbatim), so that is where the split belongs. Enforced by TYPE, not discipline — the PRODUCER is
split (a full in-memory DTO for what the operator is shown; a narrow projection for what persists), so
reach is *unrepresentable* on the persisted shape rather than omitted by a careful write site.

**Policy's home is PHASED, and the phase gate is real.** The endpoint stands: the policy (exclusions +
cost_order + confirmed flag) belongs on the **intent**. It is not *reachable* while audit and remediate
read the intent from **disjoint paths** — policy on the intent would not transport audit→remediate.
Until those read paths unify, policy persists on the confirmation artifact, the only cross-tool decision
channel. (Two drafts have died here: one proposing to collapse the artifact into the intent, one
proposing to strike the intent-carried endpoint. They are phases of one design, not rivals.)

**quota/block_quota → SPLIT by "asserts capability vs asserts policy":** windows / host_model /
subagent-limit / per-source-quota = capability (descriptor, never persisted; per-source quota travels
WITH the declared source); safety_margin / thresholds / λ = dimensionless policy (repo intent); learned
RPM/TPM = the account-keyed shared ledger, not config at all. Budget = policy × freshly-measured
capacity.

⚠ **This split is narrower than it looks, and the difference matters.** Nothing *writes*
`quota`/`block_quota` — they are operator-authored. An operator-authored override keyed by MODEL NAME
(a model's window is the same for every auditor) is legitimately inherited and legitimately outranks
discovery; that is an escape hatch, not contamination. Only a field asserting **who the current auditor
is** is capability. Before moving a field here, grep who WRITES it
([[grep-the-writers-before-believing-inheritance]]).

## The reconciliation gate

When a resuming auditor reaches a backend the operator never confirmed, reconciliation is keyed on
`autonomous_mode`: **attended → prompt the delta only** (a subset → silent); **autonomous →
fail-closed-exclude the new backend + a friction event**.

**Autonomous auto-confirm is scoped to the DELTA case only.** A first-time confirmation (no artifact at
all) still pauses for the operator even under `autonomous_mode` — auto-confirming a pool nobody has ever
seen is a different decision from reconciling a delta against one they approved.

**The gate's operands are part of the design, not an implementation detail.** Three drafts specced a
gate that would never have fired ([[gate-must-be-traced-not-designed]]):

- **Reach-now must read the documented gather chokepoint**, never the ambient resolver alone — the
  latter is blind to undeclared and descriptor-supplied backends.
- **The delta must be precomputed once per invocation.** Discovery shells out and cannot live inside a
  sync/pure obligation predicate.
- **The submission must be consume-and-invalidated**, or a stale submission silently auto-confirms the
  delta. **Unlink only on real promotion** — unlinking a submission that was never promoted destroys
  the operator's decision unrecoverably.
- **The gate's state is MUTABLE per-invocation, threaded by reference — not a value.** Reach-now is
  invocation-stable and expensive (compute once); the confirmed decision changes the instant the
  confirmation executor promotes, and **the promotion clears the gate**. A frozen delta stays non-empty
  after the backends fold in, and since provider-confirmation is the highest-priority obligation, the
  gate re-selects forever (autonomous: re-promote until it throws; attended: re-prompt a delta that is
  now a lie). Every layer that derives or dispatches must read the CURRENT value — including the
  orchestrator's own nested drain, which re-decides internally: a gate-blind decide there sends the run
  to a different executor and the gate silently never fires ([[gate-state-must-be-mutable-not-frozen]]).
- **The fail-closed write is keyed on `autonomous` INSIDE the executor**, not by its caller's branch.
  The executor is exported and reachable directly, and a fail-closed exclusion on an attended run
  silently rules out a backend the operator is being asked about (enforce in tooling).

**A roster-staleness check is NOT this gate and cannot become one.** It detects the right event but
responds by discarding the operator's cost order + λ; its verdict reaches no obligation, so it enforces
nothing; and it compares the *writing* auditor's roster — meaningless cross-auditor. The gate compares
the confirmed **decision** (policy, legitimately inherited) against **this** auditor's fresh reach.

## The exclusion grammar — and three distinct keyspaces

The exclusion key must be **reach-independent**: an exclusion authored on one auditor must mean
something to an auditor with a different reachable set. The grammar is `provider:model`, with
`provider` and endpoint-host as coarser patterns. It is an **OPEN** grammar — an endpoint-host pattern
is not a provider name, so rules are kept verbatim rather than membership-checked, and an unmatchable
rule is inert. The head token decides the tier against the closed provider-name set, which is what keeps
the three forms unambiguous. Resolution returns a **matcher over backends**, not a name set — model
granularity is the point: excluding one model of a multi-model backend must leave its siblings routable.

**Do not conflate three keyspaces** ([[exclusion-grammar-open-not-closed]]):

| Keyspace | Shape | Account is | Used for |
|---|---|---|---|
| quota-ledger pool identity | `backend_provider[#account]/model` | **load-bearing** (the double-grant boundary) | pool ids, learned quota |
| operator exclusion pattern | `provider:model` (open, 3 tiers), **transport**-qualified | irrelevant | route decisions |
| gate compare key | `(backend_provider ?? provider):model`, **backend**-qualified | irrelevant | delta detection |

The gate key falls back to the bare provider name rather than being a plain `provider:model` because a
representative model id is known for only some providers — a model-only key is blind to a CLI backend
appearing on PATH.

The gate key and the exclusion pattern are built beside each other but are **not the same string**, and
the difference is only visible for a proxied lane. The key qualifies on the BACKEND actually serving the
model, because that is what "is this the backend the operator already saw?" means: a proxied
`claude-worker` lane and a direct `openai-compatible` lane onto one `nim` backend are ONE backend
reached two ways, while two lanes over one transport onto `nim` and `openrouter` are TWO. The rule
qualifies on the TRANSPORT, because that is the field `ruleMatches` compares — a rule naming the backend
would match nothing at dispatch. Keying the gate on the transport inverts both cases at once, which is
why it was a gate BYPASS: confirming one backend marked an identically-named model on another as
approved.

⚠ **Known residue:** one backend reachable through SEVERAL transports yields one delta entry carrying
one transport's pattern, so an autonomous fail-closed exclusion drops only that route. Tracked in
`docs/backlog.md`.

## Honest residuals — loud reactive degrade, NOT guarantees

- A host that **lies reachably** (real endpoint, overstated window, wrong-account key) is caught only
  on first oversize/402/tool-corruption → quarantine-the-lane + friction.
- **Auditor identity is best-effort.** The `(provider, account)` consumption ledger, not auditor
  identity, is the load-bearing double-grant boundary.

## Invariants

- Backend diversity is a property of the **worker kind + the current auditor's environment**, never a
  repo-stored cost-ranked "provider pool."
- The proxy overlay serves **only kind-1** (agentic claude-harness workers): a kind-3 worker reaches
  an endpoint directly — a proxy is just another endpoint to it, not a transport — and a kind-2
  worker is its own harness on a foreign wire protocol.
- Dispatch inventory is resolved **per-auditor per-invocation**; the repo session-config holds intent
  only.
- **A proxy is optional, declared, and reach-verified per auditor**; its absence degrades cleanly to
  direct dispatch. Never a hard dependency, never a required flag, never a run failure, never a named
  implementation — dispatch works with no proxy installed, and any endpoint answering the discovery
  contract qualifies.
- **Pool ASSEMBLY is one shared function with per-mode policy hooks**, not two mirrored copies. The
  engine (drive loop, capacity, admission, scheduling, token estimation) is single-sourced; assembly is
  too. Legitimately per-mode = a genuinely different INPUT draw or the terminal/result-routing adapter —
  never the algorithm ([[dispatch-engine-shared-assembly-was-forked]]).
- A refactor that removes a capability from the shared core **must restore it for EVERY draw, or fail
  loudly for the draws it drops**. A silent fail-closed on one half of "one core, two draws" is
  indistinguishable from working ([[silent-fail-closed-on-one-draw]]).
