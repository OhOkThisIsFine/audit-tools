# G3 plan — the confirmed pool: policy vs reach

Dated plan record. Durable design lives in [`spec/unified-dispatch-worker-model.md`](../../spec/unified-dispatch-worker-model.md)
→ Decomposition G3. One-off; not a timeless concept.

> **Four drafts, four refutations. Do not re-plan from a superseded draft.**
> Draft 1 proposed collapsing the Gate-0 artifact into `RepoSessionIntent` — refuted (the intent paths are
> disjoint *today*; the artifact is the only cross-tool channel until G6). Draft 2 proposed slimming the
> artifact to close an inheritance hole in `excluded` — refuted (**nothing reads `excluded`**; there is no
> hole). Draft 3 deferred the roster-staleness decision behind a "make the gate reachable first" sequence —
> refuted (the goal it was protecting is already specified; the check does not and cannot serve it).
> Draft 4 specced the gate against the wrong reach operand and assumed Gate-0 re-fires — refuted: the gate
> **would not have fired at all** (stale input silently auto-confirms), and `resolveAmbientSources` is
> structurally blind to the event. Draft 4 also proposed striking spec `:283` as stale; that too was refuted
> — it is a **phase**, not residue. Draft 5 fixed the operands but still *reconstructed* the routing set
> instead of reading the documented chokepoint (`gatherDispatchableSources`), left the gate's seam unnamed
> (and the only seam that makes it fire cannot afford a `spawnSync` probe), and ordered B before D — which
> would have self-inflicted the exact silent degrade D exists to fix. The refutations are recorded because
> they are the rationale for what survived.

## The goal (restated first, because every prior draft lost it)

The owner's constraint — *"we also need the user to confirm model choices"* — is **already a resolved
design decision**, not an open question. `spec/unified-dispatch-worker-model.md:193-195`:

> Reconciliation when a resuming auditor reaches a backend the operator never confirmed is keyed on
> `autonomous_mode`: **attended → prompt the delta only** (subset → silent); **autonomous →
> fail-closed-exclude the new backend + a `newly_reachable_backend` friction event.**

**G3's job is to BUILD that gate.** Everything else in this plan is the debris that has to be cleared for
the gate to be expressible.

### Why the roster-staleness check is not that gate (and cannot become it)

The check (`sharedProviderConfirmation.ts:653-662`) detects the right *event* — the reachable set differs
from what was confirmed — and then does the **wrong thing**: it returns `reconfirm`, whose only consumers
are the two gated readers (`:682`, `:728`), which respond by silently discarding the operator's cost order
and λ. It reaches **no obligation** (verified: nothing in `src/audit/orchestrator/` imports it; the
`provider_confirmation` obligation at `state.ts:81-86` is presence-only and is the sole obligation that
bypasses `staleOrSatisfied`). So it enforces **nothing** today.

It also compares the **wrong operands**: `roster` is the *writing* auditor's reach. Under the multi-auditor
model a different auditor legitimately has a different roster, so the comparison is meaningless
cross-auditor by construction — it is precisely the reach-inheritance [[dispatch-policy-vs-reach-cut]]
exists to delete.

The gate the spec specifies compares **the operator's confirmed DECISION** (policy — reach-free, and
legitimately inherited) against **this auditor's freshly-resolved reach** (`resolveAmbientSources`, G2.5).
That comparison is well-defined across auditors. `roster` is not an operand of it.

⇒ The check is not scaffolding for the gate. It is a **degenerate proxy** for it, wired to the wrong
response and the wrong operands. The gate replaces it; the roster field dies with it.

### Why "make the gate reachable" needs no DAG surgery — but IS more than a predicate

Draft 3 assumed a staleness edge was required and treated that as a blocking sequence. It is not: the delta
is computed from **live env/PATH reach**, not from an upstream artifact's content hash — which is exactly
why no existing staleness mechanism can track it (`computeStaleArtifacts` is hash/revision-over-upstream-
*artifacts*; the shared confirmation is not even in `ARTIFACT_DEFINITIONS`). No DAG participation.

