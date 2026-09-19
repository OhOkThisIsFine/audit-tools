<!-- review-routing: backlog-forward -->

# Complete backlog remediation and implementation plan

## Baseline and execution rules

**Preparation update:** packet 1's plan and inventory are saved. Packet 2 completed on 2026-09-19: the existing v0.52.3 publication run succeeded, registry availability was checked, and global installation, host assets, and both binaries passed. Do not publish or bump again for that packet. Start implementation at packet 3. The unfinished triage edits were preserved at stash commit `8442913f83e8818c3f3a878ce45b9c0a79b31cea`, with independent backups and restoration instructions in `C:/Code/audit-tools/.audit-tools/recovery/2026-09-19/README.md`. The baseline statements below describe the planning snapshot, not a request to restore its dirty state.

This plan covers **203 backlog entries**, **four unresolved nightly items**, and **52 older decision records**. GitHub currently has no open issues or pull requests.

The source baseline is `787f7320d74dff7c21a0b46b660248a28acbfebd`, version **0.52.3**. Publication failed on npm maintenance errors; the version was not available from the registry when checked.

The working checkout contains unrelated changes to nightly documentation, triage code, and two tests. Preserve them. Start implementation in an isolated worktree from the baseline.

**Settled decisions**

- Audits leave source files unchanged by default. Formatting requires explicit per-run opt-in; dry-run always prevents source changes.
- Analyzer grants and declines apply only to the current run.
- Independent-review requirements cannot silently become self-review.
- Product tooling does not regain retired provider routing, quota management, branch creation, or branch landing.
- Staleness remains correctness-driven. Explain and measure expensive cascades; do not suppress them for convenience.
- Existing safeguards remain effective while their duplicated configuration is consolidated.
- References and accepted limitations are not implementation defects.

**How to execute**

Run the numbered packets below sequentially. Each packet is a separately reviewable change. Run its focused acceptance tests, then the repository’s required landing checks. A failed packet blocks dependent packets; external publication or GUI prerequisites do not block unrelated work.

This plan and its companion frozen inventory are saved under `docs/reviews/`, the repository's existing home for dated planning records. The inventory contains each entry's original title, source file, disposition and packet. Record completion evidence there as packets land; the IDs remain stable when live entries are removed or reordered.

For coverage below, `O`, `M`, `F`, `D`, and `T` mean entries in source order in open bugs, minor bugs, forward tracks, deferred work, and durable traps respectively. Forward-track numbering includes the four introductory tracks.

## Ordered implementation packets

### 1. Establish the implementation baseline

**Change:** Create the isolated lap, record the baseline SHA and existing checkout changes, and save the plan and frozen inventory. Keep verified fixes separate from remaining defects within compound entries.

**Acceptance:** Every one of the 203 entries maps to a packet, verified completion, accepted limitation, watch, or external dependency. Do not mark anything complete merely because its backlog text disappeared.

### 2. Recover the existing v0.52.3 publication

**Change:** Resume the existing release’s observation/completion path. Retry the failed publication for the existing tag and SHA after registry recovery. Do not calculate another version, recreate the release, or forward-bump to escape the failure.

Use the existing release journal and `finishGlobalInstall` completion path.

**Acceptance:**

- Registry version and integrity match the existing release.
- Global installation, permitted lifecycle scripts, both binaries, and installed host assets pass their existing smokes.
- Re-entry performs no duplicate destructive creation.
- If npm remains unavailable, record the external blocker and continue with packet 3.

The post-bump resume defect and global-install implementation are already fixed; this packet is operational recovery.

### 3. Correct shared contract fields

**Covers:** O06, O46, M47.

**Change:**

- Add optional string `rationale` to `IntentEquivalenceVerdictSchema`.
- Preserve `concrete_change`, `preconditions`, `expected_changes`, and `addresses_counterexamples` through `FindingSchema`, report promotion, assignment construction, and host workload serialization. Reuse their producer-owned schemas.
- Remove unused `RemediationPlanSchema.themes`; retain the live `filters.themes` feature.

**Acceptance:** Production-path round trips preserve all four finding fields. Legacy findings without optional fields remain valid; malformed fields fail. Equivalence rationale is accepted. The removed top-level `themes` property is rejected under the strict schema.

Apply the existing contract-version policy wherever the accepted wire contract changes.

### 4. Honor conceptual-review choices exactly

**Covers:** O04, O05.

**Change:** Update `IntentCheckpointSchema` and `resolveConceptualReviewSettings`.

