# H2+H4 — collapse the headless/hybrid branch pair; retire demote (plan, 2026-07-18)

> Dated plan doc. **Goal (from the design of record,
> [`unified-dispatch-routing-design-2026-07-17.md`](unified-dispatch-routing-design-2026-07-17.md) §H):**
> ONE fan-out over the eligible pool set with the conversation host as a member pool. The headless case
> degenerates to "the eligible set contains no attended host"; the hybrid case to "it does."
> `shouldDemotePrimaryInProcess` + `DEMOTABLE_IN_PROCESS_PROVIDERS` retire in the SAME atomic commit
> (the branch pair conditions on the demote flag; the same-agent guard becomes pool-identity dedup).
> F4 follow-on: source pools enter unified admission — the capability floor gates the engine path and
> `grantLeases:false` stops bypassing `capable`. Routing criteria (owner-confirmed): capability floor ∧
> available ∧ quota/rate headroom ∧ agentic-capable ∧ context-fit; λ orders the eligible; host is just a
> pool.

## Verified ground truth (HEAD `1485bbaf`, v0.33.4 — recon 2026-07-18)

Every anchor re-verified against source; corrections to the design doc are marked ⚠.

| # | Claim | Status |
|---|---|---|
| 1 | Audit monopoly branch | `src/audit/cli/nextStepHelpers.ts:1757` (⚠ file is under `cli/`, not `orchestrator/`): `engine && !hostCanDispatch && resolvesToInProcessDispatchProvider` → `materializeReviewRun` + `driveRollingAuditDispatch` (whole frontier). |
| 2 | Audit hybrid branch | `nextStepHelpers.ts:1875`: `engine && auditSourcePools.length > 0` → `planHybridDispatch` over **source pools only**; the host is the batch **complement** (semantic-review emit), ⚠ NOT a coordinator member pool. Demote feeds only `buildAuditSourcePools` (`:1869`). |
| 3 | Remediate monopoly branch | `src/remediate/steps/nextStep.ts:1883` (⚠ doc said ~1903): `engine && !demoteBackendToSource && resolvesToInProcessDispatchProvider` → `driveRollingImplementDispatch` (rolling engine, whole frontier). |
| 4 | Remediate hybrid branch | `nextStep.ts:1916` (⚠ doc said ~1936): `engine && canDispatchImpl` → `buildConfirmedPools` (host **is already a member pool**, `demotePrimaryInProcess` passed at `:1959`) → `planHybridDispatch` over ALL confirmed pools; in-process partition via `executeInProcessPartition` (⚠ direct `Promise.all`, NOT the rolling engine — its own comments document the lost hooks: no `onPacketTooLarge`/verbatim quota harvest, hand-replicated at `:2041-2091`); host partition → `prepareHostRollingDispatch` pre-claimed. Demote also selects the host-session quota key (`:1935`). |
| 5 | ⚠ Predicate asymmetry (doc glosses this) | Audit monopoly gates on raw `!hostCanDispatch`; remediate gates on `!demote` — so an ATTENDED remediate run whose primary is non-demotable (`subprocess-template`/`worker-command`, and `agy` since it is missing from `DEMOTABLE_IN_PROCESS_PROVIDERS`) still self-drives the whole frontier. Audit attended never enters monopoly. |
| 6 | Demote machinery | `src/shared/quota/apiPool.ts:373` `DEMOTABLE_IN_PROCESS_PROVIDERS` = {openai-compatible, codex, opencode} (no `agy` — backlog residual (a) confirmed); `:389` `isDemotableInProcessProvider`; `:409` `shouldDemotePrimaryInProcess`; `:467` `primaryInProcessSource` (per-provider source synthesis from the primary's config block, gated on the DEMOTABLE set); `:524` the demote fold in `collectDispatchableSources`. External readers: `waveScheduling.ts:210` (`isDemotableInProcessProvider`), the two branch sites, `shared/index.ts:1126-1128` exports, `spec/audit/dispatch-admission-control.md:180` citation. |
| 7 | F4 bypass | `src/shared/dispatch/admissionLoop.ts:570-572`: `if (!input.grantLeases) return { granted_packet_ids: candidates.map(c => c.id), ... }` — every candidate granted before `admitBatch` (whose loop applies `capable` at `:417/:446`, emits `no_capable_pool` at `:456`) ever runs. Engine-path callers on the false path: `nextStep.ts:1044` (via `prepareImplementDispatch`), `rollingAuditDispatch.ts:421`; threaded via `quotaPool.ts:346`, `marshal.ts:420`. |
| 8 | Pool-identity dedup | `apiPool.ts:34-53` `dispatchableSourceId`: `backend_provider` > explicit `id` > `provider`, keyed with model/endpoint + account. ⚠ **CORRECTED by adversarial review:** the existing dedup (`:518-519`) is *source-vs-source only*. The host CapacityPool is built separately (`waveScheduling.ts:217-228`) and appended with NO cross-class id check (`:245`). The `shouldDemote` docblock (`:399-407`) describes the bug the guard *prevents*, not an existing dedup. **Host-vs-source dedup is NEW code this lap must write** (commit 3). |
| 9 | H3 predicates | `src/shared/providers/inProcessWorkers.ts`: workers = {openai-compatible, codex, opencode, agy, claude-worker}; command = {subprocess-template, worker-command}. Remediate passes `commandWorkers:true` at both its sites (`nextStep.ts:978/:987`); audit passes none (`hybridDispatch.ts:42`). |
| 10 | ⚠ `driveRollingImplementDispatch` has NO override surface | `nextStep.ts:1020` — no `tasksOverride`/`poolsOverride` analog. Audit's driver already takes both (`nextStepHelpers.ts:1936-1937` uses them for the hybrid partition). The remediate unification therefore needs new driver capability (or partition-scoped invocation) — see D2. |

## Design — target shape

One path per draw, no branch pair:

1. **Build the eligible pool set once.** `buildConfirmedPools` (remediate) / an audit equivalent over
   `buildAuditSourcePools` + host pool: the attended host pool is a member iff `hostCanDispatch`; the
   configured primary in-process backend is ALWAYS folded in as a source pool (the `primaryInProcessSource`
   synthesis, no longer gated on the DEMOTABLE set or a demote flag — extended per D3/D4 to every
   in-process worker provider the draw's policy admits, each with an explicit synthesis case).
   **NEW cross-class dedup** (review F1): the host pool's identity is checked against each folded source's
   `dispatchableSourceId`; on collision D1's same-agent rule picks the survivor.
2. **One `planHybridDispatch` fan-out over that set.** Remediate: host included as a claimant pool (as
   today). Audit (D6, review-confirmed): the host is a member of the *eligible set* — its presence/absence
   is the headless-vs-attended degeneracy — but NOT a coordinator claimant; the coordinator sees source
   pools only and the host reviews the coverage-driven complement (host capacity = ∞, zero claim
   bookkeeping). `partition.inProcess` → the rolling engine; the host share → the host dispatch emit
   (audit: semantic-review materialize over the complement; remediate: `prepareHostRollingDispatch`
   pre-claimed — both already exist).
3. **Degenerate cases fall out:** headless ⇒ no host pool ⇒ host share empty ⇒ engine drives
   everything and the call transitions (the old monopoly branch, without existing as a branch). No source
   pools + attended ⇒ everything lands in the host share (pure host dispatch, unchanged).
4. **F4 (review F2 — enforcement point corrected):** the real floor lands in the ENGINE's per-packet
   pool-eligibility filter (`rollingDispatch.ts:699-706`, alongside `doesNotFitContext`): thread
   `requiredTier`/`capable` into packet→pool selection so an incapable pool is never selected. The
   `computeDispatchAdmission` `grantLeases:false` early-return additionally filters candidates through
   `capable` + fit with explains — but that is the contract-display half only (`granted_packet_ids` is
   never read back on the engine path: audit packetizes `dispatch.plan` wholesale at
   `rollingAuditDispatch.ts:454-461`; remediate builds levels from `plan.items` at `nextStep.ts:1147`).
   Red-green must assert a packet is NOT DISPATCHED to the incapable pool, not that a file field shrank.
   Remediate's packets currently carry no `requiredTier` and pass no `capable`
   (`marshal.ts:386-391/:415-424`; `buildCapabilityFloorCapable`'s sole caller is audit
   `quotaPool.ts:332`) — wiring both draws is part of this step.

### Decisions

- **D1 — predicate unification is structural, not a new flag.** Both old predicates
  (`!hostCanDispatch`, `!demote`) delete; behavior is carried entirely by pool-set membership. The
  remediate asymmetry (row 5) resolves to audit's semantics: an attended host is always a dispatching
  member pool and no backend ever monopolizes an attended run. **Same-agent collision rule (review
  F1/F6):** when the host pool and a folded source collide on pool identity, the SOURCE/engine pool
  survives when the provider is an in-process worker (preserving HEAD's self-drive for attended
  provider=codex=host — the engine drives; the host has no separate pool to double-book), and the HOST
  pool survives otherwise. Red-green (c) asserts this *behavior*, not just pool count.
- **D2 — remediate's in-process partition moves ONTO the rolling engine** (mirror audit's
  `tasksOverride`/`poolsOverride` pattern on `driveRollingImplementDispatch`), and
  `executeInProcessPartition` + its hand-replicated friction-capture block (`nextStep.ts:2041-2091`)
  delete in the same commit. This is the one-core rule ([[dispatch-engine-shared-assembly-was-forked]]):
  the direct-`Promise.all` executor is a second driver whose divergence is already billed as follow-ups
  in its own comments (413 hook, verbatim harvest, reversible pause evaporating at cycle boundary).
  **Preservation obligations (review F4):** the partition-scoped drive must (i) surface per-node pool
  attribution + `exhausted_pool_ids` (audit's driver already does, `rollingAuditDispatch.ts:589`;
  remediate's result carries neither — `nextStep.ts:954-966`); (ii) scope/suppress
  `partial_completion_terminal` persistence (`:1293-1299`) and the unconditional final merge (`:1304`)
  for partition drives — a backend-only wall must settle that pool and let the host share proceed, never
  pause the whole run; (iii) keep the BROAD cross-cycle settle (`isPoolSettlingOutcome`, incl.
  reset-bearing 429 + `quota_unclassified` — `settledPools.ts:32-55` documents why the engine's
  reversible pause is insufficient across cycle boundaries) via the new per-node pool attribution.
  Red-green must cover the settle *preservation*, not only the hook gain.
- **D3 — command-shaped primaries (remediate `commandWorkers:true` policy, H3 residual (b)):** extend
  `primaryInProcessSource` with explicit synthesis cases: `subprocess-template` from its config block
  (`sessionConfig.ts:680`); `worker-command` as a bare `{provider: "worker-command"}` pool (it has NO
  session-level config block — its command is per-node on the task, resolved at dispatch). Under
  remediate's policy an attended run fans them out as pools (today they monopolize even attended — row
  5 — which D1 removes; without D3 they would silently lose ALL dispatch in attended runs, the
  [[silent-fail-closed-on-one-draw]] class). Headless command-primary behavior is unchanged. Audit
  policy still excludes command workers (no change).
- **D4 — `agy` needs a NEW synthesis case, it does not "fall out" (review F5):** `primaryInProcessSource`
  is gated twice — the DEMOTABLE set AND a switch with no `agy` arm (falls through to `null`). Un-gating
  the set alone leaves attended `provider:agy` with NO pool and (monopoly branch deleted) NO dispatch at
  all — worse than HEAD. Add the `agy` case synthesized from its config block (`sessionConfig.ts:693`,
  command/model `:285-291`); red-green (a) must assert the agy pool's presence.
- **D5 — host-session quota key (review F3 — corrected):** hoist audit's
  `resolveHostDispatchProviderName` (`rollingAuditDispatch.ts:125-132`) to shared and use it at both
  sites: in-process-worker primary → conversation host; explicit IDE/host provider
  (`vscode-task`/`antigravity`/`claude-code`) → verbatim. Raw `resolveConversationHostProvider` would
  re-key an IDE-hosted run's fan-out to `claude-code` — the founding-bug misattribution class
  ([[capability-is-per-auditor-not-per-audit]]). Its `isHeadlessPrimaryProvider` read survives the
  demote deletion (driver identity, not branch selection).
- **D6 — audit host is eligible-set member, NOT coordinator claimant (spec deviation, stated openly;
  review-confirmed).** Joining the host to audit's coordinator would leak claims (audit's host path is
  not claim-aware — `src/audit/cli/hybridDispatch.ts:80-84`; nothing releases host claims), bound a
  batch reviewer by meaningless per-task capacity, and desync against the coverage-driven complement
  (`ensureSemanticReviewRun` re-derives from `buildPendingAuditTasks`, not `partition.host`). The
  complement already implements §H's substance: host takes everything the engine pools don't, capacity
  = ∞, zero claim bookkeeping. Audit-side collapse content is therefore: unconditional primary fold +
  predicate deletion.

