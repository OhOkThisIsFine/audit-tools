<!-- review-routing: no-forward-work -->

# Audit-tools completion review — September 30, 2026

## Goal and authority

Complete the existing project toward the cleanest, most efficient and effective endpoint. The owner authorized implementation, push and merge, and reasonable project-philosophy decisions while offline. Record significant choices for later review; do not treat an old checklist as a reason to retain ceremony or restore redundant code. Package publication and global installation are outside this task's approval.

The September 19 inventory supplies a bounded reconciliation list. Every row needs implementation evidence or an honest disposition: already satisfied, superseded, reference, externally blocked, or a measurement requiring a real observation window. An empty backlog is not the completion criterion.

## Decisions to revisit

### Implementation instructions belong to the task

Do not restore four scattered properties on every audit `Finding` merely to satisfy packet 3. `concrete_change` repeated the node description, and counterexample identifiers already have traceability. However, accepted node preconditions and expected changes can contain distinct instructions that the current promotion and dispatch discard. Preserve useful node-specific context once on the implementation block and in its bound worker prompt, without changing the meaning of an audit finding or duplicating the finalized module contract.

Evidence: `contractPipeline.ts` promotion, `hostHandoff.ts` assignment rendering, and the optional fields accepted by `validation/contractPipeline.ts`. The September 15 removal (`f9e3c9233`) is relevant history, not proof that losing information is correct. Regression coverage must exercise promotion through strict plan parsing to the actual worker prompt, including canonical audit findings.

Tradeoff: a small task-context contract replaces unnecessary finding fields. Reversing this requires updating the task schema and prompt binding together, not silently dropping accepted inputs.

### Review choices are exact and run-bound

An explicitly selected reviewer list should remain exactly that list; numerical legacy selection keeps its existing behavior. A stale or unbound selection requires reconfirmation instead of silently selecting a shallower review. Contradictory shallow-depth plus explicit fan-out input must receive an actionable correction.

Tradeoff: stale sessions may require one renewed answer. This avoids doing less review than the user requested.

### Consent belongs to the current run

Follow the newer agreed per-run consent direction, rather than inheriting historical analyzer grant or decline choices indefinitely. Resume retains this run's decision; a fresh run obtains its own decision. Legacy policy files must remain readable without turning an old decline into silent permission.

Tradeoff: a fresh audit can ask again. The implementation must use the existing artifact lifecycle and lock rather than invent another global policy store.

## Scope reconciliation

- Packets 1–2 were already complete before this work. Do not republish version 0.52.3.
- The node-field entry in packet 3 conflicts with an earlier deliberate removal. Resolve its underlying information-flow defect as described above, rather than mechanically restoring the old representation.
- Packet 32's historical text-envelope handling is not the active dispatch path. Verify the structured-content route and current snapshot isolation before adding a helper for an obsolete path.
- Live host GUI checks, installed external analyzers, release publication, and recurrence measurements must be listed explicitly if not verified here. Passing local unit tests is not evidence that they occurred.

## Verification status

Local verification completed on September 30:

- Full suite: **589 files passed; 7,742 tests passed, 3 skipped, 0 failed** in 217.75 seconds. The tested staged tree was `ab4e5231cfb05a12d254dd612b17f2e4e7fd9e91`; subsequent completion-evidence edits are documentation-only.
- The aggregate verification catalog passed, including source/test typechecking, lint, structural/documentation guards, packaged audit/remediation flows, host-installation fixtures and all eight generic remediation-gate checks.
- Isolated linked audit completed the bootstrap, ingestion, report, promotion and fresh-run flow; linked remediation passed all 14 checks. These used a temporary installation prefix and home directory, not the operator's global installation.
- Independent source review and demonstrated failing-then-passing production regressions covered current-task review acceptance, snapshot migration, consent, canonical artifact handling and the concrete retained backlog claims. The retained-row review found no demonstrated actionable local defect; remaining measurement and external checks are qualified in the [reconciliation](backlog-reconciliation-2026-09-30.md).