- A present `design_review` block with missing or mismatched `answered_at` returns to confirmation instead of selecting shallow review.
- An absent block retains existing defaults.
- Support integer perspective counts, explicit built-in names, and custom `{name, lens}` definitions.
- Preserve legacy count selection. An explicit named list selects exactly those perspectives; do not inject additional defaults.
- Reject unknown names, duplicates, and custom-name collisions.
- Explicit perspective selection must not disappear through a shallow default.

**Acceptance:** Tests cover missing/stale provenance, re-confirmation, absent settings, legacy counts, exact named selection, custom selection, invalid names, and resumed runs retaining the confirmed choice.

### 5. Make audit mutation and analyzer consent explicit

**Covers:** F03, O07, remaining O20 consent work.

**Change:**

- Default the auto-fix executor to disabled unless the current run explicitly enables it.
- Preserve opt-in formatter execution and dry-run precedence.
- Remove durable grant/decline reads and writes from consent decisions. Preserve unrelated analyzer configuration.
- Bind consent tokens to the current run and retain the existing `admitSpawn` boundary.
- Make prompts explicitly ask the operator about installation and source mutation.
- Update philosophy and user documentation to state the same default.

**Acceptance:** Default audits leave fixture source bytes unchanged; opted-in audits format; dry-run never formats. A second run asks again after either a grant or decline. Old policy files cannot authorize or veto the new run.

### 6. Gate remediation in arbitrary repositories

**Covers:** O01.

**Change:** Replace the audit-tools-only exemption in `toolOwnedFinalGateCommands` and `runToolOwnedFinalGate`.

- Reuse `discoverProjectCommands`; extend its result with a typecheck role.
- Recognize explicit `typecheck` and `check:types` scripts without interpreting arbitrary `check` scripts as typechecking.
- Preserve existing ecosystem command discovery.
- Bind the resolved repository root, commands, and discovery inputs to the run.
- Execute declared build, typecheck, lint, and test roles in that order at phase boundaries and before close.
- Preserve audit-tools’ own gate profile.
- Use an explicitly supplied test command for the test role without dropping other declared checks.
- When no executable gate is derivable, emit an operator decision requiring an explicit command or a stop. Never report `scoped_out` as success.
- Re-resolve when the bound command declarations change.

**Acceptance:** Drive real fixture remediations through boundary and final gates for npm and existing supported fallback ecosystems. Cover no commands, explicit override, failing command, changed manifest, and successful recovery. Gate failure must preserve work and emit the existing resumable red state.

### 7. Establish Prompt Contract v1 primitives

**Covers:** O03 foundation.

**Change:** Extend the existing prompt registry with explicit worker, driver, and dispatch profiles. Add small shared renderers for exact paths, closed values, actor ownership, continuation, and stopping.

Forward `RemediationStep.access` through `WriteStepInput` and the shared step writer. A rendered input path must be present in the emitted read scope.

**Acceptance:** Registry tests check actor, immediate action, readable inputs, output path, required fields, complete enums, validation command where available, terminal instruction, and fallback semantics. Driver prompts no longer escape coverage merely because they lack a worker-result schema.

Do not introduce a general prompt language or another independently authored schema.

### 8. Supply missing prompt evidence

**Covers:** O03 P1 ambiguity and critical-flow defects.

**Change:**

- Build an ambiguity-review packet containing the relevant finding descriptions, evidence, confidence, and candidates. Bind its exact path and read access. Re-emission after refusal retains the packet and adds the refusal reason.
- Pass the real critical-flow artifact path into `renderCriticalFlowFallbackPrompt`. Bind the complete artifact rather than referring to a guessed filename after the first 80 flows.

**Acceptance:** Exercise actual step emitters, including custom artifact directories, 80/81-flow boundaries, missing inputs, ambiguity repair, and scope declarations. Every requested fact is rendered or readable at a bound path.

### 9. Separate operator decisions from preparation

**Covers:** O03 P1 confirmation and capability preflight.

**Change:**

- Precompute deterministic confirmation facts before emitting `confirm_intent`.
- Give that driver one immediate responsibility: obtain and record the operator’s choices.
- Move capability checking out of loader prose into an explicit step describing functional needs and the evidence the host must return.
- Keep loaders as workflow entry points.
- Scope audit-tools development instructions to audit-tools itself.
- Reject unsupported arguments mechanically rather than asking the host to avoid them.

**Acceptance:** Third-party runs receive no audit-tools development instructions. Confirmation contains complete choices and required fields. Unavailable required capabilities produce an explicit stop or supported fallback, not an unrecorded downgrade.

