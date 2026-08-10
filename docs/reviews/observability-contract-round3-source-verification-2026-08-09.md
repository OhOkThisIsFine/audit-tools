# Observability contract, round 3 — source verification of CDC-T1 / CDC-T2

Run: `dispatch-effectiveness-observability`, parked at the round-3 repair of `finalized_module_contracts`.
Method: 5 parallel source-verification lanes + 3 adversarial lanes, every load-bearing claim re-read at
HEAD `82e6b7f1`. Claims below are VERIFIED (read on disk) unless marked otherwise.

**Outcome: the repair as framed cannot be completed honestly.** Both candidate resolutions are refuted on
source, a better design exists, and it does not fit the current module scopes or phase cut. The blocker is
one level up from the artifact this step rewrites.

## 1. The critique's two blocking concerns, judged

**CDC-T1 (the stamp has nowhere to live) — upheld in substance, wrong in remedy.**
`FindingSchema` (`src/shared/types/finding.ts:102-168`) ends at `analyzer_provenance` with no attribution
field, and none of the 15 files across the seven module scopes is `src/shared/types/finding.ts`. But its
proposed fix — "a module takes the Finding type into scope" — is **not expressible in this artifact**:
file_scope lives in the decomposition, and *"the finalized contracts carry interface fields, not paths"*
(`src/remediate/steps/contractPipeline.ts:2951-2953, 2978`). The only re-emit path back to the
decomposition is the pre-critic citation-grounding gate, which fires on a non-existent cited path — not on
a critique repair. Its "unimplementable" is also too strong: declared node `output_files` take priority
over module `file_scope` (`:3196-3234`, *"Declared files still win when present"*).

**CDC-T2 (no precedent for a worker-unauthorable stamp on a Finding) — FALSE on the letter, right in spirit.**
Tool-written fields on a `Finding` already exist: `grounding` is unconditionally overwritten at ingest
(`src/audit/cli/mergeAndIngestCommand.ts:632-645`), `id` is unconditionally replaced at synthesis
(`src/audit/reporting/findingIdentity.ts:64-73`), and `theme_id` is tool-assigned
(`src/audit/reporting/synthesis.ts:293-338`) **and validator-reconciled** — a forged value is refused
(`src/shared/validation/findingsReport.ts:264-275`).
The spirit survives sharper: the precedent the round-2 repair actually cited is **inverted**.
`stampLedgerKeys` is fill-if-absent (`result.identity_key ?? …`, `src/audit/orchestrator/ledger.ts:120-157`)
and `instance_id`/`identity_key`/`idempotency_key` are advertised to workers
(`schemas/audit_result.schema.json:531-549`) — a worker can author them today and the tool honours them.
Only unconditional overwrite or validator reconciliation actually enforces; fill-if-absent must not be
copied across.

## 2. Why both candidate resolutions are refuted

### (B) re-home the join — dead, three independent grounds
- **Phase inversion / cycle.** The cut places `verdict-remediate-gates` at 2 and `attribution-artifact`
  (sole producer) at 3; `attribution-artifact` already *consumes* the gates' rows, so declaring the reverse
  edge is a genuine cycle.
- **No join key at emission.** Audit ids are packet-local and collide across units by construction; global
  ids are minted downstream by `assignStableFindingIds` (`findingIdentity.ts:64-73`). Worse, the terminal id
  is not predictable pre-merge — `findingIdentityFields` anchors on `affected_files[0]`
  (`src/shared/findingIdentitySignature.ts:128`) while `mergeAffectedFiles` pushes the absorbed side's files
  and **sorts by path** (`dedupe.ts:105-116`), so a survivor re-anchors and hashes to a different id.
- **`dispositionById` is `null` on the audit draw** (`dedupe.ts:373-375`, `idDiscipline:"local"` at
  `mergeFindings.ts:120`), so there is no record of what folded into a survivor to drive a lookup.