The three test skips are two Windows-specific cases and one explicitly disabled historical finalization-cycle case. The Git-probe-dependent fixture ran successfully in this final suite. Author-local memory citations were explicitly **not checked** under the isolated home directory. Interactive host GUIs, unavailable Rust/Ruby toolchains, Windows orphan-work ownership and long-run/model-quality observations were not certified. No package was published and no real global installation was performed.

This section records local evidence, not remote delivery. The associated pull request's exact-head checks and merge record establish the remote result; evidence-only document updates receive their required final checks separately.

## Remaining-work source review

This records the initial source investigation, not current completion status. Final dispositions and verification below supersede these observations:

| Area | Source finding and intended disposition |
| --- | --- |
| 12: retry-safe acceptance | Active: `recordLaneOutcome` returns before expected-set cleanup when acceptance already exists. Audit preparation publishes task bindings outside the accepted-results lock; ingestion reads the binding set before its commit lock. Fix and exercise interrupted/concurrent production paths. |
| 13: bounded repair | Review actual repair/rebind paths after acceptance changes; preserve accepted results and canonical identity. Existing bounded excerpts and stale-version repair must not be reimplemented. |
| 14: lifecycle | Active feature gap: explicit persisted plan-only/pause/resume/cancel are not supplied by the existing gate-red resume acknowledgment. |
| 16: semantic lead confirmation | Active: `mergeFindings` currently promotes deterministic structure/charter leads directly alongside semantic results. Confirmation must precede final report promotion. |
| 17: conformance review | Active feature gap: comments mention per-result conformance review but do not implement its opt-in bound lifecycle. |
| 20: producer validation | Audit artifact definitions currently use generic writes. Verify and validate canonical producer boundaries rather than extending an unsound construction-site detector. |
| 21: behavioral test evidence | Comment pins and import relationships do not prove execution or assertions. Prioritize demonstrated production-path red/green regressions. Any additional ownership/coverage machinery must provide real evidence rather than another author declaration. |
| 26: shared evaluation | `contractPipelineGates` still evaluates applicability twice. Snapshot implementations already share projection, optional-read and version-mismatch helpers; extract further only where policy-free behavior is genuinely duplicated. |
| 27: validation reuse | Ingestion and batch processing both validate results. An optimization may skip this only with an exact internal content/context binding. Do not weaken validation or add an unearned fast path. |
| 31: guards | Masked-exit command families are already present in `shell-trap-guard`; `isRecordPath` already participates in queue probe writes. The barrel-spy scan remains confined to remediation tests and needs wider reach. Optional JSON/text helpers already preserve non-missing read errors. |
| 33: ignored root logs | Bounded observation only; never restore automatic deletion of unrelated root files. |
| 35, 37: measurements | Use measured child/phase duration and real cascade evidence. Do not invent an unobserved performance defect or equivalence cache. |
| 36, 38: external state | GUI/toolchain checks and unregistered local Windows worktree ownership cannot be certified from this cloud checkout. Preserve unknown work; list unavailable evidence explicitly. |

## Additional decisions and verified reconciliations