### 10. Make fan-out requirements and demand reliable

**Covers:** O28, O49, F01, O03 independence metadata.

**Change:**

- Share the independence requirement between audit and remediation prompts.
- Define each lane as ordinary, independence-required, or explicitly permitted degraded review.
- Record declared review mode and reason in bound transport metadata. Do not claim tooling can prove host independence.
- Required independent review pauses when unavailable.
- Require meaningful demand inputs at every `materializeFanoutLanes` call.
- Include granted packet content and file counts, not just short pointer-prompt length.
- Apply shared semantic complexity/risk floors to charter, conceptual, contract, and second-order work.
- Keep rankings provider-neutral.

Migrate all eight audit emitters: contract dispatch, charter extraction/comparison/fidelity, systemic challenge, edge reasoning, critical-flow fallback, and synthesis narrative.

**Acceptance:** Each production emitter reports meaningful demand. A short prompt pointing at a large packet is not classified as small by default. Required independent review never accepts a self-review fallback.

### 11. Finish the remaining prompt migrations

**Covers:** O03 P2.

**Change:**

- Make `guidanceBootstrap` the owner of guidance-file creation and selection.
- Render extracted-plan repair as a driver with exact paths and continuation.
- Explain that triage `halt` stops the whole run, including the disposition of unresolved and omitted items.
- Use testimony-only examples for stated charter, declarations for structural charter, and code behavior for revealed charter.
- Name the operator as the installation decision-maker.
- Remove mechanism terminology and implementation commentary from user-facing workflow instructions.

**Acceptance:** Render examples through their real validators and lane-specific evidence rules. Retain tool ownership of `created_at` and `reviewed_clean`; do not restore either to worker output requirements.

### 12. Make host acceptance atomic and retry-safe

**Covers:** O19 binding race, M05.

**Change:**

- Put audit workload, task bindings, and result-map publication under the accepted-results lock.
- Read a coherent binding set during ingestion under that same synchronization boundary.
- In `recordLaneOutcome`, suppress only a duplicate accepted append. Always perform the idempotent expected-set removal, even if the accepted event already exists.
- Preserve accepted work across partial ingestion and retries.

**Acceptance:** Inject failure between accepted append and expected-set removal. Retry yields one accepted event and no stale expected item. Test concurrent preparation/ingestion, accepted→rejected→retry, partial waves, and stale result rejection.

### 13. Make handoff repair bounded and actionable

**Covers:** O19 repair residuals, T70–T71.

**Change:**

- Replace malformed FRONTIER and ordinary workload-digest throws with explicit repair/rebind steps.
- Reuse sanctioned binding regeneration; do not accept stale results to make progress.
- Bound required-test output in prompts while retaining the complete captured log.
- Preserve the canonical expected identity during repairs.
- Route unsupported repair requests to the owning upstream step rather than suggesting the opposite direction or an impossible local edit.
- Keep accepted-with-issues distinct from genuinely pending work.

**Acceptance:** Production handoff tests cover malformed frontier, changed scope/prompt, ordinary rebind, invalid repair identity, upstream-only repair, bounded error excerpts, and preserved accepted ledger entries.

### 14. Persist operator lifecycle actions

**Covers:** O31.

**Change:** Add explicit plan-only, pause, resume, and cancel transitions through the remediation CLI and state store.

- Plan-only finishes planning and records a paused continuation before implementation.
- Pause records the current item, binding, phase, and exact continuation.
- Resume uses the saved continuation and skips accepted work.
- Cancel records a terminal cancellation and preserves artifacts.
- Record host-reported worktree location/outcome without taking ownership of branch creation or deletion.
- Keep existing clarification and gate-red recovery semantics.

**Acceptance:** Restart the process between each transition. Verify no accepted item reruns, no cancelled run advances, paused work retains its binding, and existing final-gate recovery still behaves identically.

### 15. Close the remaining production-path test gaps

**Covers:** O22 drain test, M44, M45, M49.

**Change and acceptance:**

- **Deferred drain:** Start with a nonempty deferred slice set. A changed upstream slice makes downstream work execute before drain completion; an unchanged slice does not. Removing bundle refresh must fail the test.
- **E2E refusal:** Supply a genuinely discoverable e2e command and a spawn seam. The intended guard refuses before spawn; inverting that guard reaches the canary.
- **Old workload version:** Enter through the public dispatch path. Old input is refused, then reminted with the current contract and coherent bindings; repeat preparation is idempotent.
- **Duplicate submission ID:** Retain the defensive guard. Use distinct full prompt digests with the same 12-character prefix and an existing accepted binding; assert `duplicate_submission_id`.

