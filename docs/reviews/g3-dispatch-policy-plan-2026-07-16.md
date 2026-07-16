# G3 plan — split the confirmed pool along policy-vs-reach

Dated plan record. Durable design lives in [`spec/unified-dispatch-worker-model.md`](../../spec/unified-dispatch-worker-model.md)
→ Decomposition G3. One-off; not a timeless concept.

> **This plan was REWORKED after an independent adversarial review returned REWORK.** The first draft
> proposed collapsing the Gate-0 artifact into a `dispatch_policy` field on `RepoSessionIntent`. That
> proposal was **refuted on a false premise** — see "The refuted collapse" below. It is recorded rather
> than deleted because the refutation is the load-bearing rationale for the design that survived.

## What recon refuted (do not re-plan from the old draft)

`confirmed_provider_pool` is an **inert slot** — zero producers, zero consumers, verified by two
independent exhaustive greps across `src/`, `tests/`, `schemas/`, `scripts/`, `.claude/`, `examples/`,
`assets/`, `dist/`, and JSON fixtures:

| Site | Kind |
|---|---|
| `src/shared/types/sessionConfig.ts:539,621-625` | definition + the `ConfirmedProviderPoolRef` stub (`{providers: unknown[]; excluded: string[]; addedUndetected: unknown[]}` — doesn't even match the authoritative `ConfirmedProviderPool`) |
| `src/shared/providers/providerConfirmation.ts:243` | stale doc comment claiming the pool is "suitable for persistence in SessionConfig.confirmed_provider_pool" — it never persists there |
| `tests/shared/providerConfirmation.test.mjs:238,251` | type-only tests pinning the empty slot |

So "split the field" ≈ `delete`. Fold in the adjacent **tested-but-unwired** class while here:
`ConfirmedProviderPool` (`providerConfirmation.ts:47`) and `applyProviderConfirmationSelections` (`:442`),
exported via `index.ts:890,896`, have test-only consumers.

## The refuted collapse (why the artifact stays)

The first draft claimed *"the artifact is audit-written and remediate-read; the intent is read by both"*,
and proposed deleting `.audit-tools/provider-confirmation.json`. **The intent is NOT read by both.** The two
tools' intent paths are disjoint:

- **audit** → `<root>/.audit-tools/audit/session-config.json` (`src/audit/supervisor/sessionConfig.ts:16`
  + `auditArtifactsDir`, `src/shared/io/auditToolsPaths.ts:63`)
- **remediate** → `<root>/.remediation-artifacts/session-config.json` ?? `<root>/session-config.json`
  (`src/remediate/steps/nextStep.ts:1794-1797`); the wrapper seeds a *third* path,
  `.audit-tools/remediation/session-config.json` (`wrapper/remediate-code-wrapper-install-hosts.mjs:665`)

**Audit never writes any file remediate reads as intent.** The artifact is root-scoped *precisely because
of this* — its own header states the design (`src/shared/providers/sharedProviderConfirmation.ts:4-9`):
the first tool to run writes to a SHARED artifact at `<root>/.audit-tools/provider-confirmation.json` (NOT
the per-tool artifacts dir); the second reads and honors it. Both dispatch consumers key on `root`, not on
an artifacts dir — that is what makes the handoff work. **Collapsing onto the intent would silently drop the
operator's Gate-0 decision for remediate's dispatch entirely.**

This also reconciles the spec's apparent tension ("persist the DECISION as intent" vs "the cut applies to
the confirmation ARTIFACT"): **"intent" is a category — durable, auditor-independent decision — not a
filename.** The artifact is the intent-category store that spans both tools. There is no contradiction.

> **Forward track (NOT G3):** that three-path intent split is itself a *one core, two draws* smell — two
> draws of one concept with three filenames and no shared home. Logged to `docs/backlog.md`; a
> prerequisite for any future collapse, and too large to ride G3.

## The actual target

`SharedProviderConfirmation` (`src/shared/providers/sharedProviderConfirmation.ts:99`).

- **Producers (two — the first draft said "sole", wrongly):** `writeSharedProviderConfirmation` at
  `src/audit/orchestrator/intakeExecutors.ts:168` (the shared artifact) **and**
  `src/audit/orchestrator/providerConfirmation.ts:81`, which writes a *second, separate* registered audit
  bundle artifact `ProviderConfirmationResult` (`artifacts.ts:114`, `:269`, `:404-405`) that also carries
  `provider_pool: ConfirmedPoolEntry[]` and is read by the Gate-0 renderer
  (`src/audit/cli/providerConfirmationStep.ts:47-48`). **`ConfirmedPoolEntry` therefore cannot simply be
  deleted** — it has a live second home.
- **Consumers (FOUR — the first draft said two):**
  - `readConfirmedCostPositions` → `src/audit/cli/dispatch.ts:575`, `src/remediate/steps/dispatch/marshal.ts:410`
  - `readConfirmedDispatchBias` → `src/audit/cli/dispatch.ts:578`, `src/remediate/steps/dispatch/marshal.ts:416`

**`dispatch_bias` (the cost↔speed λ dial) must be carried.** The spec itself classifies λ as intent policy
(`spec:162`). Deleting or re-pointing the artifact while forgetting λ silently degrades every run to λ=0
(`sharedProviderConfirmation.ts:551` returns `0` on absent). In scope with it: `clampDispatchBias`,
`HostModelCostEntry`, `SourcePoolCostEntry`, `spec/dispatch-cost-speed-dial.md:123-128`.

## Decision-vs-reach — the classification the first draft got WRONG

`ConfirmedPoolEntry` (`src/shared/types/providerConfirmation.ts:150`):

| Field | Kind | Note |
|---|---|---|
| `capability_tier`, `self_spawn_blocked`, `model_id`, `blended_price_usd_per_mtok` | REACH | correctly classified in draft 1 |
| entry *presence* | REACH | enumerating a pool asserts "this was reachable" |
| **`excluded`** | **REACH-DERIVED — not a decision** | see below |
| **`reason`** | **REACH — leaks it verbatim** | `providerConfirmation.ts:187-191` emits `"detected on PATH but cannot self-spawn from within an active X session"` |

**The `excluded` refutation is the heart of G3.** `sharedProviderConfirmation.ts:258-264`:

```ts
const blocked = provider.selfSpawnBlocked === true;
const operatorIncluded = includeSet.has(provider.name);
const excluded = excludeSet.has(provider.name) || (blocked && !operatorIncluded);
```

`selfSpawnBlocked` ← `isSelfSpawnBlocked(probe.providerName, env)` (`providerConfirmation.ts:179`) — the
**writing auditor's `CLAUDECODE`/`CODEX` env**. So `excluded` = *operator-decision ∨ writer-env-derived
reach*. Persisting it as "the decision" reproduces the inheritance hole under a new name: auditor A (inside
Claude Code) writes `excluded: true` for `claude-code`; auditor B (a `codex` host, for whom claude-code is
perfectly spawnable) inherits A's env-derived exclusion. **The derived `excluded` must be recomputed
per-auditor, in the reading process's env, and never persisted.**

`cost_order` carries the same defect at a smaller scale: `readConfirmedCostPositions` merges
`host_model_cost_order` (`:511-519`) — the host's self-reported roster, which the spec's own cut classifies
as per-auditor capability (`spec:163-166`).

**The clean decision half already exists as a type.** `ProviderConfirmationInput`
(`src/shared/types/providerConfirmation.ts:65-93`) — `{cost_order?, exclude?, include?, host_models?,
dispatch_bias?}` — is the operator's explicit input, reach-free by construction. **That is the
`DispatchPolicy`.** G3 persists *it*, not the derived pool. (`host_models` is the exception — it is a
capability claim; it stays out of the persisted policy and rides the descriptor.)

## Roster-staleness must stay per-read (the gate does NOT subsume it)

Draft 1 claimed the reconciliation gate replaces the roster-staleness `confirmed | reconfirm` machinery.
**It does not.** `readSharedProviderConfirmation:475-486` re-derives `currentProviderRoster` from live
`discoverProviders` **on every dispatch read, in whichever process is reading**, degrading to an empty map
/ λ=0 on mismatch (`:505`, `:551`). The proposed gate is a one-shot *interactive audit* step
(`nextStepCommand.ts:875`, `intakeExecutors.ts:117`) — **remediate has no Gate-0 obligation at all.** Under
draft 1, a remediate process starting later on a different env would apply audit's `cost_order` with no
freshness check whatsoever. That is a strict loss of a cheap, tool-enforced, auditor-agnostic property.

**Keep per-read staleness. The gate is additive, not a replacement.** Per-read staleness is the mechanical
backstop (works for any host, both tools); the gate is the operator-facing reconciliation on top.

## Keyspaces — FOUR implementations, three tails; the load-bearing one is `provider/model`

| Site | Expression | Tail |
|---|---|---|
| `src/shared/providers/auditorSources.ts:90` `sourceId()` | `id ?? \`${provider}:${model ?? endpoint ?? "?"}\`` | `"?"` |
| `src/shared/providers/providerConfirmation.ts:290` `dispatchSourceKey()` | same | `"default"` |
| `src/shared/providers/providerConfirmation.ts:523` | same, inlined a third time | `"default"` |
| **`src/shared/quota/apiPool.ts:26-29` `dispatchableSourceId()` → `buildProviderModelKey` (`src/shared/quota/scheduler.ts:802-809`)** | **`provider[#account]/model`, `provider/*` tail** | **`*`** |

**The `apiPool.ts:22` doc comment claiming `${provider}:${model ?? endpoint}` is itself stale** — the
implementation below it emits a slash-separated, `#account`-scoped key. This fourth one is the **CapacityPool
id and the key learned quota is recorded under** — i.e. the grammar that actually gates dispatch. Any
"extract one helper" that re-points only the three `provider:model` sites leaves the real divergence
untouched while *claiming* the grammar is pinned.

**The `"?"` vs `"default"` drift is NOT a live bug** (draft 1 overclaimed it as one): `sourceId()` keys only
`DroppedSource.id` for *unverified* sources (`auditorSources.ts:266`), `dispatchSourceKey()` keys *verified*
ones — `resolveAmbientSources:264-268` buckets each source into exactly one, so the tails can never be
compared. Both tails only materialize when `model` *and* `endpoint` are absent, which `verifySourceReach:176`
makes impossible for an admitted `openai-compatible` source. Cosmetic cleanup — do it, don't sell it.

`source::` (`providerConfirmation.ts:301`) is a **namespace prefix, not the grammar** — it guards
`resolveFinalCostOrder`'s keyspace against collisions between provider-NAME keys, host `model_id` keys, and
source ids. Operator-facing `cost_order` keys are un-prefixed, so **G3's exclusions land in that same flat
operator keyspace and need the same prefixing discipline.**

## The filter seam

`resolveSessionConfig` (`src/shared/config/resolveSessionConfig.ts:78`). Fresh reach enters at **`:104`**:

```ts
const sources = descriptor.sources ?? resolveAmbientSources(options).sources;
```

Policy applies as a **set-difference** here, before the `sources.length > 0` assignment (`:105`). Never a
union. Three traps:

1. **`descriptor == null` short-circuits at `:87`** before any ambient read. Policy must NOT resurrect a
   pool there — that fail-closed-to-driver-self-only is G2's deliberate behavior.
2. **The explicit `descriptor.sources` escape hatch bypasses ambient resolution.** Policy still filters it:
   an exclusion is a *decision*; the hatch exists to force *reach*, not to override the operator's own call.
   (`ResolvedSourceSet` already keeps the two concepts separate.)
3. **`resolveAmbientSources` returns `{sources, dropped}` (`auditorSources.ts:33-39`) and
   `resolveSessionConfig` discards `dropped`.** The gate needs it — thread it out.

## The reconciliation gate

`autonomous_mode` (`sessionConfig.ts:579`) is **remediate-only**: sole reader `resolveAutonomousMode`
(`src/remediate/steps/nextStep.ts:201-209`, order config → `REMEDIATE_AUTONOMOUS` → `false`), sole call site
`:3083`. Audit reads it nowhere. Gate-0 lives in audit.

Per *one core, two draws*: **lift `resolveAutonomousMode` into the shared core**, don't fork an audit peer.
Its env var is `REMEDIATE_*`-named → rename outright (*ideal code over compatibility*; single user, no
back-compat read-fallback).

**Mirror, don't invent:** the canonical interactive obligation is the `provider_confirmation` step itself
(`nextStepCommand.ts:875`) — `writeCurrentStep({stepKind, status:"ready", allowedCommands, stopCondition,
artifactPaths, prompt})`, operator writes an input JSON, re-run folds it. G3's reconciliation is a **second
lap of that same gate**, not a new step shape.

- **attended** → prompt the delta only (subset of the confirmed set → silent).
- **autonomous** → fail-closed-exclude the newly-reachable backend + a `newly_reachable_backend` friction
  event via `captureFrictionEvent` (`src/shared/friction/captureFrictionEvent.ts:74`; precedent
  `emitBlindDispatchFrictionIfBlind`, `src/shared/friction/blindDispatchFriction.ts:17`).

## Write boundary — a non-issue, with an exact precedent

`mutateSessionConfigLocked` (`src/audit/supervisor/sessionConfig.ts:58-66`) is a sanctioned
read→merge→validate→write under one held lock via `createLockedJsonStore`. `persistAnalyzerSettings`
(`:122-130`) is an **exact precedent**: a conversation-first step durably persisting operator decisions into
`session-config.json`. Operator hand-edits survive (`{ ...base, … }` merge under lock). No clobber hazard.

## Validator asymmetry (easy to get backwards)

`DISPATCH_INVENTORY_FIELDS` (`sessionConfig.ts:637-650`, 12 entries) is a **reject** list —
`validateRepoSessionIntent` (`validation/sessionConfig.ts:721-744`) errors on any member's presence plus
`dispatch.rolling_engine`. Any kept policy field is the opposite: it needs a **positive shape validator**
and must **not** join that list.

## Ordered steps

1. **Delete the inert slot** — `confirmed_provider_pool`, `ConfirmedProviderPoolRef`, the stale comment
   (`providerConfirmation.ts:243`), the two type-only tests; plus the tested-but-unwired `ConfirmedProviderPool`
   / `applyProviderConfirmationSelections` + their `index.ts` exports (knip gate).
2. **Extract the key helper** once (shared), re-point the three `provider:model` sites, reconcile the
   cosmetic tail. **Reconcile against `buildProviderModelKey` as the load-bearing grammar**, and fix the
   stale `apiPool.ts:22` doc comment. Guard test.
3. **Slim the artifact to decision-only.** `SharedProviderConfirmation` carries the operator's explicit
   policy (`exclude` / `include` / `cost_order` / `dispatch_bias`) — shape-aligned with the already-clean
   `ProviderConfirmationInput`. Reach fields (`capability_tier`, `self_spawn_blocked`, `model_id`,
   `blended_price_usd_per_mtok`, `reason`, and the derived `excluded`) leave the persisted shape.
   `ConfirmedPoolEntry` survives for the *bundle* artifact (`ProviderConfirmationResult`) + the Gate-0
   renderer — that one is a per-run audit artifact, not a cross-tool inheritance channel.
4. **Recompute `excluded` per-read** from `policy ∩ this process's reach` — `isSelfSpawnBlocked` evaluated
   in the READING process's env. Keep per-read roster-staleness intact.
5. **Filter at `resolveSessionConfig.ts:104`** (set-difference; thread `dropped`); honor the `:87`
   fail-closed.
6. **Lift `resolveAutonomousMode`** to shared; add the reconciliation gate mirroring `provider_confirmation`;
   friction event on the autonomous branch.

Each step independently green. Step 3 is the atomic replace (new decision-only shape + reach deletion in one
commit); step 4 must land **with** it, since recompute is what makes the slimmed shape sufficient.

## Loop-core

**Attestation required.** `LOOP_CORE_PATTERNS` (`src/shared/loopCorePaths.ts:27-48`) hits:
`src/audit/orchestrator/` (:37), `src/shared/dispatch/` (:43), `src/audit/cli/dispatch.ts` (:32),
`src/remediate/steps/dispatch/` (:40), `src/remediate/steps/nextStep.ts` (:41), **and `src/shared/quota/`
(:45)** — which draft 1 omitted while its own table named `apiPool.ts`.
Free (verified non-matching): `src/shared/types/`, `/validation/`, `/config/`, `/providers/`, `/friction/`.

## Also in scope (draft 1 missed these entirely)

`docs/audit-pkg/operator-guide.md:205-256` (documents the artifact + input contract);
`spec/cost-first-routing.md:87-95`; `spec/dispatch-cost-speed-dial.md:123-128`;
`tests/shared/provider-confirmation-cost.test.mjs` (~10 write/read round-trip tests);
`tests/shared/provider-self-spawn-exclusion.test.mjs` (5 tests on the reach-derived `excluded` — these
encode the behavior step 4 changes, so they are the red-green pivot);
`src/shared/index.ts:1400-1401` export surface (knip gate).
