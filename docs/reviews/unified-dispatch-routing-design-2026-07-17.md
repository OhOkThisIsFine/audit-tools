# Unified dispatch routing decision — design of record (2026-07-17)

Realizes the owner direction (2026-07-17): collapse dispatch to **one routing decision** and delete the
mode distinctions layered on top of it. Supersedes the `proxy_transport`-trigger build (premise refuted —
[`host-fanout-premise-refuted-2026-07-17.md`](host-fanout-premise-refuted-2026-07-17.md)). Durable concept
home: [`spec/dispatch-jit-claims.md`](../../spec/dispatch-jit-claims.md) + memory
[[relax-dispatch-source-forcing]]. This doc is the concrete build design + sequencing (dated record).

## The one decision
For each packet, the dispatchable pool set is every pool that:
1. **meets the packet's minimum capability floor** (packet risk/complexity tier ≤ pool model capability),
2. **is available** (not operator-excluded, not self-spawn-blocked, not exhausted),
3. **has quota/rate headroom** (ledger admits; not in cooldown),
4. **is agentic-capable** (can run a tool-loop worker — a pool attribute, not a provider allowlist),
5. **whose context window holds the packet** (packet tokens + harness overhead ≤ pool effective window).

Among the eligible set, order by the cost↔speed λ dial (already built, `admissionLoop.ts:290`). **The host
is just one pool** in this set — not a separate branch, not a fallback mode. There is no "headless vs
hybrid," no "demote primary to source," no `proxy_transport` trigger, no `IN_PROCESS_*` provider allowlist.

## Why the run failed (precise, source-verified)
Full chain in the premise-refuted doc. In one line: the proxy pools' `contextCapTokens` was `null`
(registry exposed no context field; the stamp has no fallback), `null` means "always fits," so every fit
gate no-op'd → oversized packets 413'd → the drive returned non-`complete` → **all** source pools were
collectively settled (`nextStepHelpers.ts:1947`) → frontier collapsed to the host → the host wall fired on
a zero-grant it couldn't explain and mislabeled a ~56%-headroom host "exhausted."

## Component changes (each maps to a verified anchor)

### A. Every pool has a NON-NULL effective context window — the P0 fix
`contextCapTokens` is stamped only at `apiPool.ts:314` from `source.quota.context_tokens`, and populate
sets that only when the registry entry carries a context field (`proxyCatalog.ts:266`). Give it a fallback
chain, single-sourced: **registry context field → models.dev backend-model window
(`resolveModelStatics(model, backend_provider).context_tokens`, data exists) → conservative default.**
Apply to host-model pools too (`buildHostModelPool`, `apiPool.ts:172` — currently never stamps it). Once
non-null everywhere, the three existing in-process fit gates (`capacity.ts:534`, `coordinator.ts:216`,
`rollingDispatch.ts:699`) start working with no change to their logic. **`null` (= always-fits) must become
unreachable** — that single invariant is the core of the observed bug.

**Accepted residual (step-A review, 2026-07-17):** the blind default is `DEFAULT_CONTEXT_TOKENS=32000`,
and the fit check adds `AGENTIC_WORKER_HARNESS_OVERHEAD_TOKENS=15000`, so an undeclared pool with no
models.dev match admits only packets ≤ ~17k tokens and larger packets strand there. This is fail-safe
(skip beats 413) and narrow (bites only a genuinely-large-context model that is BOTH undeclared AND absent
from models.dev). Mitigated by: populate stamping the registry's real context window (part of this build),
models.dev coverage of real models, and step G (packet composition flexes to the pool window). Not a
blocker; a threshold to revisit only if that edge proves common — do not silently raise the shared
`DEFAULT_CONTEXT_TOKENS` (used elsewhere as a blind floor).

### B. ONE fit predicate on BOTH dispatch paths
The host-admission path checks the wrong quantity — `admissionPoolsFromSummaries` builds `capacityTokens`
from `resolved_limits.context_tokens` (host window), never the source's echoed `context_cap_tokens`
(`admissionLoop.ts:142`); and `fanoutMode` sets it to `+Infinity` (`quotaPool.ts:297`), dropping the gate.
Route both the in-process capacity fold and the host admission through the SAME per-pool effective-window
value from (A). Remove the `fanoutMode` infinity escape.

### C. Capability floor via the `capable` predicate hook
The admission loop's `capable` predicate (`admissionLoop.ts:216-220, 463`) is the designed, unused hook.
Supply a predicate: eligible iff `poolCapability >= packetFloor`, composed with the size-fit from (B).
- **Packet floor** = its `model_hint.tier` (`resolveDispatchTier`, already computed, `dispatch.ts:529`) —
  today it isn't even passed into admission; thread it onto `AdmissionCandidate`.