Do not redesign result IDs merely to remove the last branch.

### 16. Require semantic confirmation before promoting graph leads

**Covers:** O32.

**Change:** In `mergeFindings`, separate deterministic lineage-bearing leads from semantic findings.

Admit a deterministic lead to the final report only when a semantic finding confirms its canonical identity. Attach the original producer lineage and evidence through tooling. Leave unconfirmed leads in analysis artifacts.

**Acceptance:** A lead alone is absent from final findings; matching confirmation preserves lineage and evidence; unrelated findings do not confirm it; submitted results cannot forge tool lineage; ordinary nonheuristic findings remain unaffected.

### 17. Add opt-in per-result contract conformance review

**Covers:** O39.

**Change:** Add a per-run conformance-review option, disabled by default.

After mechanical validation and before acceptance, emit a bounded independent review of the result’s obligation evidence against the carried module contracts. Bind it to the result, obligation set, and contract content.

Passing review permits acceptance. Insufficient evidence returns a repair step. Unavailable required review pauses. Changed result or contract content invalidates the review.

**Acceptance:** Test default-off behavior, successful review, insufficient evidence, unavailable reviewer, stale review binding, and correction followed by acceptance. The reviewer cannot bypass mechanical obligation coverage.

### 18. Fix supported framework route extraction

**Covers:** O23 route residuals.

**Change:** Extend `graphRoutes` to read supported Vue/Svelte/Astro script regions and trace Python sibling-router imports before route registration.

Keep extraction bounded and resolve imported router identities rather than matching unrelated marker text.

**Acceptance:** Public extractor fixtures cover sibling imports, aliases, actual router registration, unrelated imports, component script regions, comments/non-script content, and existing JavaScript/TypeScript cases.

The old charter-type portion of O23 is superseded by charter-register/v5.

### 19. Remove the remaining quadratic scanner paths

**Covers:** M27.

**Change:**

- Parse Python alias suffixes and trailing slashes with backward scans.
- Trim classification token edges with two pointers.
- Scan affirmative global-review clauses once instead of repeatedly splitting prefixes.
- Replace route local-name whitespace/alias splitting with a single pass.
- Trim route edge slashes with two pointers.

Preserve existing case, delimiter, negation, alias, and punctuation semantics.

**Acceptance:** Run public extractors/classifiers on growing malformed whitespace, slash, punctuation, identifier, and repeated-clause inputs. Use semantic expected outputs plus bounded subprocess ceilings. Reverting the vulnerable logic must fail the regression. Do not use fragile timing ratios as the only oracle.

### 20. Enforce contracts at actual producer boundaries

**Covers:** M28.

**Change:** Replace claims of complete construction-site coverage with enforcement at canonical serialized-output boundaries.

Validate producer output against its owning schema. Add integration fixtures for actual producers and negative cases omitting required fields. Retain construction markers only as a truthful census aid.

**Acceptance:** A real producer emitting malformed output fails before persistence or downstream acceptance. A marker alone cannot satisfy contract enforcement. Do not introduce another unsound generic object-construction detector.

### 21. Connect changed code to meaningful tests

**Covers:** O11, O29, O36.

**Change:**

- Share a source-to-test ownership map between change checks and pin obligations.
- Use actual execution coverage to establish whether a named test reaches the relevant changed site.
- Treat execution reach and behavioral proof as separate evidence.
- Require the behavioral regression to fail when the fix is inverted; compilation/import failures are not behavioral proof.
- Use the broader suite where ownership is unresolved.
- Sweep existing test replicas in bounded subsystem batches, replacing copied subject logic with calls through production interfaces. Preserve independent oracles and useful fixtures.

**Acceptance:** The gate rejects unrelated named tests and tests that never execute the subject. Its diagnostics explicitly distinguish missing reach from missing behavioral evidence. Every replaced replica has a demonstrated production-path regression.

Do not advertise author-supplied names or import relationships as proof of assertions.

### 22. Introduce one executable gate catalog

**Covers:** O12, F02 governance B/E.

**Change:** One ordered declaration owns identity, command, release order, reach, pre-commit policy, and concise remedy.

Derive release execution, pre-commit legs, and CI paths from it. Preserve existing fail-fast behavior and load-bearing build/smoke order. Remove parity mechanisms whose only subject is duplicate gate membership.

Move historical narrative out of executable metadata while retaining positive forms and honest uncovered statements.

