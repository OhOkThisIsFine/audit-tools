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

## Checked and clean

Selective-deepening + syntax-resolution + intent-equivalence + acquisition executors and
`src/shared/quota/dispatchDriverPrompt.ts` carry no prompt surfaces with C1/C3/C4 exposure
(issues live in `packetPrompt.ts` rendering, cited above). No contradictions between sweeps.
