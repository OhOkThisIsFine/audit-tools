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
2. **A4 cleanup** (independent of the engine work, can go next): delete dead `TestSpec`; formalize
   `RemediationItem`; fold the `VerificationResult`/`TriageBatch` transients; single-source the
   disposition vocab. One atomic rename+delete.
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

- Recon complete (this doc). Decomposition step 1 (shared scan) **landed**.
- **Next:** decomposition step 2 (A4 cleanup — self-contained) or step 3 (remediate engine rewire —
  the bulk; add the `advance` loop there). Either is a clean place to resume.