**Acceptance:** Adding a fixture gate in one declaration reaches all consumers. Existing gates retain their command order and trigger behavior. Full gate and release-smoke checks pass.

### 23. Consolidate backlog and document-pin checks

**Covers:** F02 governance C/D, ceremony F4/F5.

**Change:**

- Parse the backlog once and run its budget/property, status, line-citation, and friction validators over that representation.
- Make the generated index use the same parser.
- Fold `DOC_TEST_CONSUMERS` into the existing pin-obligation declaration.
- Retain tracked-subject/test checks, nonempty consumers, and build-free pre-commit execution.
- Remove the redundant document-consumer registry and its configuration-only checker.

**Acceptance:** Each existing refusal class still has a distinct diagnostic. A staged mapped document still requires its tests. Index generation and validation agree on entry boundaries.

### 24. Correct push context and aggregate attestations

**Covers:** O02, O48 residual, M46, ceremony F3.

**Change:**

- Resolve the actual push working directory and sent local ref/tree; never substitute `CLAUDE_PROJECT_DIR` for a worktree push.
- Check the corresponding full-suite stamp.
- Share constitutional and loop-core attestation mechanics while retaining their different policies.
- Report all missing attestation classes for the same staged tree in one deterministic refusal.

**Acceptance:** Main/worktree stamps cannot certify each other accidentally. Test explicit refspecs, worktree pushes, stale stamps, and both missing attestation classes together. Preserve native commit-creating-verb coverage and existing bypass policy.

### 25. Finish straightforward shared primitives

**Covers:** F02 CY02/05/06/13/14/15.

**Change:**

- Derive lens, severity, confidence, and consent vocabulary consumers from their canonical definitions.
- Share the existing duplicated file collection and interpreted-clause projection.
- Remove the reviewed pass-through aliases/wrappers where they add no distinct contract.
- Keep per-consumer policy separate.

**Acceptance:** Existing public outputs and refusal semantics remain unchanged. Boundary/import checks cover governance consumers as well as product source. Do not re-extract friction taxonomy, memory-directory handling, or installer plans; those are already shared.

### 26. Consolidate repeated evaluation and snapshot mechanisms

**Covers:** F02 CY04/CY07/CY11.

**Change:**

- Have contract evaluation return applicability, reason, and issues together instead of separately maintained `canEvaluate*` logic.
- Share snapshot storage/lifecycle primitives while preserving each draw’s retention policy.
- Share graph reachability with one supplied edge-traversal predicate; keep audit/remediation staleness policies outside it.

**Acceptance:** Evaluation refusal reasons, retained review baselines, deferred edges, legacy migration behavior, and changed/unchanged slice handling remain identical. No unconditional snapshot deletion or staleness weakening.

### 27. Avoid duplicate validation only with trusted receipts

**Covers:** F02 CY09.

**Change:** Mint an internal validation receipt after successful validation, binding result content, canonical task manifest, and effective line index.

Reuse validation only for an exact receipt match. Missing receipts, changed contexts, old ledger entries, and raw CLI input follow normal validation. Host-submitted receipt claims have no authority.

**Acceptance:** Same result/context validates once. Changed task, line counts, result bytes, raw input, and old ledger entries validate again. Failed validation never creates a receipt. Warnings still appear exactly once.

### 28. Finish nightly normalization and counters together

**Covers:** Nightly `2eefa66ab7c9bd64`, `98f93995eb770e05`.

**Change:**

- Use one `finishTriageRecord` path for new and revived records.
- Apply identity, premise, path classification, and final downgrade in that order.
- Restore unresolved guessed values before normalizing revived records.
- Centralize all five premise classes: `holds`, `partial`, `premise_unconfirmed`, `probes_unusable`, `unprobed`.
- Count revived retained records and newly produced records exactly once.
- Keep invocation attempt counts separate from persisted classified totals.

Integrate the existing partial work rather than replacing it.

**Acceptance:** Tests enter through actual dispatch/revival callbacks. Cover every class, mixed new/revived records, zero-new-item resume, rejected records, and repeated normalization. Class totals equal the complete classified population.

### 29. Fix nightly document ownership and queue projections

**Covers:** Nightly `3684f87dc7e59c32`, `1fb2934333c59d31`; M08, M14, M43.

**Change:**

- Keep review guidelines about review content; move surfacing and HTML presentation instructions to the routine.
- Replace named first/second lane prescriptions with required capabilities and explicit unavailable coverage.
- Clarify that a dirty tree blocks review-derived document edits, while routine-owned generated outputs still update.
- Report HANDOFF regeneration failure after queue writes; preserve the successful queue write.
- Prune deleted/retired documents from the scope ledger using the canonical in-scope manifest.

