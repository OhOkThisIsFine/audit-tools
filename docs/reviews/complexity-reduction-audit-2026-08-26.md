# Complexity reduction audit — 2026-08-26

## Result

Seven current simplification candidates survived graph analysis, source review,
and test-path validation. The strongest two are structural rather than cosmetic:

1. replace four directed-cycle implementations with one shared SCC/witness
   primitive; the two Kahn-based variants currently over-report acyclic tails;
2. remove audit-code's nested obligation drains so one registry and one engine own
   selection, execution, caps, failure attribution, and host suspension.

The remaining candidates are smaller consolidations or pure deletion. Large-file
size and cognitive-complexity scores were used only to choose where to inspect;
they are not findings by themselves.

## Evidence boundary

- **Repository / revision:** `C:/Code/audit-tools` at
  `b2e6734d9e92425308e521fb766d3bdb34566cf4` (`main`). None of the material
  source paths changed while the shared checkout advanced during this review.
- **Codebase Memory project:** `C-Code-audit-tools`, full index generation
  `2026-08-26T17:51:08Z`, coverage record complete, coverage version 3,
  `hash_records_complete=1`, ignored-file accounting `362/362`.
- **Graph snapshot:** 20,897 nodes and 69,858 edges. Relevant call paths were
  checked in both directions; exact source was read for every material claim.
- **Coverage:** the formal `check_index_coverage` CLI invocation was rejected
  before execution because another live CBM cohort owned the generation. As a
  fallback, the same generation's read-only coverage/hash tables were checked:
  all 41 evidence paths had exact current SHA-256 matches and none had a
  coverage exception. The daemon's missed graph contained seven partially
  parsed files: `src/shared/analyzers/candidates.ts`, five unrelated tests, and
  one ignored `.audit-tools` patch. None is a material evidence path here.
- **Repository-wide negative claims:** production `rg` checks covered `src`,
  `scripts`, and `wrapper`; this closes the graph gap for the tested-only
  deletion bundle without treating a clean graph result as proof of absence.

Review-only measurements:

- `sonarjs/cognitive-complexity` at threshold 20 found 89 production functions;
  the highest readings were 104 in `computeStaleArtifacts`,
  `validateImplementationDAGIntegrity`, and `crossLensDedupe`.
- A lower-threshold jscpd probe found 35 clone regions / 0.44% duplication.
- `knip --production --exports` surfaced 13 production exports with no
  production consumer; exact source/graph review separated real dead code from
  deliberate test seams and source-scanned declarations.
- The normal repository gates still passed: `check:deadcode`, `check:dup`, and
  `check:depgraph` (410 modules / 1,588 dependencies; no violations).

## Recommended simplifications

### CX-01 — One directed-cycle core, with exact SCC membership

**Confidence:** high. **Why first:** it removes duplicated algorithms and fixes
a demonstrated correctness defect.

Four implementations currently answer overlapping cycle questions:

| Implementation | Location | Current behavior |
|---|---|---|
| Shared DFS witness | `src/shared/types/obligationLedger.ts:26-63` | Returns the first exact cycle witness. |
| Cyclic-seam Kahn + union-find | `src/remediate/contractPipeline/cyclicSeamResolution.ts:78-161` | Returns components among every node left after Kahn's drain. |
| Design-gate Kahn clone | `src/remediate/validation/contractPipelineGates.ts:172-226` | Emits a warning from every node left after Kahn's drain. |
| Contract validator DFS | `src/remediate/validation/contractPipeline.ts:641-704` | Privately repeats directed-cycle traversal. |

The Kahn remainder is not the set of cycle members. A node downstream of a
cycle never reaches indegree zero, so it remains even though it is not in a
cycle. A live probe at this revision produced:

```json
{
  "seam": [{ "members": ["A", "B", "TAIL"] }],
  "shared": ["A", "B", "A"]
}
```

for `A -> B`, `B -> A`, `TAIL -> A` (where `needs` points to a dependency).

**Elegant endpoint:** one deterministic shared directed-graph primitive based
on strongly connected components. It should return all exact cyclic SCCs and a
stable first witness for callers that need the existing DFS-shaped result.
Domain wrappers should only translate IDs and messages.

Preserve:

- code-unit-stable output order;
- ignored external references;
- exact membership for downstream and upstream tails;
- self-loop detection;
- all independent cycles, not only the first;
- first-witness compatibility for `buildObligationLedger`.

Add dependent-tail and self-loop cases to
`tests/remediate/cyclic-seam-resolution.test.ts`; keep the existing independent
cycle tests. This should delete three local traversal algorithms rather than
introduce a fifth generic facade.

### CX-02 — One audit obligation registry and one drain

