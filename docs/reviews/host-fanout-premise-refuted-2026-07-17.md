# Host fan-out premise refuted — the pools ARE folded in; they fail and settle (2026-07-17)

Investigation before building the `proxy_transport` host-fanout trigger (HANDOFF ▶ IMMEDIATE NEXT
step 2). The build's premise — *conversation-first resolves source pools but never folds them into the
dispatch wave, so `proxy_transport` must arm the fold* — is **FALSE per the run's own artifacts + an
in-process reproduction**. Recorded so the build is not attempted against a non-bug.

## What the premise claimed
`docs/reviews/host-fanout-proxy-dispatch-design-2026-07-17.md:34-53`: conversation-first "meets neither
condition" (rolling_engine + explicit in-process backend), so resolved claude-worker pools "are never
folded in"; fix = make `self.proxy_transport` trigger the fold. Memory
[[repair-proxy-dispatch-unblocked-probe-fix]]'s live-run correction said the same ("source pools never
folded into the wave").

## What is actually true (evidence)

**1. The pools reach the dispatch gate.** In-process repro of the conversation-first path
(`resolveSessionConfig({}, {self:{can_dispatch_subagents:true}})` → `buildAuditSourcePools`) with the
live proxy + real confirmation policy returns **3 claude-worker pools** (7 resolved − 4 operator-excluded):
`groq/qwen/qwen3-32b`, `groq/openai/gpt-oss-120b`, `nim/z-ai/glm-5.2`. So `effective.sources`
(`resolveSessionConfig.ts:139`) carries them and `buildAuditSourcePools` (`hybridDispatch.ts:63`) returns
them. The recon's static trace was right; the design doc misidentified the gate (it named the *headless
self-drive* branch `nextStepHelpers.ts:1757`, but conversation-first fires the *hybrid* branch
`nextStepHelpers.ts:1875`, which requires only `auditSourcePools.length > 0` — **no** explicit in-process
backend). `resolveAuditRollingEngineEnabled` defaults true (`sessionConfig.ts:94`).

**2. The pools were driven and FAILED, then settled out.** The dogfood run
(`20260717T224350416Z_audit_tasks_completed_001`) left:
- `runs/hybrid-settled-pools.json` = `["groq/openai/gpt-oss-120b","groq/qwen/qwen3-32b","nim/z-ai/glm-5.2"]`
  — **exactly the 3 pools `buildAuditSourcePools` returned**, all in the DC-4 settled (exhausted) set.
- `quota-state.json`: `groq/openai/gpt-oss-120b` → `consecutive_429_count: 3`, `cooldown_until` set.
  (Prior dogfood note: raw `claude -p` on the small-context groq pools also 413'd — packet-too-large.)
- `active-dispatch.json`: `status:"active"`, `paused_state.kind:"waiting_for_provider"`, 78 stranded
  packets, `pause_count:0`.

**3. Mechanism (end to end).** Hybrid path folds the 3 pools in → drives them in-process →
they 429/413 → DC-4 marks all 3 settled → with every source pool settled, the frontier falls entirely to
the **host** pool → host (`claude-fable-5`, ~walled) admits 1 / 78 `cap_reached` → pause
`waiting_for_provider`. The "capacity_pools host-only" the live run observed is the host-review quota
*after* the source pools settled out — not evidence they were never folded in.

## Why `proxy_transport` would fix nothing
The fold already happens. A trigger that "arms the fold" arms something already armed. The pools do not
lack a trigger — they lack the **capability to take the packets** (small context + rate limits) and the
run lacks **anywhere to fall back to** once they settle (the host is walled).

## Corrected mechanism (NOT a capability limit — retracts an earlier draft)
It is **not** "the free pools can't do agentic tool use" — they can (owner-verified across several free
models via the proxy). The run's `dispatch-warnings.json` is **67× `large_packet` (4,000–10,000+ lines
each)**: the packets exceed the *surviving* pools' context windows. The router dispatched them anyway
because **`context_tokens` is never stamped on any pool** (`capacity_pools` context = `NONE` everywhere) —
so the one routing decision is blind to context-window fit. The pools 413 (+ a 429 rate-limit on
`groq/gpt-oss-120b`), all three settle, and the frontier collapses onto a walled host. Context-window fit
is simply another dimension of "available with headroom," alongside quota and rate-limit — not a special
case.