### Commit sequence (loop-core: each green + attestation + independent review)

1. **F4 — capability floor enforced IN the engine** (small, independent, red-green first): thread
   `requiredTier`/`capable` into the engine's per-packet pool-eligibility filter
   (`rollingDispatch.ts:699-706`), wire remediate's packets to carry `requiredTier` + pass `capable`
   (`marshal.ts`), and filter the `grantLeases:false` early-return with explains (contract-display
   half). Red-green asserts non-dispatch to the incapable pool on BOTH draws.
2. **Remediate driver capability** (enabling, no behavior change at call sites yet):
   `driveRollingImplementDispatch` gains partition/pool overrides AND the D2 preservation outputs —
   per-node pool attribution, `exhausted_pool_ids`, partition-scoped terminal/merge suppression.
   Red-green: an override-scoped drive touches only its partition; a partition-scoped wall does not
   persist a run terminal.
3. **THE collapse (atomic):** both branch pairs → one fan-out; `shouldDemotePrimaryInProcess`,
   `DEMOTABLE_IN_PROCESS_PROVIDERS`, `isDemotableInProcessProvider`, the demote params
   (`collectDispatchableSources` option, `buildConfirmedPools`/`buildAuditSourcePools` options,
   `waveScheduling.ts:210` read), and `executeInProcessPartition` all delete in this commit;
   `primaryInProcessSource` un-gates from the DEMOTABLE set + gains the D3/D4 synthesis cases; NEW
   host-vs-source cross-class dedup with the D1 collision rule; cross-cycle settle preserved per D2;
   host-key via hoisted `resolveHostDispatchProviderName` (D5). Spec citation in
   `spec/audit/dispatch-admission-control.md:180` updated; stale comment at
   `src/audit/cli/nextStepCommand.ts:440` swept. Exports pruned (`shared/index.ts:1126-1128`)
   — knip gate enforces.