**Confidence:** high. **Why it matters:** audit-code currently nests two drains
over the same `PRIORITY`, so engine semantics are duplicated even though a
shared obligation engine already exists.

The live call chain is:

```text
runDeterministicForNextStep
  -> shared obligationEngine.advance (outer drain)
  -> runDeterministicExecutor
  -> executeAndRecord
  -> runAuditStep
  -> advanceAudit
  -> shared obligationEngine.advance (inner drain)
```

Evidence:

- outer registry: `buildAuditObligations` in
  `src/audit/cli/nextStepHelpers.ts:2238-2485`, invoked at `:2748`;
- outer execution and repair plumbing:
  `src/audit/cli/nextStepHelpers.ts:1794-1841,2161-2203,2690-2827`;
- bridge into the inner drain: `src/audit/cli/auditStep.ts:229`;
- inner state adapter and registry:
  `src/audit/orchestrator/advance.ts:612-635,706-713`, invoked at `:787`;
- shared engine: `src/shared/engine/obligationEngine.ts:236-293`.

The nesting forces two obligation-definition adapters, two transition/cap
layers, repeated holistic state derivation, failure-attribution repair after an
inner executor fails, and fold-local advisory carry plumbing.

**Elegant endpoint:** one ordered audit obligation registry containing each
obligation's derivation and execution policy. The engine returns a typed
suspension when host input is required. The CLI draw renders that suspension;
the programmatic draw returns it. Neither draw starts a second drain.

Preserve:

- deterministic frontier draining within one call;
- every host-input stop boundary;
- exactly-once `preferredExecutor` execution;
- `MAX_DRAIN_STEPS`, lock/heartbeat behavior, and one staleness record per call;
- attribution to the executor that actually failed;
- advisory delivery on the next emitted host step.

Remediation already demonstrates the intended shape by using shared `advance`
directly with its policy definitions in
`src/remediate/steps/nextStep.ts:3733-3989,4019-4233,4363-4397`.

### CX-03 — Delete tested-only production APIs

**Confidence:** high. **Reduction:** about 160 production lines plus tests that
exercise paths the product never takes.

| Production symbol | Live consumer evidence | Action |
|---|---|---|
| `writeCanonicalAuditDeliverables` (`src/audit/io/artifacts.ts:541-589`) | Only called by `tests/audit/io-remediation.test.ts`; live promotion is `promoteFinalAuditReport`. | Delete the dead writer and its dedicated test. Keep promotion's archive-before-cleanup/loss-reporting tests. |
| `readContractPipelinePlanningOutputs` and its result interface (`src/remediate/steps/contractPipeline.ts:4493-4557`) | Only called by three assertions in `tests/remediate/contract-pipeline.test.ts`. | Delete the reconstruction API; assert promoted plan contents through the live path. |
| `isBlockId` / `fromBlockId` (`src/remediate/contractPipeline/idRegistry.ts:52-64`) | Only the inverse test calls them. Production uses `ensureNodeId` and `toBlockId`, never the inverse. | Delete the inverse pair and its orphaned tests/spec promise. |
| `projectDesignReviewInputs` (`src/audit/orchestrator/designReviewProjection.ts:275-283`) | No graph caller; tests call it directly. Production snapshots loop over singular `projectDesignReviewInput`. | Delete the bulk wrapper; migrate tests to the production snapshot path or singular projector loop. |
| `obligationKindVocabularyDivergence` (`src/remediate/steps/contractPipeline.ts:3779-3783`) | Three test-only calls. | Single-source the vocabulary, then delete the production test seam. Moving the set difference into a test alone would preserve the duplication and is not sufficient. |

All are internal deep imports rather than `audit-tools/shared` package exports.
The graph's only inbound edges are tests (or none), and exact production text
search found no registry, alias, script, or dynamic consumer.

### CX-04 — Make cross-gate outcomes the only evaluator

**Confidence:** high. **Reduction:** one parallel eight-gate path and its parity
test.

`src/remediate/validation/contractPipelineGates.ts:1789-1820` and
`:1832-1903` independently extract the same payloads and invoke the same eight
validators in the same order. The richer outcomes path is already used by
`src/remediate/validation/artifacts.ts:554-561`; the only live plain caller is
`src/remediate/index.ts:411-415`. The source comment at
`src/remediate/validation/artifacts.ts:538-545` and the backlog already name the
duplication.

**Elegant endpoint:** keep `evaluateContractPipelineCrossGateOutcomes` as the
canonical computation. Change the plain caller to flatten `outcome.issues`,
then delete `evaluateContractPipelineCrossGates` and the parity-only additive
test. Preserve the gate count, order, absent-artifact tolerance, and issue text.