**Acceptance:** Queue-write/regeneration failure is visible without losing data. Deleted and renamed documents leave no obsolete scope entries. Re-running is idempotent. Dirty-tree documentation clearly identifies both write classes.

### 30. Derive handoff state and remove duplicate prose authorities

**Covers:** M04, M36, M38; F02 C03/C05.

**Change:**

- Generate immediate-next references from live work records.
- Keep derivable state out of free-form HANDOFF text; reserve prose for decisions, context, deliberate intermediate state, and unrecorded verification claims.
- Do not put live registry availability into tracked canonical state.
- Remove the dated “~21%” measurement from routine prose.
- Replace the philosophy PART A/B restatement with a concept-to-canonical-home link table. Preserve otherwise homeless rules in the brief using current host-owned execution language.
- Replace the closeout template’s duplicated section enumeration with pointers to the renderer’s help/template output.
- Regenerate README from the philosophy brief.

**Acceptance:** Closing or removing a work item updates immediate-next without manual narration. Existing generated session facts remain authoritative. Philosophy generation, links, citations, and closeout renderer tests pass.

### 31. Consolidate hook preambles and close bounded guard gaps

**Covers:** F02 F6, O47, T44, T75, T89.

**Change:**

- Share Stop-gate input/root/error preamble mechanics; retain individual policy.
- Extend the barrel-spy check across the entire test tree.
- Integrate `isRecordPath` into the actual record-writing path.
- Distinguish optional unavailable-path handling (`ENOENT`/`ENOTDIR`) from strict reads; preserve permission, directory, and parse errors.
- Extend masked-exit coverage to the named missing commands: `gh pr merge`, `gh release create`, `npm version`, `docker push`, and `terraform apply`. Keep the registry’s coverage claim explicitly curated.

**Acceptance:** Bad barrel spies fail in audit, remediation, and shared tests. Record-path rules agree on Windows paths. Optional missing paths are tolerated; real errors propagate. Both pipelines and background laundering catch the added command families while read-only commands remain admitted.

### 32. Parse failed lane envelopes without losing diagnostics

**Covers:** M48.

**Change:** Recognize the complete structured response envelope before any trailing CLI advice. Prefer the existing structured protocol; for text output, scan JSON boundaries with correct string/escape/nesting handling.

Keep response payload and trailing diagnostic text separate. Do not unwrap arbitrary unrelated JSON.

**Acceptance:** Cover failed envelopes, escaped braces, nested objects, trailing advice, malformed/truncated JSON, successful output, and plain text.

### 33. Detect newly created ignored root logs

**Covers:** O41.

**Change:** Add a bounded pre/post inventory for ignored root log outputs around host execution. Exclude sanctioned artifact destinations and report only newly created relevant logs.

Preserve pre-existing files and other sessions’ work. Do not restore the retired general root-entry cleanup.

**Acceptance:** New ignored logs are reported; old logs and sanctioned artifacts are not. Scope corroboration tests prove no automatic deletion occurs.

### 34. Extract only the verified mixed responsibilities

**Covers:** Governance review’s maintainability finding.

**Change:** After the preceding behavior changes settle, extract recovery, friction closeout, path-A disposition, and intent-persistence responsibilities from remediation `nextStep`, and corroboration/test-rerun/recovery responsibilities from host ingestion.

Keep orchestration and mutation order explicit. Do not split cohesive modules because of line count.

**Acceptance:** Production lifecycle and ingestion tests pass unchanged; import boundaries remain sound; extracted modules have real production consumers. This packet adds no new behavior.

### 35. Measure the remaining performance tail

**Covers:** O08, O30, O44; F07 coordination.

**Change:** Reuse existing bounded-child deadlines, child attribution, and synchronous-spawn timing. Produce a repeatable profile identifying subprocess duration, synchronous blocking, and repeated command work.

Keep the separately assigned CI shard work with its existing owner; consume its results instead of creating a competing implementation.

**Acceptance:** A slow command is attributable to a concrete child or measured synchronous phase, with a complete log and bounded termination. Preserve isolation and existing deadline behavior.

The historical leaked-child defect is closed. Unobserved performance causes remain an evidence watch, not a speculative optimization mandate.

### 36. Complete live workflow validation

**Covers:** O45, M31, F06, D01, D02; existing smoke confirmation.

Run these bounded scenarios:

