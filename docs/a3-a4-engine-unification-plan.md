# A3+A4 — obligation-engine unification + canonical remediation item (working plan)

> **Working doc for an in-flight refactor** (like `a8-rolling-cutover-plan.md`). Trim as
> commits land; delete when A3+A4 ship. Durable principles graduate to `CLAUDE.md`; status
> lives in `docs/backlog.md`. **Do not turn this into a changelog.**

## Why

Two orchestrators derive "what is the highest-priority unsatisfied thing to do next" with
**different mechanisms**, so the engine vocabulary can drift between them (violates *keep
orchestrators in parity* / *genuinely shared logic → shared*). A3 single-sources the engine
*mechanism*; A4 cleans up remediate's record sprawl so the re-expressed engine reads a clean
state. Endpoint, not effort, is the metric (Ethan): one declarative engine both tools run on.

## Ground truth (recon 2026-06-17 — corrects the backlog one-liners)

**audit-code is already declarative.** `PRIORITY: string[]` (`nextStep.ts:13-31`) +
`findObligation` linear scan returning the first `missing|stale` (`nextStep.ts:33-43`).
Obligation = `{id, state, reason?}` (`types/auditState.ts:13`). Dispatch via `EXECUTOR_REGISTRY`
(`executors.ts:18`, obligation_ids→executor) then a hand switch in `advance.ts:114-319`.
Satisfaction is **artifact-staleness-driven**: `deriveAuditState` (`state.ts:34-318`) computes a
content-hash stale set over the dependency DAG (`dependencyMap.ts`, `staleness.ts`) and each
obligation maps to a hardcoded artifact-dep list via `staleOrSatisfied`. Every executor runs **one
bounded unit then returns** (host re-invokes) — i.e. audit is *emit-only*, host-looped.

**remediate is an imperative guard cascade**, NOT a linear scan. `decideNextStepLoop`
(`steps/nextStep.ts:3051-3329`) is ~280 lines of ordered guard clauses that **recurse internally**
after state transitions (e.g. planning→implementing→re-scan in one call). It has back-edges
(clarification wait, triage loop, partial-completion terminal), **multi-fire gates** (intent
checkpoint fires until confirmed), and **in-process phase executors** that mutate state
(`handlePlanning`/`handleImplementing`/`handleClosing`). Status is **persisted** in `state.json`
(`store.ts:18-27`), not re-derived from artifacts. Implicit ordered-obligation chain reverse-
engineered from the cascade: input-conflict → confirm-resume → confirm-intent → interpret-intent →
complete-redelivery → pending-intake → clarification-wait → triage-wait → planning(documentable) →
partial-terminal → implementing(eligible) → triage → planning(zero) → all-terminal → closing.

**The divergence that the shared engine must absorb:** audit = stateless staleness-scan,
emit-only, one-unit-per-call. remediate = persisted state machine, transition+emit, internally
recursive. A naive "shared linear scan" only fits audit. The unifying primitive is a scan **plus a
transition/emit advance loop** (below) that is a strict generalization of audit's emit-only loop.

**A4 is over-specced.** The "8 finding_id-keyed types + 2 ledgers → 1" framing does not survive
ground truth (`state/types.ts`):
- `RemediationItemState` (types.ts:313) **already is** the canonical hub (keyed store; nests
  `item_spec`, carries `clarification_context`/`failure_context`). It needs *formalizing*, not
  replacing.
- `TestSpec` (types.ts:119) is **dead** — zero real usages (one prose hit in a prompt). Delete.
- `VerificationResult`/`TriageBatch` (types.ts:127/133) are **thin transients** used only in
  `triage.ts` — fold into derived views / inline.
- `CoverageLedgerEntry` (types.ts:141, `plan_coverage`) tracks **never-planned drops** (folded,
  no-evidence, declined) — a *superset* of items, a different domain. Keep; reconcile shared fields.
- `RemediationOutcomeItem` (types.ts:222) is the **serialized output contract** (extends shared
  `RemediationOutcome`, deliberately self-describing because `state.json` is deleted at close).
  Keep as a close-time projection.
