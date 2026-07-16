# Dispatch: is there an auditor/remediator separation? — 2026-07-16

Dated record. Owner question: *"Why is there any separation between dispatch for the auditor and for the
remediator? We're supposed to be dissolving the distinction. Dispatching requires only: (1) discovery of
available dispatch pools, (2) estimating tokens per task, (3) estimating quota per pool, (4) apportioning
tasks to packets and to pools. What else is coming in here?"*

Assessed by three independent recon passes over HEAD `26076e34` (audit path, remediate path, shared core).

## Answer

**There is no separation in the dispatch ENGINE — it is already one core.** The owner's four concerns are
the right decomposition and are already single-sourced. What remains is (a) ONE thin duplicated assembly
wrapper, self-annotated as a mirror, and (b) two other stages fused under the name "dispatch."

## What is already single-sourced (both sides call it)

| Concern | Shared module | Audit caller | Remediate caller |
|---|---|---|---|
| Rolling drive loop | `dispatch/unifiedRolling.ts:221` (`driveRolling`) | `src/audit/orchestrator/rollingDispatch.ts:118` | `src/remediate/steps/nextStep.ts:820` |
| Packet engine (1394 L) | `dispatch/rollingDispatch.ts` | ✔ | ✔ |
| Capacity fold (697 L) | `quota/capacity.ts` (`computeDispatchCapacity`) | ✔ | ✔ |
| Admission | `dispatch/admissionLoop.ts` (`computeDispatchAdmission`) | ✔ | ✔ |
| **Apportionment math** (owner's 4) | `quota/scheduler.ts:624` (`scheduleWave`) | via capacity | via capacity |
| **Token estimation** (owner's 2) | `tokens.ts:43` (`estimateTokensFromBytes`) | `reviewPacketSizing.ts:53` | `phases/plan.ts:182` |
| Pool builders (owner's 1) | `quota/apiPool.ts` (`buildHostModelPools`, `buildSourcePools`) | ✔ | ✔ |
| Hybrid partition | `dispatch/hybridDispatch.ts` (`planHybridDispatch`) | ✔ | ✔ |
| Wall / livelock / leases | `dispatch/hostDispatchWall.ts`, `admissionLeaseReconcile.ts` | ✔ | ✔ |

`driveRolling` is genuinely one loop; audit is the honest degenerate case — one level of `read_only: true`
nodes collapsed to a single sub-wave (`rollingDispatch.ts:117-122`). **That is exactly "one core, two draws."**
Token estimation in particular has no second implementation anywhere — done, no action.

## The one real fork — pool assembly + quota emit

`driveRolling` takes `confirmedPools: CapacityPool[]` **already built** (`unifiedRolling.ts:120`). There is
**no shared function from `(work items, auditor descriptor) → (assignments to pools)`.** Each side
hand-assembles:

- audit: `buildDispatchPool` → `finalizeDispatchQuota` (`src/audit/cli/dispatch/quotaPool.ts:90`, `:240`)
- remediate: `buildHostPoolPreamble` → `buildConfirmedPools` → `buildDispatchQuota`
  (`src/remediate/steps/dispatch/waveScheduling.ts:149`, `:281`, `:351`)

**Driving is unified; assembly is forked.** `quotaPool.ts:113-208` ≡ `waveScheduling.ts:152-223` — the same
eight steps in the same order: resolve provider name → resolve host model → derive `quotaModelKeySegment`
(**byte-identical**: `quotaPool.ts:129` vs `waveScheduling.ts:164`) → host concurrency limit → capability
limits → `readQuotaStateOrDegrade` → `buildQuotaSource(...)` → `buildHostModelPools({ resolve })`.

The variance is small and already callback-shaped — provider/model resolution, the `resolve` limits-merge,
and audit's extra tier layer. **None is a category error; they are policy knobs on one algorithm.**

Second duplicate — the emit wrapper: `finalizeDispatchQuota` (`quotaPool.ts:240-380`) ≡ `buildDispatchQuota`
(`waveScheduling.ts:351-416`), plus two near-identical contracts: `DispatchQuota`
(`src/audit/quota/index.ts:105-131`) vs `RemediationDispatchQuota` (`src/remediate/steps/types.ts:148-172`) —
**12 shared fields**; audit adds `host_model_roster` + `tier_budgets`, remediate adds `phase` +
`estimated_wave_tokens`. One contract with two optional extensions, maintained as two.

### The code already knows

- `waveScheduling.ts:362`: *"Mirrors audit's `finalizeDispatchQuota` grantLeases parameterization."*
- `src/audit/cli/rollingAuditDispatch.ts:4`: *"the symmetric counterpart of remediate's
  `driveRollingImplementDispatch`."*
- `src/audit/quota/index.ts:102`: **`DispatchQuota` declared "Auditor-only type (not in shared)"** — the
  kept-in-parity pattern the principle rejects.
- **Decisive:** `waveScheduling.ts:111-118` single-sourced this very preamble across remediate's *two internal
  consumers*, arguing *"Both consumers were maintaining a byte-identical copy of this block; a change to (say)
  the quota-key segment had to be made in both places."* **That is the owner's argument — applied within
  remediate and stopped at the audit boundary.**

[[auditor-remediator-mirroring-is-common-logic]] [[dissolve-auditor-remediator-distinction]]

## "What else is coming in?" — the honest inventory

The four concerns are the core but are a minority of the code under the name "dispatch" (~13 of 38 audit
concerns; ~5 of 18 remediate concerns). Three other things are present:

### 1. The dispatch ACT — genuinely missing from the four, essential
Launching the worker (`src/remediate/steps/nextStep.ts:1131`, `providerNodeDispatch.ts`;
audit `rollingAuditDispatch.ts:462-527`) and **claim exclusivity** so two drivers can't take one node
(`ClaimRegistry`, `nextStep.ts:1162`). The owner's four describe a *planner*; real dispatch also owns
transport and exactly-one-claimant.

### 2. Cross-cutting machinery — essential, but not dispatch logic
Claims/leases/locks, atomic persistence, pause/resume carry-forward, livelock + no-progress guards
(audit `dispatch.ts:264-295`, `:630-674`, `:690-744`; `pausePersist.ts:97-186`). This is multi-agent
concurrency + resumability wrapped *around* dispatch. The largest non-core mass on the audit side.

### 3. Leakage and a misfiled stage — the actual bloat

- **Audit-domain leakage into dispatch:** `prepareDispatchArtifacts` both *decides* and *renders the audit
  prompt* — large-file anchor extraction reads source files (`packetPrompt.ts:123-161`), lens definitions
  (`dispatch.ts:231-232`), knip lead indices (`dispatch.ts:443-458`). The same function that apportions
  tokens reads files to extract anchors.
- **Remediate-domain leakage into merge:** `dependencyVerifiedComplete` (`marshal.ts:265`), the DC-5
  obligation gate (`marshal.ts:592-595`), amendment ownership routing. Dispatch shouldn't know what an
  obligation is.
- **A whole separate stage is misfiled as dispatch.** **3,470 of the 5,326 lines under
  `src/remediate/steps/dispatch/` are worktree / accept / writeScope / verifyCommands** — a *post-worker
  landing stage*. Decisive evidence: `executeNodeInWorktree` (`acceptNode.ts:749`) is called by the **driver**
  (`nextStep.ts:1190`), NOT by `prepareImplementDispatch`, which ends at `marshal.ts:427` having written plan
  + quota and never touching a worktree. They live under `dispatch/` only because the barrel
  (`dispatch.ts:49-134`) aggregated them. `acceptNode.ts:332` even takes a base-branch lock — a serialization
  concern with zero dispatch content.

**The real cut: dispatch is three stages fused under one name — select/pack, size/admit (the owner's four),
launch/land.** The owner's model describes the middle stage correctly.

## Consequence for the G-series

**G6 as specced is the wrong shape.** "Wire `--auditor` into remediate too" accepts the fork and gives it a
second copy of the descriptor. If assembly is lifted into shared with the descriptor as an input, **remediate's
pool returns as a consequence, not a feature** — and the un-released regression
(`docs/reviews/g4-g5-g6-premise-check-2026-07-16.md`) closes without a G6-shaped lap.

**G4 likewise dissolves partly.** Its inverted-precedence bug lives at `limits.ts:115` / `quotaPool.ts:129` —
the latter is *inside the duplicated preamble*. Single-sourcing the preamble is the natural place to fix the
precedence once instead of twice.

### Descriptor sourcing — RESOLVED by verification, not an owner call

The question "(i) flag round-trip vs (ii) in-process" was a **false binary**. Verified field-by-field against
`src/shared/types/auditorDescriptor.ts:19-94`: the descriptor splits along a real line.

**"About the ENVIRONMENT" — already in-process; `--auditor` absent is ALREADY the working fallback:**
- `sources` — `resolveSessionConfig.ts:104`: `descriptor.sources ?? resolveAmbientSources(options).sources`
- `self.provider` — `resolveConversationHostProvider` env-detects codex/claude-code/agy → defaults
  `claude-code` (`providerPathGuard.ts:130-144`)
- `self.can_dispatch_subagents` — explicit → config → env → `true` (`sessionConfig.ts:49-62`)
- `auditor_id` / `resolved_at` — trivially derivable (and `auditor_id` is write-only today; see the G5 entry)
- per-source quota — rides `DispatchableSource.quota` (`sessionConfig.ts:327`)

**"About ME (the host agent)" — genuinely host-only, unknowable to a spawned CLI:**
`self.model_id`, `self.context_tokens`, `self.output_tokens`, `self.roster`. The in-process fallbacks are all
*operator config*, not ambient signal: `resolveHostModel` = flag ?? `block_quota.host_model` ?? env
(`limits.ts:63-70`); `CLAUDECODE` is boolean presence only (`providerPathGuard.ts:72-74`). Absent ⇒ 32k/4096
floor (`tokens.ts:18-19`) and `provider/*` quota-key (`quotaPool.ts:129`); absent roster ⇒ single-pool path,
`tierBudgets: null` ⇒ tiered routing silently off. **`resolveAmbientSources` cannot supply these and never
will** — it probes env-var presence / PATH launcher / readable credentials (`auditorSources.ts:157-240`), all
*external* backends. The running agent's own model identity is not on PATH, not an env var, not a file.
**G2.5's mechanism generalizes to pools, not to self.**

**Endpoint: (ii) for the shared assembly entry, `--auditor` as OPTIONAL fidelity enrichment for those four.**
Pool assembly needs only environment-class fields → **zero host input required**.

**Consequence:** remediate gets a working pool by replacing its three hardcoded
`resolveSessionConfig(…, null)` sites (`contractPipeline.ts:1659`, `nextStep.ts:1788`, `:3225`) with a
non-null descriptor. **The regression is a three-line fix, not a G6-shaped lap.** Host-pool *fidelity* for
remediate (the four fields) is a separate, later call — without them remediate's host pool sizes to the 32k
floor, which is a degradation, not a block.

**⚠ Carries a constraint on the lift:** none of `model_id`/`context_tokens`/`output_tokens`/`roster`/
`max_active_subagents` are mapped onto the effective config by `resolveSessionConfig` (`:86-116`) — they reach
dispatch through the parallel hand-threaded channel (three audit CLI commands). **If shared assembly takes a
descriptor, that channel MUST collapse into it in the same commit**, or shared assembly reads one channel
while audit threads the other. This is the same parallel channel G4 names — which is why G4's fix belongs in
this lap, not its own.

## Recommended endpoint

One atomic replace ([[prefer-ideal-code-no-backcompat]], atomic-replace ordering invariant):
1. Lift the host-pool preamble into `src/shared/quota/apiPool.ts` beside `buildHostModelPools`, with
   `resolveProviderIdentity` + `resolve` as the policy hooks.
2. Lift `finalizeDispatchQuota`; collapse `DispatchQuota` + `RemediationDispatchQuota` into one shared
   contract with an optional per-mode extension.
3. Delete both local copies in the same commit.
4. Fix G4's inverted precedence once, in the lifted preamble.

Seams are pre-cut — `buildHostModelPools`, `computeDispatchCapacity`, `computeDispatchAdmission`,
`admissionPoolsFromSummaries` are already shared and already take the right hooks.
**Third consumer to check:** `src/shared/repair/brokeredDispatch.ts:32` calls shared `scheduleWave` /
`estimateTokensFromBytes` directly and its header asserts no seam consumer calls `scheduleWave` or a provider
directly — re-verify against the new entry point.

Separately (NOT this lap, logged to backlog): rename/re-home the landing stage out of `steps/dispatch/`, and
pull audit's prompt-rendering + anchor extraction out of `prepareDispatchArtifacts`.

## Defects found in passing (logged to backlog)

1. **Dead code:** `src/audit/quota/headerExtraction.ts` + `headerExtractors/` — zero production consumers
   (only the `index.ts` re-export + its own test). The tested-but-unwired class
   [[knip-deadcode-gate-default-mode]] says default-mode knip can't catch.
2. **Fail-open/fail-closed inconsistency:** `prepareDispatchCommand.ts:17-23` and `quotaCommand.ts:25` swallow
   an invalid session-config to `{}` ("using defaults"), while `dispatch.ts:219-230` documents fail-closed as
   the invariant *precisely because* a permissive default builds dispatch against an attacker-influenced
   config.
3. **Divergent driver identity:** `prepareDispatchCommand.ts:28` uses `resolveFreshSessionProviderName` where
   the host path (`semanticReviewStep.ts:117`) uses `resolveHostDispatchProviderName` — the founding-bug shape
   the latter exists to prevent. Only one entry point carries the guard.
4. **`withinRoot` reimplemented 5×** (`dispatch/paths.ts:10`, `openAiCompatibleProvider.ts:763`,
   `extractors/graph.ts:520`, `analyzers/typescript.ts:122`, partially `worktreeLifecycle.ts:91`) — a
   root-containment *security* guard. Strongest single-source candidate outside the main fork.