### (A) stamp the Finding — refuted, and it creates a new hazard
- **The Finding does not cross the boundary on the default path.** `contractPipeline.ts:3203-3253`
  DISCARDS the audit `Finding` objects and synthesizes `state.plan.findings` from adversarial-DAG nodes
  (`id` from `ensureNodeId` — an LLM-authored node id or positional `CP-NNN`). The repo says so itself at
  `nextStep.ts:4094-4097`. The lean path that preserves them fires only at `riskSignal.tier === "low"`
  (`nextStep.ts:3613-3666`), and `computeIntakeRiskSignal` escalates on ≥6 affected files, any risk-subsystem
  path match, or any intent keyword, failing **closed to `high`** on zero input (`riskSignal.ts:106-149, 218-261`).
  An audit report over a real codebase is essentially never `low`. **This run is `tier: "high"`.**
  Net: `INV-ORIGIN-STAMP-TOTAL` stays green — it is asserted over ingested audit findings, which *were*
  stamped — while 100% of remediate verdict rows carry `provider/model/rank: "unknown"`. A vacuous-green
  invariant over an empty measurement.
- **It publishes a worker forgery surface.** `WorkerFindingSchema = FindingSchema.extend({...}).strict()`
  (`src/audit/contracts/workerSchemas.ts:40-50`) — `.extend()` merges the base shape, so strictness gives
  zero protection and base-only fields already propagate (`theme_id`, `blast_radius`, `evidence_grounded`,
  `analyzer_provenance` at `schemas/finding.schema.json:118,121,125,253`). Demonstrated empirically by
  running the real generator against the compiled contracts: the added fields render as legal worker output,
  and `provider` renders as `anyOf:[{const:"unknown"},{}]` — the `{}` is the `z.custom`
  `ResolvedProviderNameSchema`, which `zod-to-json-schema` cannot express, so the published constraint is
  *anything*. That schema is plumbed live as the provider decode constraint
  (`src/audit/cli/rollingAuditDispatch.ts:79-91`), and no runtime gate catches it —
  `enforceSchemaAtEmit` has **no `src/` caller**, and ingest validation is the hand-rolled `validateFinding`
  (`auditResults.ts:386-410`) with no unknown-key check.
- **Silent loss at the cross-attempt collapse site.** `upsertFindingByIdentity`'s absorb branch assigns nine
  named fields and `absorbFinding` five (`dedupe.ts:594-610, 132-144`); neither reads any other key. Since
  `mergeFindings` runs it across **every** AuditResult (`mergeFindings.ts:86-90`), a stamp survives by
  iteration order and every other attempt is dropped with no signal — while severity/confidence escalate
  from the incoming finding, producing a chimera that credits attempt A's provider for attempt B's severity.
- **Convention.** `provider`/`model`/`rank` is a run-orchestration fact typed on this tool's own backend
  roster (`ResolvedProviderName`). Putting it on the canonical language-neutral auditor→remediator contract,
  and thereby into the worker-facing schema, couples the finding shape to the provider list — against
  *everything-agnostic by default*.

**Ruled out separately:** having the audit draw emit the remediate stages is mechanically forbidden —
`STAGE_OWNERSHIP` restricts `plan_review_gate`/`terminal_outcome` to `drawSet("remediate")` and
`isLegalDetail` is enforced in `FindingVerdictRowSchema`'s `superRefine`
(`attributionContract.ts:106-111, 191-221`).

## 3. The better design (C) — carrier is the AuditResult, not the Finding

1. **Stamp `AuditResult`, never `Finding`.** Add an optional tool-owned `dispatch_attribution` beside
   `token_usage` (`src/audit/types.ts:197-269`) — whose docblock is the exact precedent: the worker *cannot
   know* it, so the host populates it. Stamp at `finalizeProviderLaunchResult`
   (`src/shared/dispatch/providerLaunchFinalize.ts:319-352`), which already holds `providerName`, `packetId`
   and `poolId` at terminal completion. Unconditional overwrite, plus one `.omit()` on
   `WorkerAuditResultSchema`. Cardinality is exact — one AuditResult = one attempt.
2. **Attempt rows are a pure projection of the ledger,** not a live sink: `appendResultsToLedger` is
   append-only and no-ops on a duplicate `idempotency_key` (`ledger.ts:169-190`), so the contract's
   unique-per-`attempt_key` ROW-SET INVARIANT comes free — unlike `token-usage.jsonl` /
   `dispatch-explains.jsonl`, whose writers swallow IO errors.
