# Prompt/process critique review — 2026-08-05

Input: owner critiques of four prompts from the 2026-08-05 dogfood run
([`dogfood-run-2026-08-05.md`](dogfood-run-2026-08-05.md), friction record
`.audit-tools/audit/friction/run.json`). Method: 15-agent verified sweep (2 catalog → 6
class-sweeps → adversarial verify per sweep → completeness critic; ~1.56M offloaded tokens).
60 raw findings → 43 confirmed, 3 corrected, 3 refuted (refutations kept, below); load-bearing
claims re-verified by hand against HEAD. All file:line cites are HEAD as of this date.

Problem classes (owner-named): **C1** fragile LLM-echo id joins; **C2** steps starved of context
that exists elsewhere in the pipeline; **C3** orchestrator fed subagent-only content instead of
capability-conditional prompt files; **C4** charter access-scope contradictions; **C5** force-fed
subsystem decomposition; **C6** run evidence of agent confusion.

## Verdicts on the four owner critiques

### 1. Critical-flow fallback — "EXACT id" echo (confirmed, and it is a class)

[`criticalFlowFallbackPrompt.ts:59`](../../src/audit/reporting/criticalFlowFallbackPrompt.ts)
asks the host to re-author a flow with its exact id; the return schema is `id: z.string()`
(`src/shared/types/flows.ts:10`) — no enum, no format, no collision check; the executor merges
whatever comes back. Same unguarded-echo shape recurs across **both** orchestrators (census below).

**Mechanical alternative (recommended):** stop asking for ids at all. Render the deterministic
flows as a numbered list; the agent returns per-flow *verdicts* — `{index, verdict:
confirm|correct|reject, patch}` — plus `new_flows` entries with no id. Schema validates `index`
against the list length (closed set, retry on mismatch); the tool re-attaches real ids by index
and mints ids for new flows. Zero echo, zero collision surface, one dispatch.

**On per-flow sequential feeding (the 87-prompts idea):** honest caching answer — with one
persistent agent and the flow varied at the *end* of the prompt, prefix caching does make
marginal cost ≈ per-flow suffix + output, so token burn is modest. But (a) the free-lane
providers that serve offload traffic don't uniformly honor prompt caching, (b) 87 round-trips is
87 latencies and 87 rate-limit exposures, and (c) it fixes attention dilution, not the echo
fragility — a per-flow prompt still asks for an id echo unless the contract changes. The
verdict-by-ordinal contract removes the fragility outright; then batch size becomes a pure
*quality* knob. If dilution is still a worry, chunk 10–20 flows per agent with a `count`
affirmation (the loader-truncation lesson from the run: never one unbounded list).

### 2. Scope confirmation starved of telos (confirmed; reorder is blocked, digest is not)

`buildLensPropositions` receives only unit manifest + paths + disposition — pure path heuristics
(`intentCheckpointExecutor.ts:209-321`, called at `:358`). `design_assessment` is *already in the
bundle* at that point (PRIORITY slot 8 vs. checkpoint slot 10, `nextStep.ts:34-36`) and is never
referenced (grep: 0 matches in the executor). That is exactly how the run got the factually wrong
"no logging/metrics surface" observability rationale beside a JSONL ledger.

**Charter before scope: no.** `charter_register` depends on `intent_checkpoint.json`
(`spec/audit/dependency-map.md:47`), and DD-9 deliberately holds charters below the checkpoint so
a pending prose judgment pauses the cascade. Inverting it would also spend charter tokens on
scope the owner may prune. **But two DAG-clean fixes exist:**
- **Thread `design_assessment` into `buildLensPropositions`** — zero reorder, one parameter;
  semantic findings validate/flip heuristic lens dispositions.
- **Insert a deterministic `docs_digest` artifact** (README/spec/CLAUDE.md telos extraction;
  depends only on repo_manifest + structure_decomposition, both earlier) and render it into the
  confirm-intent prompt. Cheap, acyclic, gives the scope decider the repo's stated purpose.

### 3. Orchestrator fed subagent-only content (confirmed; the design exists but only one step honors it)

The capability-conditional pattern is implemented correctly in exactly **one** place:
[`semanticReviewStep.ts:61-93`](../../src/audit/cli/semanticReviewStep.ts) branches on
`hostCanDispatch` — thin step + per-packet prompt files on disk when capable, inline when not. It
is documented **nowhere** (`spec/unified-dispatch-worker-model.md` covers worker kinds, not
orchestrator step rendering). Every other fan-out step ignores it:

| Step | Render site | Violation |
|---|---|---|
| charter extraction | `nextStepCommand.ts:709` | full 3-subagent instruction set inlined, no branch; **no per-kind prompt files are ever written** — the host improvises subagent prompts (the prompt-quality variance the owner observed is downstream of this) |
| charter delta | `nextStepCommand.ts:744` | same, no branch |
| design review (contract + conceptual) | `nextStepCommand.ts:608-685` | `prepareConceptualDispatch` never sees capability; output path prose-referenced, not materialized — the run's 5-of-8 artifact drift |
| critical-flow fallback | `nextStepCommand.ts:1095-1107` | ~340 lines of flow stubs inlined; digest + file pointer would carry it |
| synthesis narrative | `nextStepCommand.ts:1139-1151` | up to 120 findings inlined, silent-drop id join on return |
| remediate review-approval gate | `prompts.ts:158-227` | every finding body inlined; `prepareImplementDispatch` (`marshal.ts:401-414`) proves the file-writing pattern exists one layer down |