## Direction (owner, 2026-07-17): collapse to ONE routing decision — go all in
Routing = for each packet, pick a pool that **meets the packet's minimum capability requirement ∧ is
available ∧ has quota/rate headroom ∧ is agentic-capable ∧ whose context window holds the packet**;
among the eligible, order by the cost/λ dial. **Capability is a per-packet FLOOR** (owner, 2026-07-17):
the other criteria only apply among models that clear the minimum capability the packet requires — a hard
correctness/security packet is never routed to a low-capability model just because it is free, idle, and
fits context. The packet's required capability is its risk/complexity tier (`resolveDispatchTier` →
small/standard/deep); a pool is eligible only if its model's capability ≥ that floor.

**⚠ This forces per-(provider,model,effort) capability tiering** ([[per-model-tiering]], backlog): today
`capabilityTier` is per-PROVIDER, so every `claude-worker` proxy pool would collapse to one tier regardless
of model — but `qwen3-32b` and `opus-4` are wildly different capability, and they are exactly the pools we
route to. Capability-floor routing is meaningless for multi-model backends until tiering is per-model. So
[[per-model-tiering]] folds into this work, not after it.

Everything layered on top of that atomic decision is a distinction to delete:
1. **Abandon the `large_packet` category entirely** (owner). There is no "large packet" — only a packet
   that does or doesn't fit a given pool's headroom. Remove the `large_packet` warning code + any
   size-special-casing; fold it into the single headroom-fit test.
2. **Give the decision its data** — stamp per-pool context window (+ rate/quota headroom, agentic-capable)
   at populate. Today every pool's context is `NONE` (backlog residual iii).
3. **Packet composition is delicate — tread carefully** (owner). A packet is N smaller tasks; a
   smaller-context pool could take a packet of *fewer* tasks. Packet sizing "took a while to get right,"
   so any packet-size↔pool-headroom coupling must not regress the existing packer. Investigate before
   touching.
4. **No false-wall fallback** — when nothing available holds a packet, surface an honest "waiting for
   capacity" / "no available pool holds this wave" (at Gate-0), never a silent collapse to a walled host
   (cold-start item C: `hostDispatchWall.ts` admits 1 with empty `explains`, mislabels ~56% "exhausted").
5. **Delete the mode distinctions** — `proxy_transport` trigger, headless-vs-hybrid gate,
   `IN_PROCESS_*_PROVIDERS` sets (audit ×2 + remediate), the two divergent dispatch entry points — collapse
   into the one availability+headroom+capability decision (the [[relax-dispatch-source-forcing]] /
   `spec/dispatch-jit-claims.md` direction).