- **Functional preflight is an explicit entry step.** The host declares concrete source/relationship inspection observations, bound to the current repository and run. Missing or stale evidence blocks semantic work. A degraded source-focused audit needs explicit operator approval and gets a mechanically recorded report limitation. This is a declaration boundary, not a claim that audit-tools can prove another host's capabilities. Extra required file probes would imply stronger evidence than they provide and incorrectly reject empty repositories.
- **Review depth and independence are separate.** Preserve explicitly permitted light critique/critic self-checks, with recorded degraded provenance. The final judge remains independent. Required independent lanes pause when that context is unavailable rather than silently substituting self-review. This judgment is revisitable if the owner wants different role-specific tradeoffs.
- **Per-result conformance is opt-in.** Bind the run's initial choice in tool-owned state so later checkpoint edits cannot silently disable it. Both successful landed work and successful no-change claims require the selected review; blocked or clarification outcomes do not wait for success certification.
- **Dry-run is sticky within an audit run.** Omitting the flag on a later continuation does not re-enable formatting. Fresh-run cleanup resets it. Explicit formatter opt-in invalidates the completed auto-fix marker only once, without creating a repeated-format loop.
- **Use existing canonical accepted artifacts downstream.** Independent review transport carries its declaration and domain result together; subsequent prompts read the accepted artifact's payload. Do not add a third payload file or overwrite host submissions to hide their transport envelope.
- **Shared traversal preserves consumer policy.** Audit's tooling hash follows descendant links and records vanished entries; remediation artifact validation treats descendant links as leaf entries. Both now use the same stable traversal, and ancestor cycles refuse without suppressing separate aliases to the same target. Root input permission failures no longer look like absent tooling.
- **Keep useful names, remove empty aliases.** Canonical lens/severity/confidence and clause projection are shared. Pure alternate type names were removed; interfaces conveying a real result/context contract were retained. Line count alone is not a deletion criterion.
- **The philosophy has one brief and a homes table.** Unique decomposition rules were preserved in the brief; the README is generated from it. The closeout guide references the renderer's help/template instead of maintaining its own section enumeration.

- **Testing evidence stays explicit.** Keep accurate source-to-test navigation declarations, production-path regression tests, demonstrated behavioral mutations and the broad suite. Do not build a universal execution/mutation-certification gate merely to satisfy packet 21. A header or import relationship still does not prove that a test executes or asserts a changed behavior; the proposed general refusal of unrelated/nonexecuting named tests is not implemented. This is a deliberate simplification, revisitable if actual missed coverage justifies the extra mechanism.
- **Keep validation at distinct trust boundaries.** Do not add packet 27's internal receipt cache without evidence that repeated validation is a material cost. Computing a safe receipt would still traverse/hash the result, task and line-index context, while adding stale-authority risk. This is an architectural judgment, not a measured speedup claim. Raw input, resumed work and accepted artifacts retain their existing validation boundaries.
- **One evaluator owns each gate outcome.** Each contract cross-gate returns applicability, skipped reason and issues together; the runner only wires inputs in canonical order. Empty applicable inputs remain evaluated clean where the prior contract said so. Snapshot retention remains consumer-specific: audit stages snapshots in its fold transaction, while remediation retains baseline evidence across stale reauthoring and drops it at intentional input destruction. Existing shared projection/JSON primitives are sufficient for that common mechanism.
- **Current review authority is strict and separate from reporting.** Required audit reviews use a versioned, schema-validated current-binding map and content-bound prompt assets. The append-only reporting ledger cannot restore an old authority after corruption. Missing/corrupt authority requires re-emission; real IO failures remain visible. Review declarations describe a host's claimed context and never certify a model or person's identity. An identical rendered task and canonical semantic/structural input projection may reuse a matching design review across runs once the tool has freshly minted current authority; a stale response alone cannot establish that authority. This does not promise a newly executed human or host review on every run. Design-review identity retains the existing projection policy, which excludes per-file byte hashes and provenance timestamps; it is not an all-repository-bytes identity. Per-run consent and confirmed review selection remain separate, fresh authorities.

- **Review authority follows the current task, including changes while a reply is in flight.** A valid response to an earlier prompt cannot approve a newer carried state merely because the earlier prompt file still exists. Issuance binds the semantic task revision into both the prompt digest and current binding; application compares it against the live carried input before accepting the domain result. Design-review task identity includes effective lenses, conceptual depth and selected reviewers, linked charter accounts and graph-degradation limitations. Cosmetic timestamps and equivalent normalized choices do not force new review. Contract and conceptual identities remain separate so conceptual-only changes do not reopen unrelated contract work.
- **Completed reviews need current snapshot evidence.** The snapshot format advances to include the same task context as in-flight review acceptance. A completed flag with missing or discarded old-format evidence now requires re-review. This deliberately trades a one-time renewed review in older sessions for avoiding a false completion claim; it does not discard their underlying findings or source artifacts.

