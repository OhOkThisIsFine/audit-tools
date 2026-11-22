# Contracts

## Versioned surfaces

The public surface is schema-first. Important schemas live under `schemas/`,
including audit results, tasks, findings, and lenses. Hosts should consume
versioned artifacts rather than infer state from
filenames or duplicate field descriptions.

The canonical final outputs are:

```text
.audit-tools/audit-findings.json
.audit-tools/audit-report.md
```

The JSON contract is authoritative; Markdown is its render.

## TypeScript import migration

Import the current-run consent writer with `import { persistAnalyzerConsent } from "audit-tools/shared/analyzerPolicy"`. The function accepts the same repository root and decline decisions and returns the durable analyzer settings.

The next release also moves the following type-only imports from `audit-tools/shared` to their defining public subpaths. Keep the same type name and change the module specifier in your `import type` declaration. For example, `import type { ChurnEntry } from "audit-tools/shared/git"` imports the entry returned by the Git history reader.

| Import from | Type names |
|---|---|
| `audit-tools/shared/agentReflections` | `ReflectionClarity`, `ReflectionSeverity` |
| `audit-tools/shared/analyzers/normalizeExternal` | `NormalizeExternalOptions` |
| `audit-tools/shared/contentKey` | `IdempotencyKeyInput`, `TaskContentSignatureInput` |
| `audit-tools/shared/decompose/charterClarification` | `AssembledClarifications` |
| `audit-tools/shared/decompose/charterExtraction` | `AssembledComparison`, `AssembledLaneGraph`, `CharterMergedLane` |
| `audit-tools/shared/decompose/consensus` | `DecomposeOptions` |
| `audit-tools/shared/decompose/contentCoherence` | `ContentCoherenceEligibility`, `ContentCoherenceInput`, `ContentCoherenceItem`, `NormalizedContentCoherenceItem` |
| `audit-tools/shared/fileIntegrity` | `FileIntegrityCheckOptions`, `FileIntegrityHashOutcome` |
| `audit-tools/shared/findings/dedupe` | `AbsorbOptions` |
| `audit-tools/shared/friction/frictionRecord` | `FrictionRecordReference` |
| `audit-tools/shared/friction/stepBoundaryCapture` | `StepBoundaryFriction` |
| `audit-tools/shared/friction/triage` | `FrictionTriageDecision`, `TriageSubject` |
| `audit-tools/shared/git` | `AuthorshipEntry`, `ChurnEntry`, `CoChangePair`, `MineGitHistoryOptions` |
| `audit-tools/shared/hash` | `HashContentOptions` |
| `audit-tools/shared/hostAssets` | `RenderHostAssetOptions` |
| `audit-tools/shared/intent/clauseInterpreter` | `ClauseInterpretResult`, `IntentClauseKind` |
| `audit-tools/shared/io/gitignoreArtifacts` | `RepoVisibility` |
| `audit-tools/shared/io/pathContainment` | `WithinRootOptions` |
| `audit-tools/shared/observability/runLog` | `RunLoggerOptions` |
| `audit-tools/shared/opencodePermissions` | `OpenCodeCeilingViolation` |
| `audit-tools/shared/parsing/stringAwareScanner` | `QuoteChar`, `StringAwareScannerOptions` |
| `audit-tools/shared/prompts` | `CacheablePromptParts` |
| `audit-tools/shared/reporting/auditDeliverable` | `AuditDeliverablePair` |
| `audit-tools/shared/reporting/findingDisplay` | `FindingBadge`, `FindingDisplay`, `FindingDisplayOptions`, `FindingFileRef` |
| `audit-tools/shared/reReview/projectionDiff` | `ReReviewSectionInput` |
| `audit-tools/shared/submission/expectedSubmissions` | `ExpectedSetDiff`, `ExpectedSubmissionLane`, `SubmissionClassification` |
| `audit-tools/shared/submission/hostHandoffCore` | `IdentityBindingParams`, `IdentityComponent`, `ResultMapEntry`, `ResultMappedItem`, `WorkloadEnvelopeParse` |
| `audit-tools/shared/submission/hostResultOutcomes` | `HostResultOutcomes`, `TrailingSubmissionRefusal` |
| `audit-tools/shared/submission/ingestionChecks` | `IngestionCheck`, `IngestionDraw` |
| `audit-tools/shared/submission/submissionClassifier` | `SubmissionReadContext` |
| `audit-tools/shared/submission/submissionIdentity` | `SubmissionIdParts` |
| `audit-tools/shared/submission/submissionLedger` | `SubmissionLedgerDropReason` |
| `audit-tools/shared/submission/submissionScan` | `SubmissionScanOutcome` |
| `audit-tools/shared/tooling/allowlistedExec` | `AllowlistedExecOutcome`, `AllowlistedExecRunner` |
| `audit-tools/shared/tooling/analyzerDeps` | `AnalyzerDepVia`, `InstallToCacheResult`, `ResolveAnalyzerDepOptions`, `ResolvedAnalyzerDep` |
| `audit-tools/shared/tooling/exec` | `SpawnDeadlineMiss` |
| `audit-tools/shared/tooling/landingGates` | `LandingGateRole` |
| `audit-tools/shared/tooling/repoConventions` | `RepoConventions` |
| `audit-tools/shared/types/charter` | `ClarificationValue`, `CorrespondenceMember`, `DifferenceAccount`, `DifferenceDimension`, `DifferenceRelation`, `DifferenceSplit`, `GoalEdge`, `GoalNode`, `LaneGoalEdge` |
| `audit-tools/shared/types/charterPacket` | `CharterPacketManifestExcerpt`, `PacketExcerptLine` |
| `audit-tools/shared/types/contractPropertyShapes` | `ContractPropertyShape`, `ContractTypeShape` |
| `audit-tools/shared/types/executionPlan` | `ExecutionSourceDisposition` |
| `audit-tools/shared/types/finding` | `FindingEvidenceLane`, `FindingLocationLineIssue`, `FindingVerificationStatus` |
| `audit-tools/shared/types/flows` | `FlowConfidenceLevel` |
| `audit-tools/shared/types/intentCheckpoint` | `DesignReviewSettings`, `LenientIntentCheckpointRead` |
| `audit-tools/shared/types/reviewIndependence` | `ContractReviewDeclaration`, `ContractReviewProvenance`, `ReviewDeclaration`, `ReviewSubmissionEnvelope`, `ReviewSubmissionFailureCode`, `ReviewSubmissionParseResult` |
| `audit-tools/shared/types/surfaces` | `SurfaceKind` |
| `audit-tools/shared/validation/basic` | `ValidationSeverity` |
| `audit-tools/shared/validation/contractConstructionSites` | `DerivedSiteMap`, `DerivedSites`, `FileSiteMarkers`, `RenderedJsonSchema`, `SiteMarker` |