1. Two consecutive completed audits: friction is archived before cleanup; failed archival preserves artifacts; the second run cannot reuse the first run’s record.
2. Selective deepening: partial acceptance, workers still in flight, pending deepening tasks, repeated continuation, and convergence.
3. Rust and Ruby fixtures with known violations: consented clippy/rubocop actually spawn and normalize leads; corrected fixtures produce clean results.
4. Tiny audit and remediation flows through Antigravity, OpenCode, and VS Code; verify artifact paths, actual ingestion, and OpenCode child permission propagation.

**Acceptance:** Record host/tool versions, commands, outputs, result paths, and observed outcome. Installer/unit smokes are not substitutes for GUI validation. Missing hosts or toolchains remain explicitly blocked validation rows.

### 37. Measure staleness cost before adding narrower semantics

**Covers:** M29, D03.

**Change:** Record the upstream semantic change, affected dependency edges, rederived artifacts, elapsed work, and supplied context volume during representative prose-heavy changes.

Distinguish actual usage from estimates. Preserve existing DD-9 normalization and whole-manifest challenge behavior.

**Acceptance:** Deliver a reproducible cascade-cost record identifying whether any remaining prose artifact causes unnecessary invalidation. If no such case is observed, retain the existing policy and close the measurement task without inventing an equivalence cache.

### 38. Reconcile stale backlog, traps, and historical decisions

**Covers:** Verified-complete items below, O10, F02 C11, durable traps, older ledger.

**Change:**

- Remove source-verified completed entries after the corresponding existing regressions and final gates pass.
- Correct retired router, worktree, telemetry, lane capability, token-limit, and memory-locking advice.
- Preserve standing limitations and useful environment guidance.
- Backfill 51 historical decision records as satisfied or superseded with their existing evidence.
- For `47086e76d3fac438`, perform the still-unverified semantic review of unregistered directories under sanctioned/legacy worktree roots. Record ownership, unique changes, commit reachability, and retain/archive/teardown eligibility. Unknown ownership or unique work means retain.
- Do not delete directories in this reconciliation packet; owning closeout policy controls teardown.

Do not recreate the retired quote scanner, generated nightly prompt, `llm-call` helper, transient verdict registration, or product-owned branch landing.

### 39. Validate and finish the sequence

Run the complete repository checks, suite, package smokes, and host-install smokes against the final committed tree. Finish the authorized landing/release pipeline through live verification and global installation.

Regenerate backlog projections and current handoff state. Close only rows whose specified acceptance evidence exists. Keep external/manual validation and recurrence watches explicitly named.

## Complete item disposition

### Open bugs

| Entries | Disposition |
|---|---|
| O01–O07 | Packets 3–11 as identified above |
| O08 | Packet 35; child-leak fix already shipped |
| O09 | Verify existing comment-drift regressions, then remove |
| O10–O12 | Packets 38, 21, 22 respectively |
| O13 | Declared exclusions are now checked; preserve the documented mixed-consumer discovery limit |
| O14 | Incoming-content routing already fixed; retain native merge/cherry-pick/revert/am requirements |
| O15 | Structured abstention satisfies the safety property; retain staged/worktree and external-state prediction limits |
| O16–O18 | Existing shell-parser, command-shape, archival, clarification, heartbeat, and event-family fixes: verify and remove |
| O19 | Packets 12–13 |
| O20 | Root propagation, cache creation and test isolation fixed; consent remainder in packet 5 |
| O21 | Third-state and affinity handling fixed; retain the intentional derived-set accessor contract |
| O22 | Remaining drain regression in packet 15; other subparts fixed |
| O23 | Route work in packet 18; old charter architecture superseded |
| O24–O27 | Guard, source-generator, glossary scope, and coherence measurement fixes verified; remove stale entries |
| O28–O32 | Packets 10, 21, 35, 14, 16 respectively |
| O33–O35 | Attribution, mechanical result validation, and shared provenanced recon already implemented |
| O36 | Packet 21 |
| O37 | In-flight release waiting fixed; retain external lane lessons only where current |
| O38 | Version-only suite-stamp preservation already implemented with strict identity checks |
| O39 | Packet 17 |
| O40 | Staleness cause/rederivation notices already implemented |
| O41 | Packet 33 |
| O42–O43 | Typed harness return, installer/path guards, and required validation root already fixed |
| O44–O49 | Packets 35, 36, 3, 31, 24, 10 respectively |

### Minor bugs