**Fix shape:** one shared "fan-out step" renderer that (a) branches on host capability, (b) writes
per-subagent prompt files (which also *materializes* output paths and access scopes instead of
prose), (c) validates each returned artifact at a per-lane chokepoint. (b)+(c) also close the
design-review drift and the improvised-charter-prompt variance in one move.

### 4. Charter access scopes + forced decomposition (confirmed with corrections)

- The canonical prompt itself seeds the doc-bleed: inferred = "subsystem's shape **+ docs**"
  ([`charterExtractionPrompt.ts:83`](../../src/audit/cli/charterExtractionPrompt.ts)). The
  verifier's correction is worth keeping: the JSDoc's independence claim is blindness to each
  other's *output*, not source isolation — but source isolation is what makes stated↔revealed
  deltas meaningful, and the run showed the collapse (comment-dense repos: headers ARE the stated
  intent).
- **Nothing enforces any scope.** `assembleCharters` validates node_id membership and
  one-charter-per-kind only (`charterExtraction.ts:224-286`); a revealed charter citing a README
  passes silently. Delta-miner independence is prompt text; `CharterRegister` records no
  authoring/mining identity, so the host merging all three sets and then "independently" mining
  them (as the run did) is undetectable.
- **Enforce scope by feeding, not by instruction:** materialize each kind's packet — stated gets
  docs + *extracted* comments; revealed gets *comment-stripped* code; inferred gets structure only
  (exports/signatures/graph, no bodies, no docs). Blindness becomes a property of the input, agent
  capability stops mattering, and the comment-dense collapse is fixed as a side effect (comments
  move INTO stated's evidence and OUT of revealed's).
- **Node naming:** `node_id = members[0]` — lexicographically first file
  (`consensus.ts:371`; deliberate, size-robust, union-order-stable). "Confident" = ≥2 behavior
  sources, majority F1 ≥ 0.5 across scales. The ids are sound as join keys and bad as *names*;
  agents were forced to infer subsystem meaning from member lists.
- **Owner's L0/L1/L2 self-organized teleology — sizing:** four consumers key on charter node_id
  (delta miner, clarification, design review, synthesis join). A full free-form-tree redesign
  makes every join semantic. **Middle path preserving determinism:** let each kind's agent
  self-organize its leveled teleology, but require every teleology node to carry its **file
  scope** — files are content-derived join keys no agent can mangle. The tool joins teleologies to
  decomposition nodes (and stated↔inferred↔revealed nodes to each other) mechanically by file-set
  overlap; delta mining pairs nodes by overlap and mines within pairs. Decomposition demotes from
  forced node list to optional scaffold hint. Cheap first stage regardless of direction: keep
  node_id for joins, add a human label to prompts.

## C1 census — every unguarded id-echo join found (verified)

Enforcement classes: (a) validating chokepoint, (b) fuzzy remap, (c) nothing/silent drop.

**audit-code, class (c):** flow id (`criticalFlowFallbackPrompt.ts:59`); systemic-challenge ids —
free-form, dedup keys on lens|category|title so cross-round id collisions pass
(`secondOrderAdversaryPrompt.ts:78`, `systemicChallengeLoop.ts:108-110`; the run's SC-001
collision); design-review finding ids + prose output paths (`designReviewPrompt.ts:349,558`);
synthesis narrative finding refs — *documented* silent drop ("unknown ids are dropped",
`synthesisNarrativePrompt.ts:41,75`); deepening tasks — "task_id MUST be exactly … copy it
verbatim" and file_coverage "copy exactly" (`packetPrompt.ts:271-276`; completeness-critic find).
**Class (a), healthy:** charter node_id membership, packet submit (`submitPacketCommand.ts:125-153`
— duplicate/unassigned/missing-task all throw; verified by hand), semantic-review dispatch
admission.

**remediate-code, class (c):** review-approval gate — declined ids looked up with silent
`continue` (`prompts.ts:176` → `nextStep.ts:4014-4023`); ambiguity gate (`nextStep.ts:4132-4133`);
triage — `validateTriageResolution` checks string-ness only, unknown ids no-op
(`remediationState.ts:317-330`, `triage.ts:271-272`); intake clarifications — validator only
requires ≥1 blocking question answered, typo'd `question_id` silently ignored
(`intake.ts:399-414`); implement-worker results — ids *are* enumerated in the prompt (refutation,
below) but `validateImplementWorkerResult` never checks membership (`validation/artifacts.ts:226`)
and the alias remap silently skips unmapped ids (`marshal.ts:181`).

The pattern fix is uniform: render the valid set as a **structured closed enum in the return
schema** (retry on mismatch) for pre-existing ids; **tool-minted ids via ordinal reference** for
new items; **hard-fail, never silent-skip**, on unknown ids at every gate.

## C2/C5 secondary findings

- Remediate inherits audit-side starvation: `applyPlanPipeline` treats audit scope/lenses as
  authoritative with no supplemental-audit path (root fix belongs audit-side).
- Review-approval gate hides the planner's block clustering — the host approves findings without
  seeing the union-find coupling (`plan.ts:107-156` never surfaced in `ReviewRequest`).
