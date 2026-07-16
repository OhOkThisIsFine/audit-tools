# Greenfield design synthesis — per-auditor dispatch capability vs repo intent

3-person independent design panel (minimalist unifier / protocol-continuity architect / adversarial
failure-mode), greenfield mandate (ignore back-compat, effort-not-a-cost). Strong convergence.

## The reframe (unanimous): it's ONE cut, applied twice

The two "open decisions" (confirmed_provider_pool; quota/block_quota split) are not two decisions — they
are the SAME cut applied to two fields. The cut:

- **INTENT** — durable, shared, repo-persisted, auditor-independent. What this run is *trying to do* +
  the operator's *policy preferences*. Scope / lenses / synthesis / analyzers / design-review / graph +
  **budgeting policy** (safety_margin, reserved-output fraction, confirm_threshold, max_packets,
  risk_mass_budget, cost↔throughput λ) + the operator's **route decisions** (include/exclude, cost
  ordering).
- **CAPABILITY** — per-invocation, per-auditor, off-repo, NEVER inherited. What *this* driver can reach
  *right now*: the backend × model × {tools-vs-chat rank, quota headroom, cost} catalog + the driver's
  own model window(s) / subagent ceiling / launch transports (can-dispatch-subagents, can-proxy).
- **EFFECTIVE (derived)** = INTENT ⊕ CAPABILITY, computed every invocation, in-memory only, never a
  persistable type.

`applyDispatchInventory` (2a-ii) already computes the ⊕ correctly at RUNTIME — but it overlays onto a
config that STILL HAS the dispatch slots. The ideal deletes the slots from the persisted TYPE.

## The one representational move (unanimous, most-emphatic from the adversary)

**Split the persisted type; delete every dispatch/capability field from it.** Not "ignored if present,"
not "overwritten by the overlay" — the fields do not EXIST on the persisted type, so nothing can
serialize them. The store's write signature accepts only `RepoSessionIntent`. Then:
- persist-back contamination is **unrepresentable**, not guarded (no field to write a resolved
  host-model / confirmed pool / source list into);
- stale-inheritance-on-resume is unrepresentable (no stored inventory to fall back to → absence fails
  closed to **driver-self-only single-lane direct dispatch**, always safe because the driver is
  definitionally reachable).

```
RepoSessionIntent      // the ONLY thing on disk
  audit:     { scope, lenses, synthesis, analyzers, design_review, graph, external_acquisition }
  policy:    { exclusions[], cost_order?, dispatch_bias(λ), confirmed_by, confirmed_at }  // route DECISIONS
  budgeting: { safety_margin, reserved_output_frac, confirm_threshold, max_packets, risk_mass_budget }

AuditorDescriptor      // rides EVERY invocation (one structured --auditor <json>, not a flag-bag)
  auditor_id, resolved_at
  self:    { provider, roster:[{rank,context,output}], max_active_subagents, can_dispatch_subagents, can_proxy }
  sources: DispatchableSource[]   // kind-2/3 reachable backends, each with its own quota block

EffectiveDispatch = resolve(intent.policy, intent.budgeting, descriptor)   // in-memory only
```

## Collapse the flag-bag → ONE descriptor