- **Agent instructions use a stable canonical pointer.** Keep the opening link from `AGENTS.md` to the live `CLAUDE.md`; remove the redundant generated region carrying its byte count, source revision and body hash. The guard now checks the active opening link and a nonempty canonical target, so ordinary instruction edits do not demand an external regeneration. This deliberately replaces the old metadata-freshness rule, not the instruction authority. Machine-global synchronization was not changed or verified and may append metadata again; such metadata is not the guard's authority. Restoring the old synchronization model is possible, but would restore its recurring maintenance cost.

### Focused regression evidence

- Shared vocabulary/projection refactoring: five focused files, 148 tests passed.
- Traversal, actual tooling hashing/artifact validation, and philosophy/closeout rendering: six files, 74 tests passed. The added input-root EACCES test first failed with a missing expected rejection, then passed after narrowing error handling.
- Packet 15 / M44's stale assertion was refuted experimentally: removing only the e2e command-shape guard made the real close execute its command, report e2e success and complete; the existing test failed on the expected triage state. Restoring the guard passed. No new execution seam was necessary, and the temporary mutation was fully reversed.
- Functional preflight: six tests passed. Removing its entry guard emitted `critical_flow_fallback` instead; removing argument validation silently accepted unsupported `--model`. Both mutations were reversed and the same tests passed.
- Prompt-contract registry: 72 tests passed, including actual driver/dispatch renderers, full installation choices, and schema-valid preflight/review examples.
- Packet 15 / M49 now exercises a real accepted-result collision with different full prompt digests sharing the same derived-ID prefix. The in-scan duplicate-result check is asserted specifically; disabling that guard fails even though the later duplicate-write defense still exists. Restoring it passed.
- Packet 26 evaluator consolidation: build and test typechecking passed; eight focused files passed all 366 tests. Changing only a malformed-input outcome from skipped to evaluated-clean failed the new classification test; restoration passed. Two older fixtures were migrated honestly to the intended stricter contracts: a named counterexample needs its source, and a judge self-check needs its current independent-review envelope.


- Shared artifact-tree hold: seven focused files passed all 43 tests after moving the sole acquisition surface into shared IO. Preflight and consent now inherit the same 120-second waiter window as folding; stale-lock detection and heartbeat are unchanged.

- Consumer bootstrap/guard integration: six files passed 32 tests after preserving the canonical instruction pointer, actual generated host assets, catalog-driven single-pack ordering, sorted loop-core patterns and direct lock-owner instrumentation.
- Packaged-smoke fixture isolation: a real regression first showed root discovery choosing an owned parent repository instead of the fixture. Giving the fixture its own Git repository and tracked sources passed the unchanged real installer/legacy-cleanup flow; two files passed four tests. No ambient temporary-directory state was deleted.
- Review input completeness: a changed surface beyond the 20-entry prompt summary originally left both the contract prompt binding and deep conceptual round unchanged. Both regressions failed before the fix. Binding the shared context to the existing complete semantic projection fixed them while preserving timestamp-only reuse; five files passed 99 tests. The structural projection policy itself was not widened; the task-specific inputs described above are bound separately.

- Current-carried-state acceptance regressions demonstrated stale replies being accepted before any re-emission in contract, shallow conceptual and deep conceptual paths. Further production-path cases identified changed effective review depth/lenses and charter purpose/confidence. A perspective-count fixture was corrected from equivalent counts 1→2 to materially different counts 1→3; the former is not defect evidence. Completed-snapshot migration tests separately demonstrated that discarding old snapshot formats had incorrectly left completed flags satisfied. A changed graph-degradation limitation also demonstrated a false-fresh snapshot. The corrected acceptance, task identity, snapshot migration, charter/systemic lanes and actual publication-lock observation passed all 129 tests across eight focused files. The full-suite result above includes the final correction.

- Systemic pending-review identity was separately corrected to include the actual current rendered task and derived metrics without changing loop-history identity. Real carried contract/conceptual finding changes first demonstrated stale acceptance; the correction refused both and preserved the timestamp-only control.

Focused evidence supplements the full-suite and installation results above. It does not certify unavailable external environments or model behavior.