**But a predicate change alone is NOT sufficient — draft 4's fatal error.** Flipping
`provider_confirmation` to unsatisfied does **not** re-prompt. `nextStepHelpers.ts:1436-1441` consumes
`provider-confirmation.input.json` if present and routes to the deterministic executor instead of emitting
the prompt — and **that input file is never deleted** (zero `unlink`/`rm` for it anywhere in `src/`). So the
second firing re-consumes the STALE input → `runProviderConfirmationAutoComplete`
(`intakeExecutors.ts:150-181`) → `buildSharedProviderConfirmation` folds the newly-reachable backend into
`provider_pool` with `excluded: false` (`:287-303` excludes only names in `exclude`) → roster re-stamped →
obligation satisfied → drain continues **in the same call**. Net: **a backend the operator never confirmed
becomes silently dispatchable** — the precise negation of the goal.

⇒ The gate requires **consume-and-invalidate**: the input is unlinked after promotion, and/or carries a
reach-fingerprint so a stale submission cannot satisfy a new delta. This is budgeted work, not a free
predicate flip.

## Verified ground truth (re-verified directly at HEAD, not taken from any review)

| Claim | Status | Evidence |
|---|---|---|
| **There are TWO artifacts** — shared (`.audit-tools/provider-confirmation.json`, hyphen) vs per-tool seam (`<artifactsDir>/provider_confirmation.json`, underscore) | ✅ | `sharedProviderConfirmation.ts:81-82` vs `artifacts.ts:269`; both written by `intakeExecutors.ts:159-180` |
| **Dispatch reads only the SHARED one** | ✅ | stated at `src/audit/orchestrator/providerConfirmation.ts:36-37` |
| only the shared artifact carries `roster` / `policy` / `dispatch_bias`; only the seam artifact is in the DAG | ✅ | `sharedProviderConfirmation.ts:170,135,165`; `artifacts.ts:269` |
| `confirmed_provider_pool` is an inert slot | ✅ | zero producers/consumers; `sessionConfig.ts:539,621-625`, stale comment `providerConfirmation.ts:243`, 2 type-only tests |
| …and it is **NOT** in `DISPATCH_INVENTORY_FIELDS`, so it survives onto `RepoSessionIntent` | ✅ | `sessionConfig.ts:637-650` vs `:679-684` — G2 did not strip it |
| `excluded` has **no** dispatch reader | ✅ | only reader is the in-memory Gate-0 renderer `providerConfirmationStep.ts:48` |
| dispatch reads the artifact via `model_id` + `cost_order` **only** | ✅ | `resolveConfirmedCostPositions`, `costRank.ts:299-315` |
| exactly **two** reads gate on roster-freshness | ✅ | `readConfirmedCostPositions:676`, `readConfirmedDispatchBias:722`; `readConfirmedDispatchPolicy:426` already bypasses |
| `reconfirm` reaches **no obligation** | ✅ | consumers are only `:682`, `:728`; zero imports in `src/audit/orchestrator/` |
| `provider_confirmation` is presence-only, the ONLY obligation bypassing `staleOrSatisfied` | ✅ | `state.ts:81-86`, `has` at `:20-22`; contrast `file_disposition` `:94-99` |
| no staleness edge exists, and the key is absent from the map entirely | ✅ | `spec/audit/dependency-map.md:166`; zero grep hits in `dependencyMap.ts` |
| `roster` is read ONLY by its own parse gate + the freshness check | ✅ | `:546` (hard required-field gate) and `:654` |
| `buildSourcePools` is the **shared routing chokepoint** | ✅ | audit `hybridDispatch.ts:67`; remediate `waveScheduling.ts:335` |
| **most providers have NO `model_id` at confirmation time** | ✅ | `representativeModelId` (`providerConfirmation.ts:257-269`) returns a model only for `openai-compatible` + `codex`; `undefined` for claude-code/agy/opencode/worker-command/subprocess-template. `annotateConfirmedPool:399` spreads conditionally (`...(model ? {model_id: model} : {})`) ⇒ no field at all. `DiscoveredProvider` has no `model_id`. `:249-256`: *"a CLI backend's model arrive[s] only at the dispatch handshake"* |
| **THREE distinct keyspaces, do not conflate** — (1) quota-ledger pool identity `provider[#account]/model` (`quotaPoolKey`, `providers/identity.ts`; `account` is load-bearing for the double-grant boundary, spec `:204`); (2) operator EXCLUSION grammar `provider:model` (spec `:206-208`, owner-approved; account is irrelevant to a rule about a backend); (3) dispatch's confirmed-position lookup on the **bare `model_id`** (`costRank.ts:299-315`) — the one the gate's CONFIRMED set is built from | ✅ | nothing forces unification; the `apiPool.ts:22` comment is stale *about (1)* and is not evidence about (2) |
| **`resolveAmbientSources` is blind to undeclared backends** | ✅ | `auditorSources.ts:258-270` iterates ONLY `readSourceDeclaration()` (`~/.audit-code/sources-declared.json`); an installed-on-PATH `codex` is discovered by `discoverProviders` (`sharedProviderConfirmation.ts:204,270`) and never by this |
| `provider-confirmation.input.json` is **never deleted** | ✅ | zero `unlink`/`rm` in `src/`; consumed at `nextStepHelpers.ts:1436-1441` |
| spec `:283-284` ("`DispatchPolicy` … persists on the intent") is a **PHASE, not stale** | ✅ | panel synthesis `dispatch-inventory-greenfield-design-2026-07-16.md:39,73-77` puts `policy{exclusions,cost_order,dispatch_bias,confirmed_by,confirmed_at}` on `RepoSessionIntent` as unanimous **Decision (A)** — and it PREDATES draft 1; spec **G6** (`:296-297`) is what closes the disjointness |
| `autonomous_mode` survives onto `RepoSessionIntent`; only its RESOLVER is remediate-local | ✅ | `types/sessionConfig.ts:579`, validated `validation/sessionConfig.ts:597-603`, absent from `DISPATCH_INVENTORY_FIELDS` `:637-650`; resolver `nextStep.ts:201-209` ⇒ lifting gives audit a real flag, NOT dead code |
| `provider_confirmation` is `PRIORITY[0]` | ✅ | `nextStep.ts:26` — an obligation that never clears is a drain livelock, not a no-op |