## Step artifacts

`audit-code next-step` advances one bounded, fold-aware drain of the deterministic frontier and writes:

```text
<artifacts_dir>/steps/current-step.json
<artifacts_dir>/steps/current-prompt.md
```

`current-step.json` uses `audit-code-step/v1alpha1` and names the current prompt,
run, allowed commands, stop condition, repository root, artifact directory, and
relevant artifact paths. The conversation loader reads only `prompt_path` and
follows the rendered prompt.

## Functional capability declaration

The `functional_preflight` step emits the report path and a complete
`audit-functional-preflight/v1` example. The declaration binds the current run and
canonical repository root to observed source/relationship inspection, a
`ready`, `degraded` or `stop` decision, and any approved limitation. It is a host
declaration of observed capability, not automatic proof of the host's tools.
Missing, malformed or differently bound reports return to this entry step;
`stop` remains stopped until the operator changes the decision.

## Semantic review submissions

An independence-required review prompt asks for `review-submission/v1`, containing
its exact `prompt_sha256`, a `review` declaration (`mode` and `reason`), and the
complete domain object in `result`. Use this only when the current step asks for
it, not for ordinary question answers.

The tool's current binding determines the requirement. An independent lane cannot
accept `degraded` or `unavailable` as success; explicitly permitted light remediation
critique/critic roles may declare degraded review. The final judge requires an
independent context. The tool verifies binding, shape and domain validation, not
the declared reviewer's identity. Identical complete audit task/context content may
reuse a matching review after current authority is re-emitted; this is not a claim
that a fresh reviewer executed on every run. Design reviews use the existing
semantic/structural input projection, which excludes per-file content hashes and
provenance timestamps; this is not an identity over every repository byte.

Remediation persists accepted domain content in the canonical artifact's `payload`
with validated review provenance. Downstream prompts read that accepted payload;
workers write only their separately emitted submission path. Optional per-result
conformance review is a bound acceptance step. Ordinary ingestion requests it
after structural corroboration and before required tests, then rechecks the
binding before acceptance. Review does not replace commit, scope, test or
obligation-evidence checks. Its run choice and result/contract binding cannot be
disabled by changing a copied checkpoint.

## Current question review

An ordinary `question_review` step publishes provider-neutral assignments. Read
the prompt named by `audit-code next-step` for the current workload and exact
submission binding. Answer the issued question and its requested parts; the files
suggested by the assignment help locate evidence, but reading a file is not an
answer by itself. State limitations and use the inconclusive outcome when
evidence is insufficient. Treat analyzer leads as leads, and do not label a
static inference as an executed observation.

Submit the bound answer with
`audit-code submit --work-item <id> --from <file>`, or the equivalent host tool
when the prompt directs you to it. The submission binds the assignment,
question, revision, and snapshot; do not reuse an old answer by editing its IDs.
Then call `audit-code next-step` to continue. No backend, model, routing, or quota
configuration belongs in the answer.

## Legacy ingestion reference

The generated table below retains the older per-file audit checks alongside
remediation checks; the audit rows are not a template for answering a current
question.

<!-- BEGIN GENERATED INGESTION CHECKS — scripts/shared/generate-ingestion-checks.mjs — DO NOT EDIT BY HAND -->