Retire the scattered `--host-model-id / --host-models / --host-context-tokens / --host-output-tokens /
--host-max-active-subagents / --host-can-dispatch-subagents / --host-inventory` into ONE
`AuditorDescriptor` (`--auditor <json>`). They mutually constrain (a roster entry's window bounds the
same driver's paced subagent count); a flag-per-field lets a partial resume carry an incoherent mix. One
object round-trips atomically or not at all.

## Never-inherit — THREE complementary mechanisms (belt + suspenders)

1. **Unrepresentable in the persisted type** (adversary's primitive) — no stored inventory to leak.
2. **Auditor-id stamp on transient run-state** (protocol architect's INV-H2) — any persisted run-state
   that records a dispatch decision (active-dispatch.json, the confirmed decision's `confirmed_by`) is
   stamped with `auditor_id`; a differing id on resume DISCARDS prior inventory before deciding.
   Converts "we always re-send the flags" (convention) into "the tool CHECKS identity" (enforced).
3. **Effective set = declared ∩ ambient-verifiable-by-THIS-process** (adversary) — a declared lane
   enters a pool only if this process proves reach: API-key env present, launcher on PATH, proxy port
   listening, cred file readable — plus the driver itself (always kind-1 direct). Union is `declared ∪
   self`, NEVER `declared ∪ stored`. So even a foreign declaration can't route if this process can't
   actually reach it.

## Decision (A) — confirmed_provider_pool: SPLIT (unanimous)

Persist the operator's route **DECISION** (`exclusions[]`, cost ordering, confirmed flag) as INTENT.
Re-resolve the concrete reachable pool per-auditor every invocation and apply the decision as a **filter
over freshly-discovered reach** (never an additive source). Audit→remediate transports NO reachability —
remediate re-derives its own catalog and re-applies the same persisted include/exclude policy.
"Confirm once" survives; inheritance does not.

## Decision (B) — quota/block_quota: SPLIT by "asserts capability vs asserts policy" (unanimous)

- **Handshake (per-auditor, never persist):** host model window(s) (`block_quota.{host_model,
  context_tokens, reserved_output}`), `host_active_subagent_limit`, per-source `quota` blocks (rpm/tpm/
  context/output/max_concurrent) — these travel WITH the declared source and die when it isn't declared.
- **Account-keyed shared ledger (safe there, NOT config):** learned RPM/TPM.
- **Repo intent (durable, dimensionless):** safety_margin, reserved-output fraction, confirm_threshold,
  max_packets, λ. Budget = policy × freshly-measured capacity, each invocation.

`quota.models` (per-backend-endpoint declared limits) moves WITH the inventory (it's part of a source).

## The ONE genuinely-open decision (panel split — owner call)

**Reconciliation when a resuming auditor reaches a backend the operator never confirmed** (auditor B can
proxy where A couldn't; a new NIM endpoint appears):
- **Re-prompt the delta only** (protocol architect) — subset of confirmed → silent; strict superset →
  prompt just the new keys. "Confirm once per DECISION; a new capability is a new decision." Safe, but
  **breaks headless nightly autonomy** (a prompt blocks the unattended pipeline).
- **Fail-closed-exclude the new backend + loud friction** (adversary, leaning-but-unsure) —
  autonomous-safe, but silently forgoes a capable new backend until the operator opts it in.
- Interacts directly with [[autonomous-pipeline-capstone-spec]] (nightly = automate the
  unambiguously-good tier, no human gate). Likely answer: **attended → prompt-delta; autonomous_mode →
  fail-closed-exclude + friction event** (the autonomy flag already exists and picks the policy).

## Residuals that CANNOT be mechanically guaranteed (honest limits)

- A host that **lies reachably** — declares a real endpoint but overstates its window, or a valid key
  for the wrong account. Ambient cross-check catches UNREACHABLE declarations, not misdescribed-reachable
  ones. → loud reactive degrade (quarantine-the-lane on first oversize/402/tool-corruption + friction),
  not a guarantee.
- The tool cannot reliably distinguish "same human, two IDEs" from "two humans" → **auditor identity is
  best-effort; the (provider, account) consumption ledger — NOT auditor identity — is the load-bearing
  double-grant safety boundary.**

## Minimalist's least-sure point (worth resolving early)

Can `exclusions` be expressed as **reach-independent stable ids/patterns** that still mean something to
an auditor with a totally different reachable set? An exclusion authored against Desktop's catalog must
carry meaning on an IDE that never saw that backend. If exclusions can't be made reach-independent, the
confirm-once/re-resolve split leaks and Gate-0 re-confirms more often than the operator wants. → the
exclusion key grammar (provider? provider:model? endpoint-host?) needs pinning up front.

## How this reframes the 2a-iii / 2b plan

2a-ii's overlay is the right runtime shape but a transitional half-measure. The endpoint is:
(1) split the persisted type (`RepoSessionIntent` — delete all dispatch/capability fields; write
signature accepts intent only); (2) collapse the `--host-*` flag-bag into one `AuditorDescriptor`;
(3) split `confirmed_provider_pool` → policy-decision (repo) + re-resolved reach; (4) stamp transient
run-state with auditor_id; (5) intersect declared reach with ambient-verifiable reach; (6) pick the
attended-vs-autonomous reconciliation policy for newly-discovered backends.