### CX-05 — One finding-survivor fold, two matching policies

**Confidence:** medium-high.

`src/shared/findings/dedupe.ts:285-345` and `:545-578` repeat the group/pair
scan, removed-survivor guard, severity/confidence winner selection, absorption,
and removal. Cross-lens and same-lens matching thresholds are real policy
differences; the survivor lifecycle is not.

The `breakOnAbsorbedSurvivor` policy axis is dead complexity. When `!keepA`, the
code marks the current `i` survivor removed; the next loop iteration already
breaks unconditionally on that state. The flag only avoids one loop header.

**Elegant endpoint:** a shared `collapseFindingGroups` fold owns iteration,
ranking, absorption, and removal. Callers provide grouping and pair-match
policy. Keep cross-lens clone accumulation, merge-chain closure, evidence
conservation, and dispositions as explicit post-fold phases. Delete the policy
field and both call-site booleans in
`src/audit/reporting/mergeFindings.ts` and
`src/remediate/dedup/crossLensDedup.ts`.

### CX-06 — Share only the host-submission scan

**Confidence:** medium-high. **Reduction:** approximately 60–90 lines of
repeated path/read/classify/deduplicate plumbing.

The existing `src/shared/submission/hostHandoffCore.ts` correctly owns paths,
envelopes, prompt/result identity, and result-map identity. A full shared
persistence engine would hide real audit/remediation differences, but one
bounded seam remains duplicated:

- audit wrapper and ingestion use:
  `src/audit/cli/dispatch/hostHandoff.ts:1021-1068,1129-1155`;
- remediation repeats path resolution, JSON read/classification, domain parse,
  and duplicate-result handling inline at
  `src/remediate/steps/dispatch/hostHandoff.ts:2059-2103`.

Both expose missing, malformed, contract-invalid, and duplicate-submission
outcomes. A shared scan should resolve the contained bound path, read/classify
the document, invoke a domain parser, enforce run/item/prompt identity, reject
duplicate `result_id`, and aggregate generic issues.

Keep preparation, corroboration, state mutation, and final persistence in each
draw. Audit owns its accepted ledger/lock and grounding; remediation owns
baseline binding, git ancestry/diff/write scope, required tests, recovery, and
state mutation.

### CX-07 — Table-drive only repeated required-entry gates

**Confidence:** medium. **Reduction:** about 30–35 lines without creating a
validator DSL.

`validateDesignSpecGates` repeats six checks with the same shape at
`src/remediate/validation/contractPipelineGates.ts:63-98,136-168`: collection,
required field, non-empty kind, path, and reason. A typed six-row descriptor and
one small validator loop can own those checks.

Leave invariant-to-obligation coverage and directed-cycle logic explicit; they
are joins/graph rules, not field requirements. Preserve exact issue order and
messages, and add the currently missing negative test for
`trust_boundaries[].untrusted_inputs`.

## Rejected apparent hotspots

- **`computeStaleArtifacts` rule DSL:** rejected. The function already consumes
  declarative adjacency and slice registries; its migration, dependency-hash,
  tri-state presence, and slice-deferral ordering are real semantics. Named pure
  passes may improve readability, but a DSL would relocate rather than delete
  complexity.
- **`resolveIntakeStep` state-machine rewrite:** rejected. It is a sequential
  early-return state machine whose discovery, manifest-refresh, and
  clarification ordering is load-bearing. Extracting its small duplicated
  synthesize-step constructor is reasonable local cleanup, not an architectural
  finding.
- **Close-report builders:** rejected. One is flat ordered rendering; the other
  contains coherent status-to-evidence policy. Generic section tables would
  obscure the contract.
- **A second state DSL for `deriveAuditState`:** rejected. Simple rows belong in
  CX-02's one registry, while intent, charter, runtime-completion, and partition
  gates cannot be derived from the artifact dependency map.
- **Full host-handoff unification:** rejected. The shared core already absorbed
  draw-independent behavior. CX-06 stops before domain validation and
  persistence become a hook-heavy configuration shell.
- **High fan-in shared primitives:** rejected. `compareCodeUnits` and `isRecord`
  have high fan-in because earlier duplication was successfully consolidated;
  their centrality is evidence of reuse.
- **Generated maps, barrels, lookup tables, and accepted test fixtures:**
  rejected as complexity findings.

## Verification performed

- Live cycle-tail probe reproduced the Kahn remainder defect shown above.
- Targeted Vitest run passed 177/177 across cyclic-seam, cross-gate,
  cross-/same-lens dedupe, and validation suites.
- `npm run check:deadcode` — passed.
- `npm run check:dup` — passed.
- `npm run check:depgraph` — passed, no dependency violations.

No production code was changed by this review.