> Rendered from `src/shared/submission/ingestionChecks.ts` — the registry both host-handoff twins cite on every
> refusal they emit. Add a check there and this table follows; the drift test refuses a
> row nothing cites.

| Check | What must hold for the result to be accepted | Draws |
|---|---|---|
| `result_path` | The submission is read only from the tool-derived bound path (`<run dir>/<sha256(work item id)>.json`) inside the run's artifacts directory; a result written anywhere else is never consulted. | `audit`, `remediate` |
| `result_json` | The bytes at the bound path parse as JSON. | `audit`, `remediate` |
| `result_envelope` | The top-level key set is exactly the draw's result contract and `contract_version` is the version the workload was issued under. | `audit`, `remediate` |
| `identity_binding` | `run_id` is the run that emitted the workload, `work_item_id` is the work item the result was read for, and `prompt_sha256` is the digest of the prompt that work item was issued with — an answer to another run, item or a stale prompt is refused. | `audit`, `remediate` |
| `workload_binding` | The persisted workload, result map and task bindings still derive from this run (versions, bound paths, prompt digests, scopes); a result cannot be accepted against a binding the tool cannot re-derive. | `audit`, `remediate` |
| `file_coverage` | `file_coverage` names exactly the assigned files, each fully reviewed, with `total_lines` equal to the line count bound at dispatch. | `audit` |
| `findings_contract` | Every finding satisfies the audit finding contract (lens, ids, evidence shape). | `audit` |
| `result_schema` | The bound result converts to the persisted `AuditResult` schema (`schemas/audit_result.schema.json`). | `audit` |
| `result_validation` | The per-result content rules hold before acceptance (evidence present, line spans inside the file, line counts matching disk); warnings ride an advisory channel and never refuse. | `audit` |
| `outcome_shape` | A decision result's `outcome` carries exactly the fields its status requires (`resolved_no_change` evidence, `blocked` failure reason, `needs_clarification` question). | `remediate` |
| `landed_commit` | `landed_commit` is a full commit id that exists, is not the workload baseline, changes at least one file, descends from the baseline (waived only under a genuinely orphaned baseline in recovery), and is reachable from HEAD. | `remediate` |
| `write_scope` | Every file the landed commit changed, as git reports it, lies within the prompt-bound `allowed_files`. | `remediate` |
| `required_tests` | The tool's own rerun of every prompt-bound required test passes on the tree that holds the landed commit. | `remediate` |
| `obligation_evidence` | `obligation_evidence` cites non-empty evidence for every prompt-bound obligation, none twice, and none the work item does not bind. | `remediate` |
| `run_start_dirt` | No file the landed commit changed overlaps dirt that pre-dated the run. | `remediate` |
| `no_change_corroboration` | A `resolved_no_change` claim is corroborated against git and the persisted write-scope binding; attestation-only acceptance is refused. | `remediate` |
| `duplicate_result` | `result_id` has not already been accepted this run: a byte-identical replay is a no-op, a different body under an accepted id is refused. | `audit`, `remediate` |

<!-- END GENERATED INGESTION CHECKS -->

## Archived per-file results

`schemas/audit_result.schema.json` describes per-file results retained in old
reports. New reviews submit answers to issued questions with `audit-code submit`.
The former standalone per-file validator is not a current command.

## Artifact bundle

Resumable state lives under `.audit-tools/audit/`. The registry-backed contract
in [`spec/audit/artifact-contract.md`](https://github.com/OhOkThisIsFine/audit-tools/blob/HEAD/spec/audit/artifact-contract.md)
(repository-only, so the link is absolute) covers the
complete set. Representative artifacts include repository and unit manifests,
file disposition, graph and critical-flow data, question plans and evidence,
accepted answers, synthesis narrative, and the final
deliverables.

<!-- doc-citation-exempt: historical run artifact retired from the current registry -->
New runs omit `access_memory.json`. Older runs resume without it, and rollover
clears the working copy. Archived copies retain the original data. For tools
reproducing an old metadata hash for that retired filename, omit `run_id`
before hashing the payload.

Run `audit-code validate` instead of treating file presence as proof of a valid
state transition.

## Graph contract

`graph_bundle.json` is language-neutral. Edges carry `from`, `to`, `kind`, and
optional direction, confidence, and reason. Deterministic import, entrypoint,
test/source, and ownership evidence may drive grouping; weak affinity and
high-fan-in edges remain explainable context unless corroborated.

Planning metrics record packet cohesion and the kinds of edges that cross
packet boundaries. New metrics omit `packet_quality.merge_edge_kind_counts`.
Previously written metrics remain readable. Removing the field changes the
payload hash when a run writes the new shape.

## Guided recovery

Failures distinguish rerunning a command, importing a result/update file,
repairing strict repository intent, retrying a schema-invalid host result, and
performing the assigned semantic review manually. Backend-execution failures
are not an audit-tools state: the host reports or retries them without inventing
provider-specific fields in persisted contracts.