### Red-green test plan

- F4: an ENGINE drive with one incapable pool + one capable → the packet is never dispatched to the
  incapable pool (assert dispatch behavior on both draws), and the `grantLeases:false` contract file
  carries the skip explain. (Red on HEAD: engine selects by preference order only.)
- Collapse: (a) attended + in-process primary ⇒ primary appears as a member pool AND the frontier fans
  across host+primary — including `provider:agy` (asserts the D4 synthesis; red on HEAD twice over).
  (b) headless ⇒ host pool absent, engine drives whole frontier, call transitions.
  (c) host IS the primary backend (same backend+account) ⇒ ONE pool after cross-class dedup, engine
  self-drive preserved (D1 collision rule — assert the behavior, not the count).
  (d) attended command-shaped primary (remediate) ⇒ fans out as a pool, does NOT monopolize; audit
  policy unchanged. (e) remediate partition drive fires rolling-engine hooks (413 → `packet_too_large`
  re-queue + friction capture) — the D2 payoff, red on HEAD by construction.
  (f) settle preservation (D2): a partition node dying `rate_limited`(with reset)/`quota_unclassified`
  ⇒ its pool settles cross-cycle and is excluded next cycle; a backend-only wall does NOT set the run's
  `partial_completion_terminal`.
- Rewrite/delete inventory (from recon + review F7): `demote-same-agent-guard.test.mjs` (delete),
  `dispatchable-sources.test.mjs` (demote-fold cases rewrite to always-fold; dedup cases keep/extend),
  `rollingDispatch.test.mjs`, remediate `next-step-pipeline-dispatch` / `next-step-implement-dispatch` /
  `rolling-dispatch-engine` / `hybrid-*` / `a8` / `cli-host-capability-flags` /
  **`quota-scheduler.test.ts:594-609`** (source-scans `nextStep.ts` for
  `resolvesToInProcessDispatchProvider` — breaks on rename/delete), audit `hybrid-dispatch` /
  `rolling-audit-dispatch` / `semantic-review-step` / `a8`/`a9` / `dc4` /
  `different-auditor-resume-no-inherit`. `in-process-workers.test.mjs` (H3 drift guard) unchanged.