- Ambiguity gate omits the Finding's grounding verdict/evidence from the candidates it renders.
- Workers have no channel to push back on block decomposition (no feedback field; capture as
  friction, don't act inline).

## Refutations & corrections (kept honest)

- **submit-packet coverage**: HEAD *does* refuse missing/unassigned/duplicate task results
  (`submitPacketCommand.ts:145-153`; non-array payloads hard-error). The run's "false valid" was
  workers writing inline-result files directly on disk — a chokepoint *bypass*, not a chokepoint
  gap. Already filed in open-bugs; the uncovered half is merge-side per-task rejection persistence.
- **Implement-dispatch prompt** does enumerate assigned finding ids (`prompts.ts:689-707`); the
  live gap is validation-side membership + silent alias skip, not enumeration.
- **Intake clarification validation** is incomplete (unknown ids ignored), not absent.

## Already filed vs. new

Already in `docs/backlog/open-bugs.md` from the run close-out: design-review/charter/challenge
chokepoint absence, submit-packet bypass persistence, merge exit-2 prompt language, friction-record
lifecycle wipe, staleness re-log spam, opencode.json key order, tier-routing collapse, run-id
split. **New from this review** (single program-of-record hook added to
`docs/backlog/forward-tracks.md`, pointing here): the capability-conditional violations table
(§3), the full C1 census + uniform enum/ordinal/hard-fail contract, design_assessment/docs-digest
threading into scope confirmation (§2), scope-by-feeding charter packets + file-scope-join
teleology direction (§4), and the remediate gate-context items (§C2/C5).

## Design resolutions (owner-settled, 2026-08-05 — this section supersedes the open questions above)

All four directions are **green-lit**, with two reframes settled in review conversation:

1. **Uniform id-join contract** — as specced. Unknown-id semantics: **hard-fail everywhere**;
   every gate refuses the whole resolution, names the unknown ids and the valid set, and
   re-prompts. The implement-dispatch fuzzy alias remap is deleted (enum-validated schemas
   upstream make it dead weight).
2. **Always-materialized fan-out** (replaces "capability-conditional renderer"). No capability
   branch: every fan-out step **always** writes per-subagent prompt files and validates each
   returned artifact at a per-lane ingest chokepoint. The step prompt is capability-neutral —
   "execute these N prompt files: via subagents if available, else sequentially yourself"; only a
   concurrency hint is capability-sensitive. Identical artifacts across IDEs/providers preserves
   resumability/parallelism; `semanticReviewStep`'s existing branch is replaced by the
   unconditional form, not used as the pattern.
3. **Scope-confirmation context** — both halves: thread `design_assessment` into
   `buildLensPropositions`, and add the deterministic `docs_digest` artifact before
   `intent_checkpoint`.
4. **Charter layer: scope-by-feeding + self-organized teleology**, with the kinds redefined as
   channel-pure **estimators** — **stated** (docs + extracted comments: testimony), **structural**
   (file tree / exports / signatures / names / import graph — no bodies, no docs, no comments:
   intent frozen into organization; replaces "inferred"), **revealed** (comment-stripped bodies:
   behavior). Blindness enforced by feeding (materialized per-kind packets), never instruction.
   Each kind self-organizes a leveled teleology whose nodes carry **file scopes**; the tool joins
   kinds to each other and to the decomposition (demoted to a hint) by file-set overlap. The
   "read everything and triangulate the true telos" role is NOT a fourth parallel author — it
   moves downstream: the delta miner reads the three blind charters, mines channel-pair deltas
   (testimony↔behavior = says/does drift; structure↔behavior = architecture betrayed by
   implementation; testimony↔structure = doc rot / naming drift), classifies each, and emits a
   **triangulated telos** per subsystem as a first-class output. "True" stays a nominated
   provocation at the deepest rung, downstream of triangulation. Disagreement density per
   subsystem per channel-pair is the quantitative surface. Kind rename is a schema migration
   riding the teleology redesign.

Implementation gate: `/design-check` before the loop-core work, per standing rule.

## Design-check record — resolution 1 (uniform id-join contract), 2026-08-05

Gate run pre-implementation (loop-core). Verdict: **implementable, with three binding constraints**;
one standing obligation the settled text above does not mention.

- **Retirement collisions:** alias-remap deletion is a *knowing* supersession (named above), but its
  origin is `c88d137a` (E2: alias-aware coverage so a complete-but-alias-using result doesn't
  re-dispatch forever) — so enum-validated schemas + remap deletion must land as ONE atomic replace,
  and `resolveCoveredFindingIds` must stay convergent counting exact ids only (the deterministic
  `fromBlockId` resolution is not fuzzy; it stays).
- **OBL-INV-RSD-01 (not in the settled text):** `mergeImplementResults` MUST NOT throw on an unknown
  finding_id — block the owning block + orphan diagnostic, single state-commit
  (`marshal.ts` 663–669/777–780/1016/1383; pinned by
  `tests/remediate/n-remediate-steps-merge-consistency.test.ts`). Reconciliation: "hard-fail
  everywhere" applies at the *resolution/ingest gates* (closed-enum schema, membership validation,
  refuse-and-re-prompt); merge-side unknown ids keep RSD-01 semantics — which are already a hard
  refusal to advance, not a silent skip. An implementation that throws at merge inverts a pinned
  obligation and is out of scope unless the owner says otherwise. **Owner settled 2026-08-05:
  carve out merge — RSD-01 stays; hard-fail applies at the resolution/ingest gates.**