- **Pool capability** — TWO conventions coexist and invert: `capabilityRank` (tier ordinal, higher=better,
  from roster rank ⇒ effectively per-provider) vs `capabilityScore`/`composite_rank` (per-model, lower=
  better, operator-declared). The floor must gate on a per-MODEL capability, else all proxy pools collapse
  to the neutral `standard` tier (§Open decision 1).

### D. Settle per-pool + reason-aware
`nextStepHelpers.ts:1947-1951` settles ALL source pools on any non-`complete` drive — the coarsest possible
reaction, and the reason 2 of 3 pools settled with no individual error. Replace with: a pool is removed
only on a genuine terminal outcome for THAT pool (`credit_exhausted` / persistent `rate_limited` with no
parseable reset / `model_unavailable`). `packet_too_large` is already a per-`(packet,pool)` skip
(`rollingDispatch.ts:1239`) and must NOT settle the pool. A transient (timeout, parseable-reset 429,
`quota_unclassified`) pauses, never settles. Mirror the same in remediate (`nextStep.ts:2019`).

### E. Host wall states the honest reason (item C)
`detectHostDispatchWall` fires on `grantedCount===0` for any reason but only explains `budget_exhausted`
(`hostDispatchWall.ts:66,86`). Distinguish the zero-grant causes: `budget_exhausted` → the existing
message; `no_capable_pool` / all-cap_reached / no-pool-fits → "no available pool holds this wave's packets
(N packets exceed every available pool's window / capability)"; never label a host with headroom
"exhausted." Surface a no-pool-fits condition at Gate-0, not only at dispatch.

### F. Abandon the `large_packet` category
Delete the line-count advisory (`LARGE_FILE_PACKET_TARGET_LINES=2500`, `dispatch.ts:475`). Fit is the
token-window test from (A)/(B); there is no "large packet," only "fits pool P or not." Keep the token-based
`oversized_packet` surfacing but re-frame it against the per-pool window.

### G. Packet composition flexes to the target pool's window — CAREFULLY
The packer (`partitionTaskGraph`) is already parameterized on a scalar `contextTokenBudget`; today it's fed
the single largest host window (`quotaPool.ts:179`). The existing per-tier re-fit `fitPacketsToTierBudgets`
(`packetFilter.ts:161`) already re-splits packets to a smaller budget — **generalize it from risk-tier
budgets to per-eligible-pool windows** so a packet targeting a smaller pool is re-split to fit. The
partition core does not change (owner caution honored — the delicate union-find packer is untouched; only
the budget SOURCE and the re-fit's keying change). A packet is N tasks; a smaller-context pool takes a
packet of fewer tasks — that falls out of re-fitting to the pool's window, not a packer rewrite.

### H. Delete the mode distinctions (the structural collapse)
- **`proxy_transport`** — dead handshake bit, no consumer (`args.ts:305`, `nextStepCommand.ts:352`). Delete.
- **Headless-vs-hybrid branch** (`nextStepHelpers.ts:1757`/`1875`; remediate `nextStep.ts:1903`/`1936`) —
  collapse to one fan-out over the eligible pool set with the host as a member pool.
- **Three `IN_PROCESS_*_PROVIDERS` sets** (`hybridDispatch.ts:40`, `rollingAuditDispatch.ts:105`,
  `nextStep.ts:980`) — replace with one per-pool `agenticCapable` attribute.
- **`shouldDemotePrimaryInProcess`** (`apiPool.ts:376`) — disappears; host and backend are both pools, the
  same-agent guard becomes a dedup on pool identity.
- **Two quota contracts + emit wrappers** (`DispatchQuota` vs `RemediationDispatchQuota`;
  `finalizeDispatchQuota` vs `buildDispatchQuota`) — one shared validated contract with optional per-mode
  fields; one emit wrapper over the shared `computeDispatchAdmission` with `fanoutMode`/`phase` as params.
  (Already-tracked fork; folds in here.)
- Keep as-is (already single-sourced, just called from the collapsed site): `resolveHostDispatchCapability`,
  `resolveDispatchExclusion`, the three-tier classifier.

## Sequencing — atomic green commits (loop-core: each ships green + attestation + independent review)
1. **A + B + F** — non-null effective window everywhere + one fit predicate on both paths + drop the
   `large_packet` advisory. This alone fixes the observed bug (small pools skip oversized packets instead
   of 413ing). Red-green: a pool with a small window must reject an oversized packet in BOTH paths.
2. **D + E** — per-pool reason-aware settle + honest host wall. Red-green: a 413 on pool A leaves pool B
   dispatchable; a no-pool-fits zero-grant does not render "exhausted."
3. **C** — capability floor via `capable` predicate (gated on Open decision 1's data answer).
4. **G** — packet composition flexes to per-pool window (generalize `fitPacketsToTierBudgets`).
5. **H** — structural collapse (branches, sets, demote, unified contract/emit). Largest; atomic-replace
   per distinction (new predicate + deletion in one commit).

Order rationale: 1 is the actual bug and is small + high-value; 2 hardens the failure surface; 3–4 add the
capability + sizing intelligence; 5 removes the scaffolding once the one decision carries all the load.
Steps 1–2 are independently shippable and would make a re-dogfood succeed on their own.

## Capability data source — RESOLVED by evidence (the hardest open decision collapsed)
The per-model capability data already exists, synced, someone-else-maintained — matching the CLAUDE.md
"synced not forked" rule with zero new maintenance:
- **Proxy `/registry` carries `capability_source`** — "Raw BFCL + LMArena scores, never collapsed" (synced
  2026-07-15), per-model `composite`/`composite_rank` + `arena_rating`/`bfcl_overall`. `composite_rank` is
  the SAME field audit-tools' `source.capability_rank` already maps to (`sessionConfig.ts:444`). So the fix
  is symmetric with the context-window fix (A): **populate stamps per-model `capability_rank` from the
  registry `capability_source`**, and the `capable` predicate reads real per-model capability with no
  operator declaration and no forked table.
- **models.dev raw entries carry `tool_call` (bool) + `reasoning` + `reasoning_options`** — the extractor
  currently drops them. `tool_call` IS the **agentic-capable** attribute (criterion 4) for non-proxy pools;
  `reasoning` informs the floor. Extend the `update-models` extraction to keep them.
- **Floor mapping = RELATIVE, never absolute** (CLAUDE.md: "tiering routes by relative advertised
  capability, never a named-model→tier map"). Map packet tier (small/standard/deep) to a minimum rank
  *among the currently-available pools' capabilities*, not fixed score cutoffs.

## Owner decisions — CONFIRMED (2026-07-17)
1. Capability approach **confirmed** — stamp `capability_rank` at populate from the registry
   `capability_source` (composite_rank), keep models.dev `tool_call`/`reasoning`, relative tier→floor.
2. Unknown capability → **fail-open + low-confidence note**.
3. Default window → reuse `DEFAULT_CONTEXT_TOKENS=32000`.
4. Scope → **all five steps this push**, sequenced atomic green commits.

## (original open decisions, now settled above)
1. **Capability approach — confirm.** Stamp `capability_rank` at populate from the registry
   `capability_source` (composite_rank); keep models.dev `tool_call`/`reasoning`; map the packet tier→floor
   by RELATIVE capability among available pools. (Verification-backed recommendation above — confirm or
   redirect.)
2. **Unknown-capability fallback.** For a model the leaderboard doesn't match (`capability: null`) or a pool
   with no capability data, does a `deep` packet (a) route to it anyway (fail-open — a weak model may take a
   hard packet) or (b) exclude it (fail-closed — risks host-only)? Recommend **fail-open with a recorded
   low-confidence note**, since fail-closed reproduces the host-only collapse; a quality call.
3. **Conservative default window (A).** When neither registry nor models.dev yields a context window, reuse
   the existing blind `DEFAULT_CONTEXT_TOKENS=32000` (`tokens.ts:18`)? (Recommend yes.)
4. **Scope confirmation.** Steps 1–2 fix the observed bug and are shippable alone; 3–5 are the full
   collapse. "Go all in" ⇒ all five, sequenced. Confirm 5 (the structural collapse) lands in this push,
   not deferred once 1–2 make dogfood green.

## Constraints
Loop-core throughout (`nextStepHelpers`, `rollingDispatch`, `capacity`, `admissionLoop`, `apiPool`,
`dispatch`, `nextStep`, `quotaPool`). Every commit: `npm run build && npm run check` green, independent
review, fresh attestation (`.claude/hooks/attest-loop-core-review.mjs`), atomic new-mechanism-plus-deletion.
The packet-sizing seam (G) is the highest-regression-risk piece — extend the existing re-fit, never rewrite
the union-find packer; red-green each split-behavior change.