## Precise root cause (post-recon, source-verified)
The fit-check is **not missing — it is silently no-op'd**, and settle is **reason-blind and collective**:
1. **`contextCapTokens` is `null` on the proxy pools, and `null` means "always fits."** It's stamped in
   exactly one place — `buildSourcePool` (`apiPool.ts:314`) from `source.quota.context_tokens` — which
   populate sets only when the proxy `/registry` entry exposes a context field (`proxyCatalog.ts:266-269`;
   these entries didn't). Host-model pools never stamp it either. All three in-process fit gates
   (capacity U2 fold `capacity.ts:534`, coordinator `nodeContextFits` `coordinator.ts:216`, rolling
   `doesNotFitContext` `rollingDispatch.ts:699`) are guarded on non-null cap → with `null` they pass
   everything → oversized packets dispatched → 413. **Fix: every pool must have a NON-NULL effective
   window — registry field → else the backend model's known window (models.dev) → else a conservative
   default. Never null.**
2. **The host-admission path checks the WRONG quantity** — `admissionPoolsFromSummaries` derives
   `capacityTokens` from `resolved_limits.context_tokens` (the host window), never the source's echoed
   `context_cap_tokens` (`admissionLoop.ts:142`); and `fanoutMode` sets `capacityTokens: +Infinity`
   (`quotaPool.ts:297`), dropping the fit gate outright. So the two dispatch paths gate fit differently
   (or not at all). The unified decision applies ONE fit predicate on both.
3. **Settle is coarse + reason-blind.** `nextStepHelpers.ts:1947-1951`: *any* non-`complete` drive settles
   **ALL** source pools permanently for the run. That is why `qwen3-32b` and `nim/glm-5.2` are in the
   settled set with no individual 429/413 — they were collectively settled because the drive as a whole
   was non-`complete`. A 413 on pool A must not settle pool B; `packet_too_large` is already a
   per-`(packet,pool)` skip (`rollingDispatch.ts:1239`) — the collective settle overrides that correct
   granularity. **Fix: settle per-pool, on genuine exhaustion only (credit/persistent rate-limit), never
   collectively on a non-complete drive.**
4. **The host wall conflates "zero granted for ANY reason" with "budget exhausted."**
   `detectHostDispatchWall` fires on `grantedCount===0` regardless of cause (`hostDispatchWall.ts:66`),
   while `admissionBlockedOnBudget` only recognizes a `budget_exhausted` reason — so a zero-grant from
   `no_capable_pool`/`cap_reached` renders the generic "session limit is exhausted" with empty `explains`
   over a host that still had ~56% headroom. **Fix (item C): the wall states the honest reason; a
   no-pool-fits zero-grant is "no available pool holds this wave," not "exhausted."**

The three-tier error classifier itself is sound + single-sourced (`providerLaunchFinalize.ts:56`;
outcomes `success|rate_limited|timeout|error|credit_exhausted|model_unavailable|packet_too_large|quota_unclassified`)
— the defect is upstream (null caps) and downstream (collective settle, false wall), not in classification.

## This run's confound (worth surfacing in the tool)
The operator excluded the 4 **large-context** lanes (`claude-fable-5`, `claude-opus-4` via openrouter) and
left only small groq/nim lanes — so even a perfect router is stuck here. That itself is a signal the tool
should say "everything you left available is too small for this wave" rather than settling into a wall.

## Recommendation
Do **not** build the `proxy_transport` trigger — retire the design doc's premise. Author a design of record
for the unified routing decision above, then implement in atomic green commits (loop-core → attestation +
independent review).

## Anchors
| Fact | Anchor |
|---|---|
| hybrid gate needs only pools>0 | `src/audit/cli/nextStepHelpers.ts:1875` |
| headless branch (what the design doc misread) | `src/audit/cli/nextStepHelpers.ts:1757` |
| ambient sources → effective.sources | `src/shared/config/resolveSessionConfig.ts:137-140` |
| buildAuditSourcePools reads sessionConfig.sources | `src/audit/cli/hybridDispatch.ts:63`; `src/shared/quota/apiPool.ts:483` |
| rolling engine defaults true | `src/shared/types/sessionConfig.ts:94` |
| DC-4 settled-pool exclusion | `src/audit/cli/nextStepHelpers.ts:1878-1881` |
| settled = the 3 folded pools | `.audit-tools/audit/runs/hybrid-settled-pools.json` |
| 429 cooldown on groq pool | `~/.audit-code/quota-state.json` `groq/openai/gpt-oss-120b` |
| proxy_transport parsed, no consumer | `src/audit/cli/args.ts:305`; `nextStepCommand.ts:352`; `auditorDescriptor.ts:57` |