- The "2 ledgers" (`CoverageLedger` plan-coverage vs `PerFindingCoverageLedger` fail-closed
  completeness, types.ts:303) track **genuinely different things** (planned dispositions vs.
  terminal-coverage gate). They stay two ledgers; the win is a **shared entry/disposition
  vocabulary**, not a merge.

So A4 = formalize the hub + delete the dead type + fold two transients + single-source the
disposition vocabulary. Real, contained, lower-risk than billed. A3 is the keystone.

## Target architecture

### Shared obligation engine — `@audit-tools/shared/src/engine/obligationEngine.ts` (new)

```ts
export type ObligationState = "missing" | "stale" | "satisfied" | "blocked";

export interface Obligation<S, Ctx, Step> {
  id: string;
  derive(state: S): ObligationState;               // pure; audit reads staleness, remediate reads status+files
  reason?(state: S): string | undefined;           // optional diagnostic (audit uses it for intent clauses)
  execute(state: S, ctx: Ctx): Promise<ObligationOutcome<S, Step>>;
}

export type ObligationOutcome<S, Step> =
  | { kind: "transition"; state: S }               // mutate + re-scan (remediate's internal recursion)
  | { kind: "emit"; step: Step; state?: S };        // host-actionable; return to caller

export function findNextObligation<S, Ctx, Step>(
  priority: readonly string[],
  obligations: readonly Obligation<S, Ctx, Step>[],
  state: S,
): Obligation<S, Ctx, Step> | undefined;            // first whose derive() ∈ {missing, stale}

export async function advance<S, Ctx, Step>(
  engine: { priority: readonly string[]; obligations: readonly Obligation<S, Ctx, Step>[] },
  state: S, ctx: Ctx, opts?: { maxTransitions?: number },
): Promise<{ state: S; step: Step | null }>;         // loop on transition; stop on emit/complete; cycle-guard
```

- **audit adopts it emit-only**: every executor returns `emit` → `advance` stops after one unit
  (behaviour unchanged: one bounded unit per `next-step`, host re-invokes). `findNextObligation`
  replaces `findObligation`; `decideNextStep` stays a thin pure wrapper for its preview.