- **idDiscipline axis preserved:** the uniform contract must not put a duplicate-/unknown-id refusal
  into audit's packet-local draw (`idDiscipline: "local"`, settled `2ce641f7`).
- **Adjacent strands made reachable:** (1) re-prompt livelock — hard-fail gates need a bounded retry
  cap escalating to triage (mirror `MAX_INCOMPLETE_COVERAGE_ATTEMPTS`); (2) disk-written bypass
  results skip prompt-schema validation entirely — the membership check must live at the ingest
  chokepoint (`validateImplementWorkerResult`), not only in the return schema.
- **Failing test pinned red:** `tests/remediate/reviewGate.test.ts` — "refuses a resolution whose
  disapproved_findings contains an id not in the request". Today the unknown id is silently dropped
  and the typo'd decline becomes an approval (gate default approves); green only under the refusal
  contract. Independent refutation lane: agy-gemini (7 typed verdicts, all verified against source).

## Design-check record — resolution 2 (always-materialized fan-out), 2026-08-05

Gate run pre-implementation (loop-core). Verdict: **implementable — retirement-clean on the
mechanism, one owner question, eight binding constraints.**

- **Retirement verdict: clean.** Always-writing prompt/packet files was never retired; the
  contract + conceptual design-review dispatch already runs the unconditional materialized form
  (`prepareContractDispatch` / `prepareConceptualDispatch` — so the §3 table's design-review row is
  **stale at HEAD** on materialization), and the 2026-07-25 owner decision (open-bugs, host
  fan-out gate entry: "route every fan-out through a prescribed step, so 'ad-hoc' stops existing")
  pushes the same direction, as does [[universal-host-prompts-single-source]] (the
  inline-vs-write contradiction named as the bug, 2026-06-15).
- **Owner question — mandate wording:** "only a concurrency hint is capability-sensitive"
  collides with **CP-BLOCK-IMPL-mandatory-independent-critic** (`34bab094`;
  `renderIndependentReviewerDirective`, `designReviewPrompt.ts:202-222` + remediate twin
  `contractPipelinePrompts.ts:371-386`): review-class lanes carry a capability-sensitive MANDATE
  (independent subagent; inline self-review only as the explicitly-degraded fallback). Strictly
  neutral phrasing deletes that distinction and licenses author-self-review at full strength.
  Proposed reconciliation: keep the prompt capability-neutral but carry the mandate in the neutral
  text itself — "each review lane MUST be executed by an agent that did not author the work under
  review; inline execution is the explicitly-degraded no-subagent fallback" — i.e. the mandate
  becomes lane-class-conditional, never capability-conditional. **Gate-resolved by standing
  conviction 2026-08-05 (philosophy: "don't grade your own homework" refuses dropping the mandate;
  the settled no-capability-branch text + that conviction jointly select the lane-class-conditional
  form — it is the intersection of both standing decisions and loses nothing). Owner may override
  before implementation; absent that, the reconciliation above is the contract.**
- **Binding constraints:**
  1. **Atomic replace on `single_task_fallback`:** step-kind deletion + every consumer in one
     commit — `steps.ts` registry, 6 test files, `scripts/audit/smoke-audit-flow.mjs` (the
     2026-08-05 dogfood flagged it for accepting the fallback as dispatch-ready — that finding
     dissolves with the branch), `docs/audit-pkg/contracts.md:96-102` (doc-contract commit gate
     fires).
  2. **Handshake-less sizing is a decision, not an inheritance:** the fallback branch never sizes
     packets; the dispatch branch deliberately REFUSES unknown context caps. The unconditional
     form must define what a can't-dispatch, no-handshake host gets — honest refusal (consistent
     with "unknown cap refuses rather than fits") or degenerate single-task-sized lanes. Silently
     inheriting the refusal regresses the weakest hosts with no recorded decision.
  3. **Routing consumers of capability survive:** `hostCanDispatch` stays for engine routing
     (`nextStepHelpers.ts:2152-2188` hybrid/headless; `waveScheduling.ts:302` headless pools).
     Change 2 deletes capability branching from step RENDERING only.
  4. **Per-lane ingest rides the existing engines:** `runOmittableGate` (the 6 schema-validated,
     quarantining host-gate ingests) + the change-1 refusal pattern (refuse whole, archive +
     re-halt naming the valid set, bounded re-dispatch cap) are the substrate — no parallel
     validation layer. The charter per-lane split moves the merge from host to tool
     (`assembleCharters` currently ingests one merged submission).
  5. **Fan-out quota-gate scope** *(corrected at implementation recon)*: at HEAD
     `gateHostFanout` is a permissive no-op hand-off (host/relay own admission since the dispatch
     inversion — no leases, no pauses; the lease/TTL framing in the original constraint was stale,
     read from the pre-inversion backlog entry rather than the file). Extension = broaden
     `HostFanoutFamily` + call the gate uniformly at every fan-out emitter so the seam exists when
     admission returns; no quota-wall behavior is introduced today.
  6. **Resumability contract:** K-of-N partial lane results on disk survive a re-run — re-emit
     only missing lanes, never regenerate/overwrite completed lane results (identical artifacts
     across IDEs/providers is the point of the change).
  7. **Sequencing vs resolution 4:** charter lanes materialize with CURRENT content rules under
     change 2 (per-kind prompt files, mechanism only); channel-pure packet feeding + the kind
     rename ride change 4 — never entangled in one commit.
  8. **Census corrections:** `edge_reasoning` (`nextStepCommand.ts:915-985`) is a SECOND
     capability branch of the same class, unnamed in the settled text — in scope, replaced in the
     same change. `systemic_challenge` is quota-gated but renders inline (single lane). The
     remediate review-approval gate is operator-interactive, not a fan-out — its context items
     stay under §C2/C5, outside this renderer.