## The gate's operands (named explicitly — undefined operands produced drafts 1-4)

- **Comparison key = the operator-facing exclusion grammar, `provider:model`** (spec `:206-208`,
  owner-approved), with `provider` and endpoint-host as coarser patterns. **Not**
  `provider[#account]/model` — that is the internal quota-pool identity key (`quotaPoolKey` in `providers/identity.ts`) and a
  different keyspace. The two are reconciled by *keeping them distinct and saying so*, not by unifying.
  **Model granularity is the goal, not a refinement:** the owner said *model* choices. A second NIM model
  under an already-confirmed `openai-compatible` introduces no new *provider* — at provider granularity the
  delta is empty and it dispatches unconfirmed. Provider-name granularity misses the goal outright.
- **The key = `model_id ?? provider-name`.** Not the bare `model_id`: `representativeModelId`
  (`providerConfirmation.ts:257-269`) knows a model only for `openai-compatible` and `codex` — for
  claude-code / agy / opencode / worker-command it returns `undefined` and `annotateConfirmedPool:399`
  omits the field entirely, because *"a CLI backend's model arrive[s] only at the dispatch handshake"*
  (`:249-256`). A bare-`model_id` key ⇒ install `agy` on PATH ⇒ REACH-NOW sees it ⇒ it contributes **no
  key** ⇒ delta empty ⇒ **the gate silently dispatches it** — re-opening the PATH-appearance case that is
  the gate's primary reason to exist, and in the worse direction (blind, not livelocked). `model_id ??
  provider-name` is **the spec's own provision** (`:206-208`: default `provider:model`, *"with `provider`
  and endpoint-host as coarser patterns"*) — the model where knowable, the coarse `provider` pattern where
  it isn't. It is also already the coarse tier of A″'s grammar, so A″ shrinks to widening the parser + the
  `resolveExcludedProviders` matcher.
- **CONFIRMED set** = the `model_id ?? provider-name` keys of the persisted decision: `provider_pool` ∪
  `source_pool_cost_order` ∪ `host_model_cost_order`. (`provider_pool` cannot supply `provider:model` keys
  — see above.)
- **REACH-NOW set** = `discoverProviders(effectiveConfig, env)` ∪
  **`gatherDispatchableSources(effectiveConfig, primaryProviderName)`** — the documented **chokepoint**,
  never `resolveAmbientSources`. `apiPool.ts:463-469` states the invariant directly: *"The single async
  source-gather point: both the dispatch pool builder (`buildSourcePools`) and the Gate-0 confirmation
  surface consume it, so what the operator confirms is exactly what routes (no display/dispatch drift on the
  source set)."* `nextStepCommand.ts:865` already calls it. **Re-deriving reach from `resolveAmbientSources`
  re-introduces exactly the display/dispatch drift that invariant forbids** — it is an *input* to the
  chokepoint, not the chokepoint. Three backends route without ever appearing in it
  (`collectDispatchableSources`, `apiPool.ts:437-461`):
  - **descriptor-supplied sources bypass it entirely** — `resolveSessionConfig:104` is
    `descriptor.sources ?? resolveAmbientSources(options).sources`, so with an explicit `--auditor
    sources[]` (the operator escape hatch, spec `:254`) `resolveAmbientSources` **is never called**;
  - **the demoted primary**, synthesized at gather time (`:450-453`);
  - **the legacy `openai_compatible` fold** (`:454-459`) — it is not in the declaration file.
    ⚠ **Correction (A″ review, verified at HEAD):** the original claim here — *"`openai-compatible` has no
    `CLI_PROBES` entry, so `discoverProviders` never sees it"* — is **FALSE**. `providerConfirmation.ts:196-200`
    surfaces `openai-compatible` explicitly when it is configured (no PATH probe needed). The plan's REACH-NOW
    conclusion is unaffected, but do not reason from the retracted clause: it is precisely *because*
    `openai-compatible` DOES enter `provider_pool` with a `model_id` that a confirmed model is recognized and
    its siblings still delta.

  Draft 4 used `resolveAmbientSources` alone: it deleted the mechanism that observed the event and replaced
  it with one structurally blind to it. Draft 5 added `discoverProviders` but still reconstructed the
  routing set instead of reading the chokepoint.
- **DELTA** = `REACH-NOW \ CONFIRMED` (set difference; a FILTER over fresh reach, never additive — spec
  `:185-195`). `CONFIRMED \ REACH-NOW` is a *subset* case → silent, per spec `:194`. This is why the
  synthetic `worker-command` entry (`sharedProviderConfirmation.ts:278-285`) and `host_model_cost_order`
  need no special handling — both sit in CONFIRMED but not REACH-NOW, i.e. the harmless direction.

### The seam — precomputed once per invocation, NOT inside the predicate

**`discoverProviders` must never be called at obligation-derivation time.** `commandExists` →
`probeCommandOnPath` → **`spawnSync("where"/"which")`** (`providerPathGuard.ts:28-38`); `discoverProviders`
loops 4 `CLI_PROBES` and agy's `configCommand` calls `commandExists` twice more
(`providerConfirmation.ts:119-125`) ⇒ ~6 `spawnSync` per call. `deriveAuditState` is **sync, pure, called
from ~20 sites** — three of them inside the drain loop (`advance.ts:156,226,339`) with
`MAX_DRAIN_STEPS = 64` ⇒ worst case **1,100+ process spawns per `next-step`**. It would also make
`deriveAuditState` PATH/env-dependent, and `setCommandExistsForTesting` is process-global with a mandatory
`finally` restore (`:50-59`) — every bundle-derives-state test would start shelling out.

**But presence-only cannot stay either:** satisfied-once-written ⇒ `decideNextStep` never re-selects it ⇒
`execute` never runs ⇒ **the gate never fires** (F1 in a new costume).

⇒ **Compute the DELTA once per invocation at `nextStepCommand.ts:316-318`**, stash it on the bundle/ctx,
and let the **pure** predicate read the precomputed field. `state.ts:81-86` reads the field; it does not
probe. **Also wire the headless path** — `runProviderConfirmationAutoComplete` (`intakeExecutors.ts:124`)
is where the autonomous branch actually runs; a CLI-only gate leaves autonomy ungated.

**The seam is `:316-318` exactly**, not "the `:249` region": at `:249` only `intent` exists
(`await loadSessionConfig`); the descriptor is built at `:285-315`; `effectiveConfig =
resolveSessionConfig(intent, hostDescriptor)` lands at **`:316`**; `runDeterministicForNextStep` (the drain
→ `decideNextStep`) is called at `:318`. `primaryProviderName` is resolvable only after `:316`, via
`resolveFreshSessionProviderName(undefined, effectiveConfig, { env: process.env })` — the precedent is
`:862`. `gatherDispatchableSources` is async-in-signature but sync-in-body (`apiPool.ts:471-477` →
`return collectDispatchableSources(...)`) and `:316` is already inside an async function ⇒ **async is a
non-issue**.

**Gate the precompute on confirmation presence.** Today the ~6-10 `spawnSync` probes run *only* when the
Gate-0 step is emitted (`:862-865`, inside `if (result.kind === "provider_confirmation")`). Precomputing at
`:316-318` would run them on **every** `next-step`, including ones deep in synthesis — a new unconditional
hot-path cost. Skip the precompute when `!has(bundle.provider_confirmation)`: the obligation is `missing`
regardless, so the delta is moot. Compute only when a confirmation already exists.

## Scope

Bug 1 (`c99bcb9c`) already landed the reach-free `ConfirmedDispatchPolicy` (raw `exclude`/`include`) and
the `readConfirmedDispatchPolicy` bypass. G3 completes the cut on top of it.

### Commit A′ — the replace (steps 1-3 are ONE commit)

They are inseparable: step 1 removes `reconfirm`'s only two consumers (`:683`, `:729`), so the check's
*behavior* dies at step 1 — not step 3. Landing 1 without 2 leaves a window where nothing enforces
confirmation. **Atomic-replace invariant ⇒ one commit.**

**Step 6 is NOT in this commit.** Draft 5 claimed *"the gate is keyed by the grammar, so 6 cannot follow
it"* — **false**: the gate compares `REACH-NOW \ CONFIRMED`, and **neither operand is `policy.exclude`**.
The grammar enters only the *autonomous write* branch. So A′ ships keyed on `model_id ?? provider-name`
with the autonomous write at provider-name granularity, and A″ widens both. The gate exists throughout ⇒
no unenforced window at any point.

> **⚠ Deliberate intermediate state (A′ → A″ window) — declare it in the handoff, it is not a bug.**
> A′'s `policy.exclude` is still `ResolvedProviderName[]`, so the autonomous branch excluding ONE new NIM
> model writes `exclude: ["openai-compatible"]` ⇒ `resolveExcludedProviders` ⇒ `buildSourcePools` drops
> **every** NIM source. This promotes the bug-1 keyspace caveat from wart to live behavior until A″ lands.
> Blast radius ≈ 0 (audit's `autonomous_mode` is brand-new in 2b, so nothing depends on it yet), but
> CLAUDE.md requires calling out deliberate intermediate states so they aren't mistaken for bugs.
>
> **No livelock, verified:** the delta clears via the wholesale re-write, not via `policy.exclude` —
> `buildSharedProviderConfirmation` rebuilds `provider_pool` from `discoverProviders` and
> `annotateConfirmedPool` rebuilds `source_pool_cost_order` from `sources`, and excluded entries stay
> **in** the pool (`:296-303` sets `excluded: true`, it does not drop the entry) ⇒ the new backend enters
> CONFIRMED ⇒ delta empty. This stays coherent post-B: `excluded` leaves the persisted shape, the entry
> remains in `provider_pool`, and the exclusion lives in `policy.exclude`, which B does not touch.

**1. Ungate policy from reach (fixes bug 2).** `readConfirmedCostPositions` / `readConfirmedDispatchBias`
stop routing through `readSharedProviderConfirmation`'s freshness verdict and read the persisted decision
directly, per the `readConfirmedDispatchPolicy:426-439` precedent (*freshness must not gate policy*). Cost
order and λ are POLICY — panel synthesis `:39` lists both under `policy`, and
`providerConfirmation.ts:188-192` says *"the operator may reorder"*. The module's `:406-410` doc-comment
asserting they "ARE reach-derived" is wrong and goes with the change.

**2. Build the reconciliation gate** (the goal), at the `provider_confirmation` obligation:
- DELTA empty (or reach ⊂ confirmed) → satisfied, silent.
- DELTA non-empty, **attended** → unsatisfied → emit a **delta-only** prompt (see 2c).
- DELTA non-empty, **autonomous** → **write the fail-closed exclusion into `policy.exclude` and re-write
  the confirmation**, then emit a `newly_reachable_backend` friction event. **Persistence is mandatory,
  not incidental:** `provider_confirmation` is `PRIORITY[0]` (`nextStep.ts:26`), so a delta that recomputes
  every call and never clears is a **drain livelock**, not a no-op.
- **2a. Consume-and-invalidate.** Unlink `provider-confirmation.input.json` after promotion and/or stamp it
  with a reach-fingerprint, so a stale input cannot satisfy a new delta (`nextStepHelpers.ts:1436-1441`).
  Without this the gate never fires at all.
- **2b. Lift `resolveAutonomousMode`** `src/remediate/` → shared (one core, two draws; rename the
  `REMEDIATE_*` env var — *ideal code over compatibility*). The flag itself already lives on the shared
  `SessionConfig` (`:579`) and survives onto `RepoSessionIntent`, so this is a real branch, not dead code.
- **2c. Delta-only prompt — budgeted, not free.** `renderProviderConfirmationPrompt`
  (`cli/providerConfirmationStep.ts:18-34`) takes `{providerPool, sourcePools, inputPath, continueCommand}`
  — no delta channel — and `nextStepCommand.ts:866-874` rebuilds `suggested` from scratch each time.
  Needs a renderer + step-contract param. **Honest limit:** `ProviderConfirmationInput` (`:748-791`) has no
  "confirm these keys" field, and promotion rebuilds `provider_pool` wholesale via `annotateConfirmedPool`,
  so *any* submission — including the documented accept-verbatim `{"schema_version": …}` — clears the whole
  delta. The delta-only prompt is therefore **advisory** (it shows the operator what is new), not
  enforcing. Adding a confirm-keys field would make it enforcing; not budgeted here.

**3. Delete the check + `roster`.** With (1) and (2) in place `reconfirm` has zero consumers and `roster`
has zero readers beyond its own parse gate (`:546`). Both die **in this same commit**.

### Commit A″ — pin the exclusion grammar to `provider:model`

Widens `policy.exclude` and the gate's key together. A **type + parser change**, not an extraction:
`ConfirmedDispatchPolicy.exclude?: ResolvedProviderName[]` (`sharedProviderConfirmation.ts:121`) becomes a
pattern list, and `parseProviderNameList` (`:371-384`) — which membership-checks against
`RESOLVED_PROVIDER_NAMES` and would **reject** any `provider:model` string — is replaced by a pattern
parser. Draft 4 cited "extract `quotaPoolKey`" and would have left the caveat fully intact.

**Budget the ripple (draft 5 under-scoped this as "two files").** `resolveExcludedProviders` (`:386-397`)
can no longer return `Set<ResolvedProviderName>` — it becomes a **matcher over source keys**. Consumers:
`buildSourcePools`'s `excludedProviders` param (`apiPool.ts:494-501`), `hybridDispatch.ts:61`,
`waveScheduling.ts:298`, `nextStep.ts:1141,1975`, `nextStepHelpers.ts:1812` — spanning `src/shared/quota/`
(loop-core `:45`), `src/audit/orchestrator/` (`:37`), `src/remediate/steps/nextStep.ts` (`:41`),
`src/remediate/steps/dispatch/` (`:40`).

Also fix the stale `apiPool.ts:22` comment and reconcile the drifted `"?"` vs `"default"` tail (cosmetic
today — `sourceId()` keys only unverified `DroppedSource.id`, `dispatchSourceKey()` keys verified; disjoint
by construction, `auditorSources.ts:264-268`).

Resolves the bug-1 keyspace caveat: `exclude` naming a provider excluded *every* NIM source.

### Commit B+D — delete write-only reach, with loud rejection (MERGED — ordering is load-bearing)

**D cannot follow B.** `isConfirmedPoolEntry` (`:485-495`) hard-requires `capability_tier` **and**
`excluded`, and `parseSharedProviderConfirmation:541-545` rejects the whole artifact if any pool entry
fails ⇒ a post-B confirmation fails the pre-B parse gate ⇒ `null` ⇒ empty positions + λ=0. B alone would
land **the exact silent degrade D exists to fix**, self-inflicted and unobservable until D arrives.

- Delete `capability_tier` / `self_spawn_blocked` / `excluded` / `reason` /
  `blended_price_usd_per_mtok` from the **persisted** shape (parse-only or unread from disk,
  recon-verified per-field), and update the parse gate in the same commit.
- **Split the PRODUCER, not the write site.** `buildSharedProviderConfirmation` is the single function
  feeding **both** consumers: persist (`intakeExecutors.ts:168-179` → `writeSharedProviderConfirmation`)
  and render (`nextStepCommand.ts:866-874` → `suggested.provider_pool` → `renderProviderConfirmationPrompt`,
  which reads `self_spawn_blocked` `:47`, `excluded` `:48`, `capability_tier` `:55`,
  `blended_price_usd_per_mtok` `:41-44`). "Retain it as the render DTO" does not happen by assertion: if
  the persisted field stays typed `ConfirmedPoolEntry[]`, `writeJsonFile` serializes the reach fields
  regardless. **"A projection at the write site" is wrong** — `writeSharedProviderConfirmation` receives an
  already-typed `SharedProviderConfirmation`, so projecting there leaves the reach fields **representable
  on the type**, violating the G2 principle this whole track rests on (*"unrepresentable, not guarded"*,
  spec `:172-176`). **Precise:** split `buildSharedProviderConfirmation` into a **render-builder** (full
  DTO → `nextStepCommand.ts:866`) and a **persist-builder** (projects to `PersistedPoolEntry[]` →
  `intakeExecutors.ts:168`). `annotateConfirmedPool` (`:345-428`) stays whole — it is the full-DTO producer
  and needs no split.
- **Loud rejection:** a `schema_version` bump makes `parseSharedProviderConfirmation:537` return `null` →
  silent degrade. Make it **friction**, not silence. (`readConfirmedDispatchPolicy:426-439` bypasses the
  parser, so policy already survives a bump — fail-closed, correct.)

**Safe with respect to A′:** the gate's CONFIRMED operands survive — `name` + `model_id` + `cost_order` are
retained, `source_pool_cost_order` / `host_model_cost_order` are untouched, and the autonomous branch
writes `policy.exclude`, which B does not touch.

### Commit C — delete the inert slot

`confirmed_provider_pool` (incl. off `RepoSessionIntent` — it is NOT in `DISPATCH_INVENTORY_FIELDS`, so G2
left it there), `ConfirmedProviderPoolRef`, `ConfirmedProviderPool`, `applyProviderConfirmationSelections`,
the `index.ts:890,896` re-exports keeping default-mode knip green, and the two type-only tests.

### Commit order

**A′ → A″ → B+D → C.** No unenforced window at any point: the gate exists from A′ onward.

### Explicitly NOT in scope
- **Honoring an exclusion of the host/primary provider.** `resolveExcludedProviders` always contains the
  conversation host in-session, so feeding it to the host-pool builder would zero out dispatch. What
  excluding your own driver should *mean* is a separate design question. Backlog residue (a).
- **G5's auditor-id stamp + the reactive lies-reachably quarantine.** The gate here is decision-vs-reach,
  which needs no identity. Identity is G5's.

## Loop-core

**Attestation required.** `LOOP_CORE_PATTERNS` (`loopCorePaths.ts:27-48`) hits: `src/audit/orchestrator/`
(:37), `src/shared/dispatch/` (:43), `src/audit/cli/dispatch.ts` (:32), `src/remediate/steps/dispatch/`
(:40), `src/remediate/steps/nextStep.ts` (:41), **`src/shared/quota/` (:45)**. Verified free:
`src/shared/types/`, `/validation/`, `/config/`, `/providers/`, `/friction/` — note
`sharedProviderConfirmation.ts` is itself NOT matched, so a shared-module-only change would escape the
gate while any call-site change trips it.

## Also in scope / red-green pivot

`tests/shared/provider-self-spawn-exclusion.test.mjs` (encodes the reach-derived `excluded` behavior),
`tests/shared/provider-confirmation-cost.test.mjs` (~10 round-trip tests),
`tests/shared/providerConfirmation.test.mjs:238-254` (the type-only slot tests),
`tests/audit/provider-confirmation-gate.test.mjs:207` + `tests/audit/dc2.test.mjs` (the only
`readSharedProviderConfirmation` / `currentProviderRoster` consumers),
`docs/audit-pkg/operator-guide.md:205-256`, `spec/cost-first-routing.md:87-95`,
`spec/dispatch-cost-speed-dial.md:123-128`, `src/shared/index.ts:1400-1401` (knip).

**Spec amendment (PHASE it — do NOT strike it):** `spec/unified-dispatch-worker-model.md:283-284` says
`DispatchPolicy` persists on the intent. That is an **owner-approved endpoint** (panel synthesis `:39`,
`:73-77`, unanimous Decision (A) — and it predates draft 1), not stale text. It is simply not reachable
until **G6** unifies remediate's intent read path: today audit reads `<artifactsDir>/session-config.json`
(`nextStepCommand.ts:249` → `supervisor/sessionConfig.ts:16-21`) and remediate reads
`<root>/.remediation-artifacts/session-config.json ?? <root>/session-config.json`
(`nextStep.ts:1801-1804`) — genuinely disjoint, so policy on the intent would not transport audit→remediate.
Amend `:283` to phase it: *policy persists on the confirmation artifact (the only cross-tool channel) until
G6 unifies the intent read path; the intent-carried endpoint stands.* Draft 4 proposed striking it — that
would have deleted an approved decision to match an implementation gap.
</content>
</invoke>