- **remediate adopts it transition+emit**: transition executors (planning→implementing) return
  `transition` → `advance` re-scans within the call (replaces `decideNextStepLoop`'s recursion);
  halt/dispatch executors return `emit`. `maxTransitions` is the cycle backstop the recursion
  lacks today.
- **derive stays orchestrator-specific** (audit = staleness DAG, remediate = persisted
  status + sidecar-file existence). The shared core owns scan + advance + the obligation/state
  vocabulary — exactly the mechanism that can drift today.

### A4 canonical item — `remediate-code/src/state/types.ts`

- Promote `RemediationItemState` → `RemediationItem` (the hub; keep the rich status enum).
- Delete `TestSpec`. Fold `VerificationResult`/`TriageBatch` into derived projections over the
  item set (they carry no state the item doesn't).
- Single-source disposition: `statusToDisposition` (`coverage/findingLedger.ts:74`) is the one
  status→disposition map; `CoverageLedgerEntry.disposition` and `PerFindingDisposition` draw from
  one vocabulary. Keep both ledgers (different denominators) and `RemediationOutcomeItem` (output
  contract) as **named projections** of the item + finding, not parallel records.

## Decomposition (atomic, green at every commit)

Adding a shared primitive that nothing consumes yet is a **pure addition** (not a destructive
change), so it is exempt from the atomic-replace rule; each *rewire* that deletes an old mechanism
is the atomic replace.

1. **✓ DONE — extract audit's proven scan into shared.** `findFirstActionableObligation` + the
   `Obligation`/`ObligationState` vocabulary now live in `@audit-tools/shared/src/engine/`;
   audit-code's `findObligation` binds `PRIORITY` to it and `AuditObligation`/`ObligationState`
   alias/re-export the shared types (atomic replace of the inline scan). Validated by audit's suite +
   7 new shared unit tests. *(Lowest risk: ship the working one, don't invent.)*
2. **✓ DONE — A4 cleanup** (`ed6ad2a` / `6283a34` / `6fea584`). Dead `VerificationResult` deleted +
   `TriageBatch` localized to `triage.ts` (`ed6ad2a`); new `state/itemStatus.ts` single-sources the
   `RemediationItem` status enum + the status→disposition→outcome mapping (`6283a34`) + every
   status-classification predicate (`6fea584`), retiring `OUTCOME_BY_STATUS`, the 3× `isSkip`, and the
   7× `resolved||resolved_no_change` open-codings. **Two resolutions vs the original framing:**
   (a) "single-source the disposition vocab" = single-source the status→vocab *mapping*, NOT merge the
   two disposition unions — `PerFindingDisposition` (terminal outcome) and `CoverageLedgerEntry.disposition`
   (planning fate) are disjoint domains and stay separate (ground truth corrected the plan's ambiguous
   "draw from one vocabulary"). (b) Scope was broader than the one-liner: status classification was
   scattered across 5 files (findingLedger/close/nextStep/dispatch/stepUtils), so the authority owns the
   predicates too. The `RemediationItemState`→`RemediationItem` rename stays skipped (name is accurate; the
   extracted status enum is the formalization). The four predicates provably partition the enum (coherence
   test). One remaining minor drift point: `RemediationOutcomeStatus`'s `OUTCOME_KEYS` re-list in shared —
   deferred to A6 (it's the shared outcomes contract, needs a shared const-tuple).
3. **Rewire remediate onto the shared engine** — the multi-session bulk. The `advance`
   transition/emit loop is **designed and added to the shared engine as part of THIS step**, so the
   richer API is proven by its real consumer (remediate) rather than built consumer-less. Then
   re-express `decideNextStepLoop`'s guard cascade as a declarative obligation list (`derive` +
   `execute`) running on `advance`, in coherent atomic chunks (linear pre-intake gates first, then
   the implementing/triage back-edge cluster), green at each.
4. **Reconcile + delete** any now-dead remediate scaffolding; parity-check audit vs remediate
   obligation shapes; update memory/backlog.

## Open decisions (resolve toward the cleaner contract; none blocking)

- **`Ctx` shape**: audit passes `{root, options}`; remediate passes the store + dispatch deps. Use
  a per-orchestrator `Ctx` generic (engine stays agnostic) rather than a union.
- **Keep `decideNextStep` as a pure preview?** Audit exposes it for next-step prediction; remediate
  folds it into the loop. Keep a pure `findNextObligation`-based preview in both for symmetry.
- **A4 rename churn**: `RemediationItemState`→`RemediationItem` touches ~10 files (plan/document/
  implement/triage/close/dispatch/nextStep/store/findingLedger). Worth it for the canonical name;
  do as one mechanical atomic commit.

## Status

- Recon complete (this doc). Decomposition steps 1 (shared scan) + 2 (A4 cleanup) **landed**.
- **Step 3a DONE** (`8250aab`): the `advance` transition/emit loop + function-based `ObligationDef<S,Ctx,Step>`
  (`derive`+`execute`) + `findNextObligation` are in the shared engine. `advance` is a strict generalization
  of the bare scan (emit-only ⇒ one bounded unit; `transition` ⇒ in-call re-scan) with a `maxTransitions`
  cycle backstop. 10 unit tests pin the mechanics. Pure addition; remediate adopts it next (the real consumer).
- **Step 3 DONE — remediate engine rewire (the multi-session bulk).** Staged as a *strangler* across slices 1
  → 2a → 2b, green at each commit (the vitest suite was the equivalence oracle). `decideNextStepLoop` is now
  preamble → `advance(pre-intake)` → `countStep` → `advance(main)`, and EVERY guard + phase handler runs as a
  declarative `ObligationDef` returning `transition`/`emit` — zero recursion. The two-`advance` split places
  `countStep` at the exact original count point (after intake resolves, before main dispatch).
- **Slice 1 DONE** (`79e2dcd`): the linear pre-intake gates run through `advance`; the inline tail
  (from `waiting_for_clarification`) is unchanged. 1667→1669 (+2 teeth-verified regression tests), green.
  Two faithfulness subtleties the naive translation gets wrong (both fixed + regression-locked):
  1. **Entry-gate freeze.** `input_conflict`/`confirm_resume` are about a *pre-existing* run, so they derive
     from the frozen call-entry state — NOT the threaded state. The original cascade evaluated them once
     before intake and never re-checked; `advance` re-scans after `pending_intake` builds a planning state
     from a promoted extracted-plan, and a threaded-state derive would *resurrect* these gates against that
     fresh state (wrongly bouncing a dispatchable run to a resume/conflict prompt). The
     derive/execute split makes the bug loud: the executor's `requireState(entryState)` throws when a
     threaded-state derive selects the gate for a fresh (entryState===null) run.
  2. **Cascade-ordered side effects.** The leftover-`remediation-report.md` warning is not a preamble — the
     cascade only reaches it when no earlier gate emitted. It is an `ObligationDef` slotted between
     `complete_redelivery` and `complete` (a one-shot `transition` gated by a closure `warned` flag), so
     `advance`'s priority scan reproduces the exact "fires only on fall-through" semantics; an unconditional
     preamble would over-fire.

### Step 3 — execution design (trim as slices land)

**Engine binding for remediate:** `S = RemediationState | null` (the live persisted state; null pre-intake).
`Ctx = { root, artifactsDir, options, runLogger, store, inputResolution, countStep }`. Obligations are built
per call (`buildPreIntakeObligations(ctx, existingCheckpoint)`) so each `derive` closes over `ctx` paths +
the once-async-read `existingCheckpoint` and reads **sync** signals (`existsSync`, `state.status`,
`inputResolution.supplied`). Anything needing an async read (the checkpoint JSON) is pre-read into a snapshot
before `advance` and is call-stable (no transition rewrites it mid-call).

**Slice 1 = the linear pre-intake gates** (cascade order preserved in the priority list):
`input_conflict` (emit) → `confirm_resume` (emit; satisfied when `ack.choice==='resume'`) → `confirm_intent`
(emit) → `interpret_intent` (transition: writes the interpretation sidecar, state unchanged → re-scan skips it
once the sidecar exists) → `complete_redelivery` (emit) → `complete` (emit) → `pending_intake` (returns
step⇒emit / new state⇒transition / null⇒emit `handleNoState`, folding the old no-state branch in). Preambles
kept inline *before* `advance`: `forceReplan` (one-shot, `!skipCount`) and the leftover-report stderr warning
(diagnostic, not a gate). The inline tail (from `waiting_for_clarification` down) is unchanged.

**Count semantics:** `step_count` is incremented once per host call by a shared `countStep(state)` closure
(guarded by a `counted` flag seeded from `skipCount`); the pre-intake emit executors call it where the cascade
did, and the inline tail reuses the *same* closure, so it can never double-count. `step_count` is not embedded
in the emitted step, so count-vs-build ordering is unobservable.

**Re-entry safety:** `decideNextStepLoop` recurses (skipCount=true) from sites that re-enter the top; on
re-entry every pre-intake gate is already satisfied so `advance` falls straight through, and `countStep`
no-ops (counted seeded true). The handler recursion that remains after 2a re-enters `advance` soundly.

- **Slice 2a DONE** (`ae0326c`): the post-intake cascade tail is a declarative `buildMainObligations` list on
  a *second* `advance` call (`MAIN_PRIORITY`). The three **tail** recursion sites became `transition`
  outcomes: clarification-resolution apply, triage-resolution apply, the implementing dead-end block. The
  `unhandled` catch-all is the always-actionable lowest-priority slot. 1669 / 1 skip, green. **Deliberate
  intermediate:** the phase handlers still `return decideNextStepLoop(...true)` — that recursion now re-enters
  `advance` (each nested call has its own budget + reloads state), which is sound but not the endpoint.

- **Slice 2b DONE** (`719e276` core + `838a0ae` cleanup): every phase handler now returns a `RemediateOutcome`
  (`transition` | `emit`); `advance` drives every fold with ZERO recursion. `handlePlanning` (→ implementing,
  transition; review-halt + integrity steps emit), `handleImplementing` (→ triaged, transition),
  `handleAllTerminalTransition` (→ closing / reattempt-implementing, transition), `handleClosing`, and
  `buildImplementDispatchStep` converted. `skipCount` + the `counted`-seed + the `forceReplan !skipCount`
  guard dropped (the public entry was the only remaining caller); the now-dead `options`/`runLogger` handler
  params + a dead `changed` flag dropped in cleanup. 1669 → **1671** (+2 teeth tests), green.
  - **Boundary case 1 (`handleClosing` → `complete`) resolved by emit, not transition.** `complete` is a
    pre-intake obligation, unreachable from a main transition. On `closed.status==='complete'` it emits
    `handleComplete(root, artifactsDir, await store.loadState())` — the reload reproduces the original
    recursion EXACTLY: a fully-green close deletes the artifact dir (reload → `null` → `randomRunId`), a
    not-green close preserves it (reload → the saved complete state → its `plan_id`). Both sub-cases are
    teeth-locked in `next-step-implement-dispatch.test.ts` (run_id pins the reload; passing always-null /
    always-closed, or transitioning into `unhandled_state`, each fail one).
  - **Boundary case 2 (`buildImplementDispatchStep`):** the 3 merge-then-reenter sites reload the post-merge
    state and `transition`; the 3 `writeCurrentStep` paths `emit`. (`store` threaded into its ctx for the reload.)
  - **Boundary case 3 (`forceReplan` + count):** the two-`advance` split is unchanged, so `countStep`
    placement is identical; `step_count`-increments-once is regression-pinned by the existing fold test.
  - **Faithfulness finding (not a regression — a fix).** Removing the recursion removed a slice-2a artifact:
    `handlePlanning`'s `return decideNextStepLoop(...true)` re-ran the WHOLE pre-intake pass, which re-fired
    `confirm_resume` against the freshly-built `implementing` state (no resume-ack). The single-`advance`
    fold evaluates the entry gates once against the frozen call-entry state — restoring the slice-1
    entry-gate-freeze semantics that the residual recursion had been circumventing. `confirm_resume` still
    fires for a genuinely pre-existing in-progress run (entryState non-null at call entry). Only one test
    relied on the spurious halt (`next-step-review-gate` Path-A coverage, which never asserted the step kind);
    it now folds to the implement dispatch under a non-dispatching host (asserted as the no-refire teeth).

**Remaining = step 4 (final reconcile), small.** skipCount + dead params already dropped (above). Left: a
quick orphaned-helper sweep; **parity-check audit vs remediate obligation shapes**; and the optional-but-ideal
symmetry of **audit-code adopting `advance` emit-only** (it is already on the shared `findFirstActionableObligation`
scan — `advance` with only-emit obligations is a strict generalization, so this unifies the *mechanism* fully and
completes the A3 north star "one declarative engine both tools run on"). After step 4, A3 is done → B2+B3.

## A3 step 4 — parity check (the deliverable)

> Done this session. Orphaned-helper sweep landed (`33f568f`). This section is the
> **parity-check of audit vs remediate obligation shapes** + the resulting decision on the
> "audit adopts `advance`" symmetry. Recon dates 2026-06-17 against HEAD.

### The two engines, side by side

| Axis | audit-code (`src/orchestrator/`) | remediate-code (`src/steps/nextStep.ts`) |
|---|---|---|
| Obligation type | `AuditObligation` = shared **`Obligation`** *value* `{id, state, reason?}` (state precomputed) | `RemediateObligation` = shared **`ObligationDef`** *function* `{id, derive, execute}` |
| Where `derive` lives | **Holistic + external**: `deriveAuditState(bundle)` computes EVERY obligation's state in one content-hash DAG pass (`state.ts`), via `staleOrSatisfied` over the dependency map | **Per-obligation closures** built per call; each `derive(state)` reads `state.status` + `existsSync(sidecar)` + frozen entry snapshot |
| `ObligationState` range used | `missing` / `stale` / `satisfied` (genuine `stale` via the staleness DAG) | `missing` / `satisfied` only (binary; no `stale`/`present`/`blocked`) |
| Selection | shared `findFirstActionableObligation(PRIORITY, obligations)` (**bare scan**) | shared **`advance`** (scan + transition/emit loop), run twice (pre-intake, main) |
| Dispatch shape | **Two-level, N:1**: obligation → `EXECUTOR_REGISTRY` (`obligation_ids` map) → executor_id → hand `switch` in `advanceAudit` | **One-level, 1:1**: obligation `execute` *is* the work; no separate executor catalog |
| Transitions | **None** — emit-only, exactly one bounded unit per host call (host re-invokes) | `transition` (re-scan in-call) + `emit`; folds planning→implementing→… in one call |
| Host-delegation marker | executor-level `kind: deterministic\|host_delegation` (consumed by `isHostDelegationExecutor` → CLI pauses for the LLM) | encoded in the emitted *step kind* (a wait/dispatch step); no obligation-level `kind` |
| Out-of-band dispatch | `preferredExecutor` forces a specific **executor** (3 CLI sites), bypassing the scan | none — every path goes through obligation selection |

### Which differences are drift vs legitimate

- **Shared already (the real anti-drift win):** the *vocabulary* (`Obligation`/`ObligationState`)
  and the *ordered selection* (`findFirstActionableObligation`) are single-sourced. This is the
  thing that could silently drift between two hand-rolled scans — and it cannot anymore. A3's
  core ("one engine owns selection + the obligation vocabulary, both tools bind to it") **is met.**
- **Legitimate domain differences, NOT drift:** transitions (remediate is a persisted state machine
  that folds; audit is a stateless staleness-scan that emits one unit), holistic-vs-incremental
  `derive` (audit's DAG hash is one pass by construction), and the N:1 executor layer with
  `kind` + `preferredExecutor` (audit's work-unit genuinely is an *executor* addressable
  independently of any single obligation; remediate's is the obligation itself). These reflect the
  two halves' real shapes, established in the ground-truth recon at the top of this doc.

### The decisive finding: audit ALREADY folds — `runDeterministicForNextStep` is a hand-rolled `advance`

An earlier draft of this section recommended **B** (fold the `switch` into the registry; *don't*
call `advance`) on the premise that "audit is emit-only, no transitions, so `advance`'s loop would
run exactly once = ceremony." **That premise was false.** `runDeterministicForNextStep`
(`src/cli/nextStepHelpers.ts:590`) is audit's real driver, and it is a fold loop:

```
for (index < maxRuns):                       // the fold loop
  decideNextStep (scan) → one executor via advanceAudit
  deterministic executor      → continue     // keep folding  == transition
  host-delegation / dispatch  → return X     // stop, hand to host == emit
  guards: maxRuns + checkNoProgressBeforeDispatch + checkFinalizationCycle
```

It reloads + persists the bundle each iteration (`:619`) and folds the entire deterministic chain
(intake → structure → graph → design-assessment → planning → …) into **one** host round-trip,
stopping only at real host work. That is structurally a **hand-rolled `advance`**: `continue` ≡
`transition`, `return X` ≡ `emit`, `maxRuns` ≡ `maxTransitions`. The round-trip-avoidance fold that
birthed `advance` for remediate is present in audit too — implemented a *second time*, by hand, with
its own bespoke cycle guards. **That parallel fold mechanism is the genuine non-parity** A3 exists to
erase. (`runDeterministicForNextStep` runs on *every* `next-step`; it is the driver, not a fallback.)

### Decision: C — unify audit's fold onto `advance` (B is its first sub-step)

Replace `runDeterministicForNextStep`'s loop + `checkNoProgressBeforeDispatch` +
`checkFinalizationCycle` + `maxRuns` with the shared `advance`. Audit obligations become
`ObligationDef`s: **deterministic executors return `transition`** (fold), **host-delegation / dispatch
/ terminal return `emit`** (hand to host). One fold mechanism, one cycle-guard model, both tools on
the same engine — the A3 north star, properly reached.

- The three earlier objections to C dissolve once you see the loop already exists: (1) "the loop never
  iterates" was wrong — it iterates the whole deterministic chain today. (2) executor `kind` need not
  live on the shared `ObligationDef`: it's just "deterministic ⇒ `transition`, host-delegation ⇒
  `emit`" — encoded in each obligation's own `execute`, no shared-contract field. (3) the
  `preferredExecutor` forced path becomes a **preamble** before `advance` (exactly like remediate's
  `forceReplan`), not a parallel dispatch mechanism.
- **B is folded in as the first sub-step**, not discarded: co-locating each executor's dispatch (the
  `switch` arm) so the obligation `execute` closures are trivial *is* part of getting onto `advance`,
  and it still kills the `switch` + the `executor-registry-sync` invariant + the dead `description`.

### Cycle-guard resolution (the design question) — DONE, slice 1

Audit's guards are richer than `advance`'s blunt `maxTransitions` throw: they detect *no-net-progress*
(an executor that ran but left artifacts unchanged) and *finalization thrashing* (a return to an
already-seen artifact state), and surface a **graceful terminal** naming the cycling obligations.

**Resolution: visited-state-signature cycle detection** — the precise primitive `maxTransitions` only
approximated. `advance` gained an optional `opts.stateSignature(state) => string`; it records the
signature of every state it scans from, and a transition landing on an already-seen signature stops
the loop with a discriminated `stopped: "cycle"` (not a throw), so the caller renders the terminal.
This single primitive **subsumes both audit guards** (no-progress = the signature didn't change →
immediate revisit; finalization-cycle = a later revisit) and is *general* (remediate's blunt
`maxTransitions` is strictly improved by it), so it belongs in shared, not as an audit special-case.
It handles audit's **non-monotonic** deepening correctly (each round is a new signature → keep
folding; converge → natural completion; genuine thrash → revisit → stop). `maxTransitions` remains the
absolute backstop when no signature is supplied (remediate, for now). Landed in
`@audit-tools/shared/src/engine/obligationEngine.ts` + 5 unit tests; pure addition, remediate
untouched (the return type went `{state,step}` → `{state,step,stopped?}`, a superset).

### C decomposition (slices, green at each — mirrors remediate's 1→2a→2b)

1. **✓ DONE — shared engine: visited-state-signature cycle detection** (this session). The
   `stateSignature` option + `AdvanceResult.stopped` + the visited-set loop. Consumer-less pure
   addition (exempt from atomic-replace).
2. **✓ DONE — Slice 2a — fold the `switch` into executor runners (B).** New `executorRunners.ts`
   holds `EXECUTOR_RUNNERS: Record<id, (bundle, ctx) => Promise<ExecutorRunResult>>`; `advanceAudit`
   dispatches via it, and the **absence** of a runner is the single source of "not deterministically
   dispatchable" (the no-progress handoff for `agent` / `rolling_dispatch_executor`). The hand `switch`
   is gone and the switch⇄registry invariant test now asserts **runner-map** coverage instead.
   `AdvanceAuditOptions` / `AdvanceAuditResult` moved to a leaf `advanceTypes.ts` so the runners can type
   their ctx without a back-import (madge cycle guard, ARC-1fa005bb). `runDeterministicForNextStep`
   unchanged. Full audit suite 2193 pass / 1 skip. *(The dead `description` field on the registry is
   retained for now — it is human-readable executor documentation, not behavioural dead code; decide
   keep-as-docs vs delete in 2c.)*
3. **Slice 2b — `advance` drives the deterministic fold.** Audit `ObligationDef`s (`derive` = lookup
   into `deriveAuditState`'s precomputed obligation states; `execute` = run the executor → `transition`
   for deterministic, `emit` for host-delegation/dispatch/terminal). Replace
   `runDeterministicForNextStep`'s for-loop with `advance` + `stateSignature` (lift audit's existing
   state-signature). Retire `checkNoProgressBeforeDispatch` + `checkFinalizationCycle` + `maxRuns`;
   `preferredExecutor`/integrity-check become a preamble. The typed host-step branches
   (`handleGraphEnrichmentBranch` / `handleDesignReviewBranch` / `handleSynthesisNarrativeBranch` /
   `ensureSemanticReviewRun`) move into the obligations' `emit` payloads. Atomic replace: hand-loop →
   `advance`.
4. **Slice 2c — reconcile + clean.** Retire any now-dead CLI helpers; final parity-check; update
   memory/backlog. After this, both tools run the *same* fold engine and A3 is done.