3. **Audit verdict rows via object-identity bookkeeping** — thread a `Map<Finding object, Set<attempt_key>>`
   through merge/absorb, the discipline `crossLensDedupe` already documents as its conservation guarantee
   (`dedupe.ts:266-278`). Absorption becomes a **set union**, which is the correct cardinality and fixes the
   silent-loss defect. Convert to rows right after `assignStableFindingIds` (a positional 1:1 map).
   **No `FindingSchema` change at all** — so no strip, no worker advertisement, no schema regeneration.
   This dissolves CDC-T1 rather than working around it.
4. **Remediate joins only where the key is real.** `plan_review_gate` is sound on Path A —
   `runReviewApprovalGate` (`nextStep.ts:3127-3186`, called at `:3567`) operates on audit findings with
   terminal ids, and that file is already in scope. `terminal_outcome` is sound on the lean path only; on the
   full pipeline the sole surviving linkage is `obligation.source_finding_ids`, which is LLM-authored,
   many-to-many and regex-fallback-gated (`contractPipelineGates.ts:731-752`) — a lead, not a key. That
   population needs an explicit **unavailable** marker rather than the optional-field transform coercing it
   to `"unknown"`.

## 4. Why (C) still cannot be authored from this step

It requires edits to files in **no** module's file_scope — `src/audit/types.ts`,
`src/audit/contracts/workerSchemas.ts`, `src/shared/dispatch/providerLaunchFinalize.ts`,
`src/audit/reporting/findingIdentity.ts`, `src/audit/orchestrator/ledger.ts` — and it **inverts the phase
cut**: the `dedup_or_review` rows phase 0 owns cannot be materialized until the terminal id is minted in
synthesis (phase 4), while the artifact phase 3 registers must exist before phase 1 writes to it.

The root cause, stated plainly: **the module decomposition was drawn over the *contract's* vocabulary**
(triple, attempt row, verdict row, artifact, render) **rather than over the codebase's actual seams**
(dispatcher → ledger → merge → re-key → report → intake gate). That is why every candidate lands one file
short, and why CDC-R2's "the join must be OWNED by some module" is not satisfiable by re-labelling. It needs
a re-scope and a re-cut, which `finalized_module_contracts` cannot express.

## 5. Corrections to carry forward

- `tests/shared/shared-core-invariants.test.ts:83-104` does **NOT** go red for an added *optional* field —
  its three walks are `schemaRequired ⊆ baseKeys`, `schemaProperties ⊆ baseKeys`, `baseRequired ⊆
  schemaProperties`, none of which an optional field disturbs. Only
  `tests/audit/worker-schema-generation.test.ts:27-37` goes red. (One lane asserted both; verified false.)
- `attempt_key` has **no run component** — `buildAttemptKey` hashes {sorted packet task ids, `bound_pool_id`,
  `result_content_discriminator`} (`src/shared/contentKey.ts:402-428`). Two runs over the same repo,
  partition and pool mint the *same* key, so a finding carried in from a prior run would collide with the
  current run's attempt rows and the ROW-SET INVARIANT's dedupe-on-write would silently fold them.
- The stamp is **not applicable at ingest at all**: `entryByTaskId` is
  `{packet_id, task_id, result_path}` (`src/audit/types/activeDispatch.ts:78-82`), the map at
  `auditResults.ts:1002` is a *different* map (`taskMap: Map<string, AuditTask>`, also attribution-free),
  and `AuditResult` has no provider/model/pool/rank field. Every statement in the current contract that
  attribution "derives from `entryByTaskId`" is false.
- `acceptReconcile.ts` reads only `RemediationItemState` (`store.ts:209-217`), which carries no `Finding`
  payload — whichever design wins, that gate needs a new `item.finding_id` → `state.plan.findings` join it
  does not perform today.
- Advisories confirmed and sharpened: **T3** an invariant phrased over `dispositionById` is *vacuous* on the
  audit draw, not merely unbound — it needs an affirmative `not_applicable` result, not an empty array;
  **T4** the cited sink is a cardinality mismatch as well as a type mismatch (an event stream where one
  packet appears many times, `dispatchDecisionLog.ts:15-17`), and stranded packets never reach `onResult`,
  so a second emission point is required; **T5** `deriveAggregates([])` is indistinguishable from
  "loaded and empty", and `RemediationOutcomesReportSchema` is non-strict so an unregistered field would
  pass validation while being unvalidated.