- **Failing test pinned red:** `tests/audit/semantic-review-step.test.ts` — "hostCanDispatch=false
  with a full handshake still materializes the dispatch step" (`it.fails`; verified
  red-for-the-right-reason: `expected 'single_task_fallback' to be 'dispatch_review'`). Companion
  implementation-time assertion: the `charter_extraction` step names per-lane prompt files in
  `artifact_paths` and the files exist on disk (`charter-extraction-executor.test.ts` harness
  exists).
- Independent refutation lane: agy-gemini (gemini-3.6-flash-medium), 9 typed verdicts, each
  verified against source before adoption; two downgraded on verification (the
  one-task-pacing "collision" is a consequence the settled text already embraces — no recorded
  one-task-pacing decision exists; the mandate "collision" is the reconcilable owner question
  above).

**IMPLEMENTED 2026-08-05** under all 8 constraints (constraint 2 decided: handshake-less hosts
degrade to one-task-per-packet with a loud `unknown_host_window` dispatch warning — never refused,
never fitted to an invented window; the old fallback's exact weak-host semantics in the
materialized form). Post-implementation adversarial review: 4-lens / 17-agent workflow over the
diff, 11 raw findings → 9 confirmed (all fixed or comment-hardened: prompt re-materialized when
missing, edge lane routed through the shared materializer, zero-lane text guard, explicit per-lane
result paths, vacuous assertions dropped) and 2 refuted; two reviewer misreadings (the surviving
internal `edge_reasoning` RESULT kind; the standard post-apply consumed-submission unlink)
hardened with clarifying comments at the misread sites.

## Design-check record — resolution 3 (scope-confirmation context), 2026-08-05

