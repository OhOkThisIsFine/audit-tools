# Glossary — opaque identifier families

This is the lookup table for opaque identifiers that still occur in src/**/*.ts. The source tree is
the authority: when the final occurrence of an identifier or family is deleted, its glossary entry
is deleted too.

## Families

| Family | Shape | Meaning |
|---|---|---|
| INV- | INV-AREA-N | A named correctness invariant owned by the cited subsystem. |
| CE- | CE-NNN | A counterexample or failure case local to the file or design that cites it. CE numbers are not globally unique. |
| N- | N-PHASE-N | A historical plan node still used as a source-code cross-reference. |
| ARC-, COR-, DAT-, MNT-, OBS-, REL-, TST- | `<LENS>-<hash>` | A finding id: lens prefix plus a stable content-derived suffix. |
| FND- | FND-LENS-hash | A source comment citing a prior audit finding; it is not a remediation id. |

## Live invariant namespaces

| Namespace | Contract | Live owner |
|---|---|---|
| INV-B3 | Repository-path grounding, including dotfile paths and unambiguous basename resolution. | `src/shared/validation/findingGrounding.ts`; `src/remediate/phases/grounding.ts` |
| INV-CC | Idempotent, sole-writer intent guidance bootstrap. | `src/shared/intake/guidanceBootstrap.ts` |
| INV-CDI-EXPLICIT-NODE-FIELDS | A charter delta carries its subsystem identity as explicit `node_id`/`goal_node_id` fields rather than encoded inside `delta_id`, so `delta_id` stays an opaque identity no consumer needs to parse. | `src/shared/decompose/charterExtraction.ts` |
| INV-CK | Deterministic identity, idempotency, and content keys. | `src/shared/contentKey.ts`; `src/shared/stableStringify.ts` |
| INV-CO | Contract-pipeline obligation and reconciliation derivation. | `src/remediate/validation/contractPipelineGates.ts` |
| INV-CPGV-OUTCOME-RECORD-OWNER | The cross-artifact gate-outcome record (`evaluated`/`reason`) is owned by `src/remediate/validation/contractPipelineGates.ts` until a later work item relocates its shared shape into `audit-tools/shared`. | `src/remediate/validation/contractPipelineGates.ts` |
| INV-CVG | Fail-closed contract validation and scoped positive/negative coverage. | `src/remediate/validation/contractPipelineGates.ts` |
| INV-DA | Analyzer deletion signals remain advisory and never authorize unattended deletion. | `src/remediate/review/autonomousGate.ts` |
| INV-GND | Missing grounding evidence is treated as ungrounded. | `src/shared/validation/findingGrounding.ts` |
| INV-ID | Idempotent, content-hash-keyed remediation intake. | `src/remediate/intake.ts` |
| INV-IR | Item-scoped contract revalidation, empty-delta copy-forward, and semantic-hash reconvergence. | `src/remediate/contractPipeline/derive.ts`; `src/remediate/contractPipeline/artifactStore.ts` |
| INV-ISC | Every `RemediationItemStatus` belongs to exactly one classification under an exhaustive `Record<RemediationItemStatus, boolean>` for each partition axis (in-progress/terminal/skip/unsuccessful-end), so a new status is a compile error at every unhandled axis rather than a silently-permissive membership test. | `src/remediate/state/itemStatus.ts` |
| INV-ISC-CLOSE-PHASE-PRECONDITION | The close phase force-closes `blocked`/`needs_clarification` items to `abandoned` so a run can end without livelocking or rendering a non-terminal item as a partial completion. | `src/remediate/state/itemStatus.ts` |
| INV-ISC-EVIDENCE-EMITTED | A `verified_already_fixed`/`refuted` terminal disposition requires a complete verification-evidence triple (method, mechanism, and confirmation) before the writer may emit it; incomplete or mechanism-contradicting evidence is refused to a non-terminal `blocked` outcome instead. | `src/shared/types/remediationOutcome.ts`; `src/remediate/phases/close.ts`; `src/remediate/state/itemStatus.ts` |
| INV-O1 | Best-effort, deduplicated, lock-safe friction capture at workflow step boundaries. | `src/shared/friction/captureFrictionEvent.ts`; `src/shared/friction/stepBoundaryCapture.ts` |
| INV-O2 | Immutable audit-result ledger records plus versioned intent/result baselines. | `src/audit/orchestrator/ledger.ts`; `src/audit/orchestrator/resultBaseline.ts`; `src/audit/orchestrator/intentCheckpointGate.ts`; `src/audit/types/artifactMetadata.ts` |
| INV-PENDING-SINGLE-SOURCE | One pending-task partition feeds both audit workload emission and completion state. | `src/audit/orchestrator/pendingTasks.ts`; `src/audit/orchestrator/state.ts` |
| INV-PHASE | Lower remediation phases complete before higher phases become ready. | `src/remediate/steps/nextStep.ts` |
| INV-PLAN-FROZEN-ESTIMATES | Planned audit tasks persist provider-neutral token and risk estimates. | `src/audit/orchestrator/planningExecutors.ts` |
| INV-PLAN-PERSIST-COMPLETE | Audit planning persists the complete merged task set used by later workload emission. | `src/audit/orchestrator/planningExecutors.ts` |
| INV-RCI | The generated OpenCode permission ceiling is the deterministic union of agent rules. | `src/shared/opencodePermissions.ts` |
| INV-READY-STEP-CONTINUATION | A ready audit step that requests another advance carries the executable continuation command. | `src/audit/cli/nextStepCommand.ts` |
| INV-RPS | Remediation-plan deduplication preserves distinct structural identities. | `src/remediate/phases/triage.ts` |
| INV-RS | Remediation state-machine ordering and fail-closed completion. | `src/remediate/steps/nextStep.ts`; `src/remediate/phases/close.ts` |
| INV-RSM-RESOLUTION | Resolution requests have run-unique ids. | `src/remediate/steps/nextStep.ts` |
| INV-RSM-RESOLUTION-CORRELATE | Review and triage answers must match the requesting run and plan. | `src/remediate/review/reviewGate.ts`; `src/remediate/phases/triage.ts` |
| INV-RSM-SPLIT | Splitting a remediation block preserves phase, dependency, scope, and verification semantics. | `src/remediate/phases/plan.ts` |
| INV-RSM-STATE-COMPLETE | Persisted remediation state contains every field implied by its status. | `src/remediate/state/store.ts`; `src/remediate/phases/triage.ts` |
| INV-S04 | Verbatim free-form intent is never copied into a host workload or output; only interpreted signals cross the boundary. | `src/shared/intent/freeFormIntentInterpreter.ts`; `src/shared/intent/pathScope.ts` |
| INV-SCC | Portable run-id path encoding and live-holder file-lock freshness. | `src/shared/io/frictionCapture.ts`; `src/shared/io/fileLock.ts`; `src/shared/friction/triage.ts` |
| INV-SOO | Canonical physical-file identity for ownership and overlap checks. | `src/shared/io/pathIdentity.ts` |
| INV-SSP-DEFERRED-SET-REPORTED | `computeStaleArtifacts` returns the stale set together with an explicit deferred set naming every downstream held behind a slice projection, and the emitted consolidated staleness record names them — an omission is red. | `src/audit/orchestrator/staleness.ts` |
| INV-WTS | Landed-node ancestry probe: a landed node's commit must be an ancestor of the ref it claims to have landed on. | `src/remediate/steps/dispatch/hostHandoff.ts` |

The source also contains local numeric invariants such as INV-1, INV-2, INV-3, INV-09, and INV-10.
Those numbers are file-local; resolve them at the citing module rather than treating them as a global
namespace.

## Live counterexample ids

The source currently cites CE-001 (plus the variant CE-001b) through CE-011, plus CE-013 and CE-206.
Their meanings are local to the validator, ledger, intent, analyzer, worktree, or scoring code that
cites them. Reuse of a number in another subsystem does not imply shared identity.

## Live plan-node ids

| Id | Meaning | Live owner |
|---|---|---|
| N-R13 | The former document phase remains dissolved; an existing item specification carries forward. | `src/remediate/steps/nextStep.ts` |
| N-R21 | Circular interface-definition dependencies route to explicit resolution. | `src/remediate/validation/contractPipelineGates.ts`; `src/remediate/steps/contractPipeline.ts` |
| N-X06 | Deterministic free-form intent interpretation seam. | `src/audit/orchestrator/intentInterpreter.ts` |

## Live finding citations

The live finding-id prefixes are ARC, COR, DAT, MNT, OBS, REL, and TST. FND-COR and FND-OBS
citations also remain in source comments. Their full finding text belongs to the audit artifact or
review that minted the id; source comments use them only as traceable provenance.