### Verify before build (leads, not verdicts)

- ~~Audit host-as-member-pool semantics~~ — RESOLVED by the adversarial review as D6 (host is
  eligible-set member, never a coordinator claimant).
- The exact shape of remediate's engine partition override (commit 2): whether the engine's wave/merge
  lifecycle tolerates a partition-scoped frontier without re-deriving the full pending set.
- `resolvesToInProcessDispatchProvider` deletion: audit's copy (`rollingAuditDispatch.ts:97`) also feeds
  `resolveHostDispatchProviderName` (`:128`) — that read is about DRIVER IDENTITY, not branch selection,
  and survives (it becomes the D5 shared hoist) even though the branch predicate dies.

### Review record

Adversarial plan review (independent agent, 2026-07-18): verdict **sound with amendments** — all folded
in above. HIGH findings: F1 (cross-class dedup is new code, not existing), F2 (F4's original fix point
was write-only on the engine path — the satisfied-once-written class), F3 (D5 key collapse would
misattribute IDE-hosted runs), F4 (engine migration would lose DC-4 cross-cycle settle without new
driver outputs). MEDIUM: F5 (agy/worker-command need explicit synthesis), F6 (same-agent collision
semantics), F7 (quota-scheduler source-scan test + stale comment).

Commit-level reviews (all attested; findings fixed pre-commit unless noted):
- **Commit 1** (`c9bd3505`, adversarial-reviewer-f4): approve-with-fixes, none blocking — all four
  fixed in the commit. Notable correction to the review itself: its floor-only display-filter fix was
  vacuous by construction (the relative floor can never refuse every pool), so size refusals are
  labeled `packet_oversized` instead.