Gate run pre-implementation (loop-core: `src/audit/orchestrator/` is a `LOOP_CORE_PATTERNS`
prefix — the HANDOFF's "not loop-core heavy" understated it; the commit needs an attestation).
Verdict: **implementable — retirement-clean, eight binding constraints, zero refutations.**

- **Retirement verdict: clean.** No docs-digest/README-reading mechanism was ever built or
  retired (`git log -S'docs_digest'`/`-S'docsDigest'` → only this review's commits; grep
  readme/telos → nothing); `buildLensPropositions` was born with the invisible-LLM-review design
  in `d4623bc3` and design_assessment threading was never added-then-removed; the plan respects
  DD-9 (no charter-before-scope reorder) and leaves the invisible-review flow intact.
- **Binding constraints:**
  1. **The checkpoint stays a leaf:** NO `intent_checkpoint.json` ← `docs_digest.json` DAG edge.
     Its revision mirrors `artifact_metadata.intent_baseline` (dependency-map.md:75-87); an edge
     would re-stale the confirmed checkpoint on every doc edit and fight the DD-9 mirror. The
     pre-digest already reads bundle artifacts (unit_manifest et al.) without checkpoint edges —
     same pattern for both new inputs.
  2. **One doc predicate:** the digest's doc universe REUSES `isDocIntentFile`
     (`src/audit/decompose/buildStructureDecomposition.ts:31` — "the pipeline's single doc
     predicate", `dependencySlices.ts:60`); a second "what is a doc" rule is the fork the
     charter-slice residual (open-bugs DD-9 entry (b)) exists to prevent.
  3. **A new PRIORITY obligation lands whole, one commit:** `docs_digest_current` (between
     `structure_decomposition_current` and `intent_checkpoint_current`) + exactly-one executor
     registry entry (load-time assert `nextStep.ts:69-87`) + a hand-pushed derivation in
     `buildAuditObligations` (`state.ts` — obligations are pushed per artifact, a PRIORITY id
     with no derivation is silently never selected) + `ARTIFACT_DEFINITIONS` +
     `ARTIFACT_DEPENDS_ON_MAP` row (`docs_digest.json` ← repo_manifest, file_disposition,
     structure_decomposition) + the `spec/audit/dependency-map.md` row (doc-contract commit gate
     fires on it).
  4. **Empty is no-signal:** absent design_assessment, empty findings, or auto-completed stamps
     (`contract_auto_completed` = UNREVIEWED, never clean — `designAssessment.ts:39-46`) keep the
     heuristic dispositions; evidence only ever flips exclude→include or confirms, never
     absence→exclude.
  5. **Weak-path degradation:** `computeScopePreDigest` and `runIntentCheckpointAutoComplete`
     (`intentCheckpointExecutor.ts:386-442`, which ignores `lens_propositions`) must run cleanly
     on older bundles missing the new artifact — blast radius of half (a) is render-only
     (`lens_propositions` consumer census: `confirmIntentStep.ts:85` alone).
  6. **Extractor determinism:** stable path-sorted doc order, bounded per-doc extraction
     (budget-context rule); no volatile fields beyond the registry norm. No downstream edge
     exists, so digest churn cascades nowhere — keep it that way unless a consumer earns it.
  7. **Sequencing vs resolution 4:** docs_digest is telos extraction for the scope decider only;
     charter stated-kind packet feeding rides change 4 — shared doc predicate, never entangled in
     one commit.
  8. **Threading keys on the finding's own `lens` tag** (every deterministic detector emits one —
     `extractors/designAssessment.ts`), and the improved proposal set remains the recommended
     default at the user question (standing feedback: lens default follows the proposal).
- **Failing tests pinned red** (`test.fails` × 2, `tests/audit/intent-checkpoint.test.ts`;
  verified red-for-the-right-reason before pinning): (a) "computeScopePreDigest reads
  design_assessment…" — `expected 'recommend_exclude' to be 'recommend_include'`; (b)
  "docs_digest is a registered artifact…" — `expected [ 'repo_manifest', …(36) ] to include
  'docs_digest'`. Companion implementation-time assertion: the confirm-intent prompt renders the
  digest section (compile-bound today, joins with the implementation).
- Independent refutation lane: agy-gemini (gemini-3.6-flash-medium), 9 typed verdicts, zero
  `refutes_plan`; each verified against source — one evidence citation corrected on verification
  (`isDocIntentFile` lives in `buildStructureDecomposition.ts`, not `structureExecutors.ts`).

**IMPLEMENTED 2026-08-05** under all eight constraints. Half (a): `collectLensEvidence` +
one-directional overlay in `buildLensPropositions` (evidence widens exclude→include, keyed on the
finding's own `lens` tag across all four finding groups; absence/empty/auto-completed = no-signal).
Half (b): `docs_digest` extractor (`extractors/docsDigest.ts`, doc universe via the single
`isDocIntentFile` predicate, depth-then-path stable order, capped 12 docs × 1,000 chars,
`omitted_paths` beyond the cap, empty-digest degrade without root) + full wiring (registry, DAG row
`repo_manifest`+`file_disposition`, PRIORITY slot, executor, state derivation, CLI fold, spec
tables) + the bounded "Repository purpose (from its docs)" section in the confirm-intent prompt
(6 docs × 500 chars rendered, remainder named by path). The checkpoint gained NO upstream edge.
Both design-check pins flipped green; companion render assertion added. Full suite 7,412 passed /
0 failed. Post-implementation adversarial review: 4-lens / 8-agent workflow over the diff, 4 raw
findings → 2 confirmed, both fixed (`firstAtxHeading` is now fence-aware; a UTF-8 BOM is stripped
before titling — both pinned in `docs-digest.test.ts`) and 2 refuted by mechanism (CRLF handled by
`\s` regex semantics; unreadable-doc skip is intentional, documented at the skip site).

## Design-check record — resolution 4 (charter layer), 2026-08-05

Gate run pre-implementation (loop-core + persisted-schema migration). Verdict: **implementable —
retirement-clean on every mechanism, ONE named knowing-refinement of a spec invariant (owner may
override), eleven binding constraints.**

- **Retirement verdict: clean on mechanism.** No "structural" kind, file-scope field, teleology
  tree, or triangulated-telos output has ever existed (git `-S` probes → zero relevant hits; kinds
  unchanged since Phase A1 `f28479a2`); the consensus node list was a size-robustness *repair*
  (`68802512`), not a rejected free-form alternative; C3a/C3b split extraction/delta as a
  refinement. Change 2's retired `single_task_fallback`/`edge_reasoning` step kinds are rendering
  machinery, orthogonal to the charter model.
- **The one knowing refinement — "never reconciled into one truth"**
  (`spec/conceptual-design-review-design.md:252` "the deltas are the product; a merge destroys
  them"; echoed `charter.ts:13-14`). The refutation lane called this a hard collision; verification
  downgrades it: the rejection's own rationale is *delta destruction*, and change 4 preserves the
  deltas as primary (disagreement density per channel-pair IS the quantitative surface) while the
  spec already endorses triangulating toward True (`:126-127`) under leads-not-verdicts
  (`:244-245`). Contract: the **triangulated telos ships as a LEAD artifact** — no consumer may key
  on it in place of the charters/deltas — "true" stays nominated-never-asserted downstream, and the
  spec's rejected-bullet is reworded in the same commit to state the boundary (a merge that
  destroys deltas stays rejected; a downstream estimate that preserves them is in-design). Owner
  may override before implementation; absent that, this is the contract.
- **Binding constraints:**
  1. **The persisted-rename hazard is live and silent:** `charter_register.json` carries NO
     `schema_version`, NO zod parse, NO validation-pass reference on read (`artifacts.ts:252` is a
     plain `jsonArtifact`; `validation/artifacts.ts` never names it). An old register
     (`kind:"inferred"`) read by post-rename code flows silently through `keptByKind`/`DELTA_ROUTES`
     misses, and the staleness DAG cannot catch a code-taxonomy change (content-keyed — an old
     register looks fresh). The migration stamps `schema_version` + wires an explicit read policy
     (`schemaVersion.ts` two named directions; decide discard-vs-throw for this LLM-costly but
     regenerable artifact) in the SAME commit as the enum rename. Enumerate on-disk state first
     (the 2026-08-05 dogfood bundle at minimum) — the catalog-cache incident class.
  2. **Atomic taxonomy replace:** kind enum + `KIND_ORDER` + `DELTA_ROUTES` + `canonicalPair` +
     `charterExtractionKindsForCeiling` + `KIND_LANE_TEXT` + lane filenames
     (`charter-extraction-<kind>.json`) + kind-purity superRefine + `charter_id`/`delta_id`
     derivations + fixtures, one commit. The word-collision `CharterProvenanceSchema.kind`
     `"inferred"` (provenance-SOURCE sense, `charter.ts:47-54`; prompt example
     `charterExtractionPrompt.ts:144`) is NOT co-renamed.
  3. **Blast/VOI tiers ride the taxonomy:** `blastRadius.ts:59-62` keys intrinsic tiers on the OLD
     delta kinds (`wrong_goal` 3 / `spec_drift` 2 / else 1); partition + VOI consume it. The new
     channel-pair kinds get a declared tier table in the same commit; `wrong_goal`'s home moves
     downstream with "true".
  4. **The deepest-rung consent gate survives the move:** the true lane leaves extraction
     (`charterExtractionKindsForCeiling` drops its 4th lane) but `Ceiling` `deepest` +
     `explicit_opt_in` must gate True provocations at their NEW emission point (the miner,
     downstream of triangulation), where `applyTrueCharterGate` (falsifiable-or-drop) also applies.
     A `deep` run never emits a true nomination.
  5. **Vestigial checkpoint fields are deleted, not migrated:**
     `IntentCheckpoint.design_review.charters`/`.goal_graph` (`intentCheckpoint.ts:141-142`) have
     NO writer anywhere in src (grep-verified) and one validation reader
     (`validation/artifacts.ts:333-344`); the register's own doc records the deliberate
     keep-charters-off-the-checkpoint decision (`charterRegister.ts:17-19`). Delete the pair + the
     reader in the same replace; `ceiling`/`attention`/`conceptual_depth`/`perspectives` stay
     live; the checkpoint stays `intent-checkpoint/v1` (no real payload ever carried the deleted
     fields); DD-9 leaf-ness untouched — feeding packets add NO checkpoint DAG edges.
  6. **The staleness slice is re-derived from the new reads:** `charterReadFileSlice`
     (`dependencySlices.ts:75-92`) models the instruction-scope read set. Feeding changes what
     extraction reads — re-derive the slice from the packet materializer's actual input set, keep
     the single doc predicate `isDocIntentFile` (change-3 constraint 2 carries), and make the
     materializer the ONE place the read-set is defined so slice and packets cannot drift.
  7. **Ingest joins keep the refusal discipline:** file-scope overlap joins are tool-side; a lane
     whose scopes cite files outside the repo universe must be refused/flagged at the lane
     chokepoint — no silent-drop reintroduction (change-1 discipline; audit's packet-local
     idDiscipline untouched). The K-of-N lane resume + kind-purity chokepoint
     (`nextStepHelpers.ts:1291-1364`) is the substrate the per-kind packets ride (change-2
     constraints 4/6 carry). The current invented-node drop-with-issue contract
     (`charterExtraction.ts:247-254`) is REPLACED by file-universe grounding — "cannot conjure
     boundaries" survives in file-set form (scopes ⊆ universe), decided explicitly, never
     inherited silently.
  8. **Miner authority under the open author/critic gap:** open-bugs:487 — `charter_delta`
     defaults its miner to the extraction-merging host, and change 4 GIVES that miner
     triangulated-telos authority. Must not worsen: triangulation stays in the separate
     `charter_delta` step (C3a boundary), and the open bug stays open and named unless the change
     mechanically enforces a distinct lane.
  9. **Leveled teleology stays emergent:** `premise_height` integer, self-organized levels, NO
     fixed L0/L1/L2 enum in any schema or prompt mandate (`charter.ts:93-97`; spec `:69-70`).
     File scopes are content-derived join keys; stable path-sorted ordering everywhere
     (extractor-determinism invariant).
  10. **Sequencing + doc gate:** the always-materialized lane mechanism is already in (change 2,
     constraint 7 carries) — change 4 changes packet CONTENT rules, kinds, and teleology only;
     spec rows (`artifact-contract.md:61-63`, `dependency-map.md:48-56`,
     `executor-catalog.md:65-70`) + `conceptual-design-review-design.md` §§107-160/216-229/248-256
     + `audit-workflow-design.md:24-25/134-160` updated in the same commit (doc-contract gate).
  11. **DD-16 carries:** audit's `CharterClarificationRequest` keying (`delta_id`/`node_id`/`pair`)
     migrates with the taxonomy but never merges with remediate's `ClarificationRequest`.
- **Failing tests pinned red** (`test.fails` × 2, `tests/shared/charter-extraction.test.ts`,
  verified red-for-the-right-reason before pinning): (a) "charter kinds are the channel-pure
  estimator set" — `expected [ 'stated', 'inferred', … ] to deeply equal [ 'stated', 'structural',
  … ]`; (b) "the intent-model↔revealed channel pair routes as work instead of dropping" —
  `expected [] to have a length of 1` (the middle kind is derived at runtime so both pins compile
  across the rename; the adjacent "no routing (inferred|revealed)" test is the pinned CURRENT
  behaviour deliberately inverted at implementation). Companion implementation-time assertions
  (compile-bound, join with the implementation): packet channel-purity — the revealed packet
  contains no comment text, the structural packet contains no bodies/docs/comments, the stated
  packet contains docs + extracted comments only. Note: `extractCommentText` exists
  (`commentDecomposition.ts:83`); NO language-neutral comment-STRIPPING or signature-surface
  utility exists yet — both are new build, on the two-tier dependency policy (vetted lib vs tiny
  owned bit) at implementation.
- Independent refutation lane: agy-gemini (gemini-3.6-flash-medium), 8 typed verdicts over the
  hand-verified recon map (6-lane census workflow, every load-bearing claim re-verified against
  source). One `refutes_plan` downgraded on verification (the reconciliation refinement above);
  one corrected (V5 claimed legacy checkpoints carry charters — no writer exists, the field is
  vestigial; deletion, not migration); one test proposal replaced (it named functions that do not
  exist — compile-red, not behavior-red). V2/V3 clean confirmed; V4/V6/V7 adopted as constraints
  1/3/8.

**IMPLEMENTED 2026-08-06** under all eleven constraints, owner go received with a design gloss
(the telos is a unified opinion the owner REACTS to; deltas are leads that also say which parts of
the triangulation need clarification — so the telos + tool-counted disagreement density render
beside the clarification questions). Mechanisms of record:

- **Shared core** (`charterExtraction.ts` v2): teleology-first lane submission (`{nodes}` — a node
  = charter fields + `premise_height` + `files`, composed from `TeleologyNodeSchema`); universe
  grounding (unknown-path scopes drop at assembly AND refuse the lane whole at the chokepoint);
  deterministic join — best-overlap hint mapping (tie → lexicographically first hint id), residual
  union-find on any shared file across kinds, unit id = hint id or first residual file (provably
  collision-free: a residual scope contains no hint member, and a hint id IS a hint member);
  per-unit per-kind best-overlap charter selection with full teleologies persisted;
  `DELTA_ROUTES` v2 (`doc_rot` stated|structural→remediator/low; `says_does_drift`
  stated|revealed→remediator/medium; `architecture_betrayal` structural|revealed→
  clarification/medium; `wrong_goal` any|true→human/high); `assembleDeltas` gains
  `allowTrueNominations` (rung-keyed at the executor — preserving the retired lane's bare-deepest
  semantics; `explicit_opt_in` stays the capture-time contract), True nominations gate through
  `applyTrueCharterGate` at the miner's ingest, `triangulated` teloses validate node membership
  (dup → keep-first + issue), `disagreement` density is tool-counted per unit per canonical pair.
- **Scope-by-feeding** (`charterPackets.ts`): per-kind evidence packets (stated = doc universe +
  `extractCommentText` per member; structural = member tree + member-member dependency edges +
  indent-zero declaration-line heuristic over stripped source, explicitly labeled a lead;
  revealed = `stripCommentText` bodies), bounded 6k/file + 150k/packet with honest omitted lists;
  `true` packet request throws. The comment grammar is single-sourced: `scanCommentSpans` is the
  one walker, extract/strip are span consumers (`commentDecomposition.ts`). Read-set single-sourced
  (constraint 6): `charterPacketReadSet` feeds both the materializer and `charterReadFileSlice`;
  `memberDependencyEdgeLines` feeds both the structural packet and the NEW `graph_bundle.json` DAG
  edge + member-scoped slice (found at implementation: enrichment-merged edges changed packet
  content with no re-stale — the edge closes it, the slice keeps outside-member churn from
  over-firing).
- **Lanes**: three estimator lanes at every charter ceiling (`charter-extraction-{stated,
  structural,revealed}.json` + `-packet.md`); chokepoint validates kind purity + scope grounding
  per lane (quarantine + re-emit naming the lane); packets re-materialize on every emission and
  unlink with the consumed submissions; `access.read_paths` = prompts + packets only.
- **Migration** (constraint 1): register stamped `charter-register/v2` with the DISCARD read
  policy wired in `loadArtifactBundle` (v1/unstamped degrades to absent → the obligation
  rebuilds); checkpoint's never-written `design_review.charters`/`goal_graph` embeds DELETED with
  their validation reader (ceiling/attention stay live; `conceptualDispatch.flag_for_human`
  re-pointed at the register — the real charter home); blast tiers declared
  (`INTRINSIC_BLAST_TIER`: wrong_goal 3, architecture_betrayal 2, says_does_drift 2, doc_rot 1).
- **Verification**: red pins flipped green (kept as anchor tests, rename-robust); the old
  "no routing (inferred|revealed)" pin inverted per plan; new coverage — packet channel purity ×3
  (the gate record's companion assertions), strip/extract partition, declaration heuristic,
  read-set, version discard-and-rebuild, graph-slice fire/ignore, True consent gate, triangulation
  validation, disagreement density. Full suite 7,438/0. Pre-commit adversarial review: 4-lens
  find + per-finding refutation workflow — 5 raw findings, ALL 5 refuted by mechanism (delta_id
  lastIndexOf parsing, backtick closer regex, collision proof, disagreement sort order, packet
  unlink timing), two lenses affirmatively clean; the graph_bundle under-stale was caught and
  fixed by the implementing session before the review ran.

## Checked and clean

Selective-deepening + syntax-resolution + intent-equivalence + acquisition executors and
`src/shared/quota/dispatchDriverPrompt.ts` carry no prompt surfaces with C1/C3/C4 exposure
(issues live in `packetPrompt.ts` rendering, cited above). No contradictions between sweeps.