| Entries | Disposition |
|---|---|
| M01 | Evidence watch for unknown file producer; do not restore root teardown |
| M02–M03 | Citation deletion checks and in-flight release waiting fixed |
| M04–M05 | Packets 30 and 12 |
| M06–M07 | Engine bound and release wait fixed |
| M08–M09 | Packet 29; native subset intake below |
| M10–M13 | Advisory carry, version seed handling, reviewer residuals, and friction path fixed |
| M14 | Packet 29 |
| M15–M26 | Recovery invalidation/no-write, phase binding, CLI coverage, staleness, pending exit, citations, subject keys, HANDOFF projection, retained snapshots, clause splitting, and checkpoint answers fixed |
| M27–M28 | Packets 19 and 20 |
| M29 | Packet 37 |
| M30 | Original false category fixed; recurrence watch only |
| M31 | Packet 36 |
| M32 | Premise-bound systemic counter behavior is intentional and implemented |
| M33–M35 | Heartbeat and severity calibration fixed; citation incident premise dissolved |
| M36–M38 | Packets 30 and 7–11; loader fragment consolidation already shipped |
| M39–M42 | Shared governance sources, memory citation direction, suite-status query, and preparse quarantine fixed |
| M43–M49 | Packets 29, 15, 15, 24, 3, 32, 15 respectively |

**Native subset intake for M09 — execute immediately after packet 4:** Add severity and finding-ID selection to intake, before report normalization, using `projectAuditFindingsReportSubset`. Severity selection and explicit IDs form a union; other existing scope filters intersect that draw. Unknown IDs refuse. Empty selection produces explicit no-work. Tests must preserve coherence components, work blocks, and top-risk references through the actual `--input` path.

### Forward and deferred tracks

| Entry | Disposition |
|---|---|
| F01 lane demand | Packet 10 |
| F02 ceremony review | Packets 22–31 and 38; already-shipped subparts are not repeated |
| F03 audit read-only default | Packet 5 |
| F04 production orphan detection | Existing mechanism; verify and retain alongside knip |
| F05 real remediation gate smoke | Existing smoke; extend arbitrary-repository coverage in packet 6 |
| F06 clippy/rubocop live validation | Packet 36 |
| F07 CI wall-clock | Existing external assignment; packet 35 coordinates |
| F08 scaffold mode | Fixed; preserve forced-step versus drain distinction |
| F09 obligation/module identity | Exact join fixed |
| F10 wave identity | Fixed; packet 12 preserves it |
| F11 isolated-branch landing | Superseded by explicit host-ownership decision; remove |
| F12 shared-core adapter residue | `runDir` and prompt identity fixed; no invented engine cap |
| F13 complete ship pipeline | Implemented; operational recovery in packet 2 |
| D01–D02 GUI/permission validation | Packet 36 |
| D03 staleness measurement | Packet 37 |

Within F02, CY01/03/08/12 and the previously completed enumeration, reach, native-hook, installer, taxonomy, and session-closeout work are verification-only. The remaining named CY/F/C recommendations have explicit packets above.

### Durable traps

These remain references unless a concrete correction is listed.

- **Documentation corrections in packet 38:** T05, T07, T09, T29, T33, T64, T67, T68, T72, T86.
- **Product/guard work:** T44 and T75 in packet 31; T70–T71 in packet 13; T89 in packet 31.
- **Machine-owned dependencies:** T05/T58 delegated lap ownership, T13 relay supervision, T25 relay capacity, T72 atomic memory writes, T73 memory-index limits. Route to their existing machine-wide home; do not implement them inside audit-tools.
- **Retain as current reference or explicit accepted limitation:** T01–T04, T06, T08, T10–T12, T14–T24, T26–T28, T30–T32, T34–T43, T45–T57, T59–T63, T65–T66, T69, T74, T76–T85, T87–T88.

For retained traps, completion means preserving the current property and removing obsolete operational wording—not manufacturing a code change.

## Completion criteria

The sequence is complete when:

- Every frozen inventory row has implementation evidence or an explicit verified/reference/watch/external disposition.
- Default audits are source-preserving; consent is per-run.
- Arbitrary repositories receive real boundary/final gates.
- Prompt contracts, handoff bindings, lifecycle recovery, and semantic promotion satisfy their production-path tests.
- Governance consumers derive from shared declarations without losing safeguards.
- Nightly counters and normalization handle revival correctly.
- The final committed tree passes required checks and the release pipeline reaches verified installation.
- Any unavailable GUI/toolchain validation, external assignment, or unresolved recurrence watch remains visibly open with its exact next procedure.

Saved from the approved conversation plan after Plan Mode ended. Completion and preservation details are recorded in the preparation closeout; implementation packets remain open unless explicitly evidenced there.