- **Commit 2** (`52c8337f`, adversarial-reviewer-h2c2): approve; findings 1 (null-vs-empty partition
  result), 2 (full-wall terminal pin), 4 (documented fallback) fixed in the commit; finding 3 became
  commit 3's `planOverride`.
- **Commit 3** (adversarial-reviewer-h2c3): approve-with-fixes. Blocker F1 (settled-pool re-dispatch
  via unfiltered `poolsOverride` — DC-4 regression) FIXED; F2 (settle-fact friction), F3 (dedup
  mixed-account host-lane loss), F5 (backend_provider identity), F6 (audit hint-enriched
  tasksOverride), F9 (dedup draw policy) FIXED. Implementer deviations 1 (`planOverride` — prevents
  the internal re-prepare clobbering the host-share admission grant) and 2 (`claimOwnerTokens` —
  coordinator claims adopted, no self-collision) VERIFIED CORRECT.

**Blessed semantics (h2c3 F4, recorded not changed):** attended same-agent (host == in-process
primary, e.g. codex-in-codex) is now a SPLIT, not a monopoly: the deduped single pool takes the
coordinator-bounded partition through the engine, and the remainder is emitted as a host-subagent
rolling step on the same account — serial use of one meter (engine partition completes before the
host prepare), never a concurrent double-book. HEAD engine-drove the whole frontier and idled the
attended host; the split is deliberate under one-fan-out. Decision-point-level pin: backlog.

**Routing changes beyond the named edge (h2c3 F7, all deliberate under the collapse):** headless +
host-shaped provider (claude-code / vscode-task / antigravity) with configured sources now
engine-drives those sources (HEAD: sequential step, sources unused); an EMPTY/absent
subprocess-template primary falls to the sequential/host step instead of a doomed monopoly drive; a
Gate-0-excluded primary now fails closed to the sequential step instead of monopoly-driving past the
operator's exclusion.

### Out of scope (stays backlogged)

- `HYBRID_NODE_TOKEN_ESTIMATE` flat sizing (step-G remediate half — separate backlog entry; D2 makes the
  real-estimate wiring easier but it is not this lap).
- G6 read-path unification; G5 quarantine clause; LiteLLM populate adapter.
