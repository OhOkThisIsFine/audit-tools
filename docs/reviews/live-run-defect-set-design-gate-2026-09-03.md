# The 2026-09-02/03 live-run defect set — pre-implementation design gate (2026-09-03)

## Scope and evidence quality

Lap baseline: `86a775b1`. Preflight landed as `edc24ece` and `e8d6af82`; the three cluster
branches were cut from `85c243e3`.

Two full audits of an external repository (`C:\Code\llm-relay`, 335 files) were run back to back,
differing only in lane capability. They produced nine tool defects that share one shape: **the tool
reports success while delivering less than it claims**, and every one of them was invisible from
inside the run. The owner approved fixing all nine on 2026-09-03 and directed that the partial
self-audit under the run artifact tree be deleted rather than renamed; it was.

The nine split into three clusters plus one standalone tooling defect (the backlog seek index's
blind parse, landed separately as `c5fea2b7`):

- **C — adjudication** — `NO-REJECTION-OUTCOME`.
- **A — packet provenance and citation truth** — `PACKET-SHIPS-MANIFEST`, the missing per-file line
  provenance, `REGISTER-SELF-CERTIFIES`, `PACKETS-CONSUMED`.
- **B — status truth** — `SELECTED-LENSES-IGNORED`, `CAPABILITY-ASSERTED`,
  `LANE-OUTCOMES-UNRECORDED`.

Method, per cluster: premise recon against HEAD source → spec → independent refutation by lanes that
did not author the spec → failing-test-first implementation in an isolated worktree → independent
review and landing. Refuter lanes were AGY Gemini 3.8 Flash at high effort on every cluster, AGY
Claude Opus until its quota died mid-lap (cluster C only), and Claude Opus subagents as the deep
lane on A and B thereafter. Codex was quota-dead until 7 September and took no part.

**Coverage caveat.** `check_index_coverage` returned `no_recorded_issue` but
`freshness: metadata_changed` with `recommended_action: read_source_and_reindex` for every file cited
across all three recon passes, so every claim below rests on a direct source read, not on the graph.
The one measured cost: cluster C's recon cited a grounding module path that does not exist here, and
the real path (`src/shared/validation/designFindingGrounding.ts`) had to be located separately. A
recon-reported path is a lead.

---

## Cluster C — adjudication has a verdict but no grounds

### The corrected defect statement

The entry said adjudication *cannot* reject. **Refuted.**
`ConceptualCandidateDispositionSchema` (`src/audit/types/conceptualAdjudication.ts`) already carries
`disposition: z.enum(["retained", "merged", "rejected"])`, and `buildConceptualReviewAdjudication`
in the same module enforces rejection semantics in both directions — rejected candidates name no
final finding, non-rejected ones must name at least one. It was added and never removed
(`3e3a9dce`, 2026-08-31), under the owner resolution recorded in
`docs/reviews/p0-deep-review-design-gate-2026-08-31.md`.

The measurement holds exactly: 60 of 60 candidates survived one run and 74 of 74 the other — 134
candidates, zero rejections. The real cause is three-part, and none of it is a missing disposition:

1. **No ground to reject on.** Every enumerated drop ground in the judge prompt
   (`renderConceptualJudgePrompt`, `src/audit/orchestrator/designReviewPrompt.ts`) is about the
   *form* of an assertion — vague, unactionable, unsupported, out-of-scope — while the prompt
   separately insists a lone well-reasoned observation must survive. A well-argued, actionable,
   in-scope, *already-fixed* candidate matches no ground, so merging it at a high
   `modification_percent` is the prompt-compliant move. That is the observed case exactly.
2. **No field to record a verification claim in.** The field that reads as verification does not
   verify: `groundDesignFinding` (`src/shared/validation/designFindingGrounding.ts`) returns
   `grounded` on nothing more than "a cited path exists in the repository". All 27 conceptual
   findings in the live run were `grounded`; zero carried an `executable_anchor`, the only tier that
   checks a behaviour claim.
3. **No place to publish the result.** `AuditFindingsSummarySchema` (`src/shared/types/finding.ts`)
   carries no disposition or verification breakdown, so the machine contract the remediator ranks on
   holds no counts at all — the entry's own numbers came from counting the artifact by hand.

### Invariants the tool now guarantees

- Every candidate disposition carries a **required** `verification_status` from a closed vocabulary
  (`judge_confirmed | asserted | refuted_at_head`). Absence is impossible, not discouraged.
- `buildConceptualReviewAdjudication` **refuses** a `refuted_at_head` candidate that is not
  `rejected`. One rule, and it mechanically closes the observed merge-instead-of-reject case.
- `verification_note` is required iff the status is not `asserted`, and refused on `asserted` — the
  claim costs something and the cheap path stays cheap.
- Every admitted conceptual finding carries a **tool-derived** status after ingest; host supply is
  refused at the worker schema, at the judge submission schema, and at the pre-schema check in
  `src/audit/cli/dispatch/hostHandoff.ts`.
- Counts are **derived by the tool, never read from the submission** — otherwise the artifact
  self-certifies, which is the sibling `REGISTER-SELF-CERTIFIES` defect one module over.
- The conceptual report section states what `grounded` certifies there (component-path existence),
  scoped to that section so no tier-1 verdict is libelled.

### Decisive refutations and their adjudication

| # | Refutation | Lane | Adjudication |
|---|---|---|---|
| A1 | A judge-authored `confirmed` collides with the tool-run confirmed bit `AnchorExpectation` reserves in `src/shared/types/finding.ts` — "the confirmed bit is the tool's run, never the model's word" | Gemini, blocking | **Accepted** — renamed `judge_confirmed` |
| A2 | Report normalization and the approved-findings projection cannot compute a candidate-scoped breakdown: candidate dispositions are not in the findings report | Gemini, blocking | **Accepted in part** — candidate-scoped counts live only on the adjudication artifact; the summary carries only the finding-scoped breakdown |
| A3 | The host-supply refusal was placed on the per-file worker path only; the judge's findings parse through `ConceptualJudgeSubmissionSchema`, so a judge could still supply the field | Gemini, blocking | **Accepted** — omit at the judge schema plus the pre-schema refusal |
| A4 | `absorbFinding` (`src/shared/findings/dedupe.ts`) merges `grounding` by precedence and has no rule for a new field, so a deduped pair silently keeps whichever status survived | AGY Claude Opus, blocking | **Accepted** — an explicit merge at both dedupe sites |
| A5 | The entry's stated purpose is a remediator ranking on the field, but remediate ordering has no reader and the contract pipeline re-mints plan findings from DAG nodes | both, blocking | **Accepted** — a tie-break consumer in `src/remediate/intent/intentOrdering.ts`, and the contract-pipeline gap stated rather than left silent |
| A6 | `renderAdjudication` (`src/audit/systemic/secondOrderAdversaryPrompt.ts`) projects dispositions into the systemic prompt and was omitted from the consumer survey | Gemini, advisory | **Accepted** — the breakdowns ride with them |
| A7 | The wiring proof asserts `every()` over conceptual findings, vacuously true on the empty fixture | Gemini, blocking | **Accepted** — a real fold ingest with non-empty perspective findings |
| A8 | `.strict()` plus a required field moves every disposition fixture | Gemini, advisory | **Accepted** — schema and fixtures in one commit |
| A9 | The rule test is green at HEAD for the wrong reason: the submission already throws, on the unrecognized-key message | Opus (supports), Gemini | **Accepted** — assert the rule's own regex, never a bare throw |

**Escalated, not adjudicated.** Both lanes flagged that two new persisted fields plus a summary
breakdown extend the owner-approved narrow exception to the P0 no-new-persistent-schema rule → owner
question C-Q3.

### Retirement check

**No collision, and the direction is confirmatory.** `git log -S "verification_status"` returns zero
commits repo-wide — no such field has ever existed. The rejection disposition was *added* in
`3e3a9dce` with `rejected` present in its first commit. The one live constraint is the alternative
that same design gate **refuted**: encoding rejected candidates as `info` findings, refused because
ordinary findings stay in the machine contract and work blocks and "would turn judge-rejected ideas
into remediation inputs". The existing rejected-maps-to-no-final-finding rule already prevents that;
this design preserves it and adds no path from a rejected candidate to a finding or a work block.
The rejection branches are entirely untested at HEAD — consistent with a mechanism that has never
fired in production. So the fix completes an owner-authorized design that shipped half-exercised.

### Landing shape

Three green commits on `lap/cluster-c-adjudication-verification`, with one declared branch-only seam
(the optional finding field exists before its producer) closed before merge under the `main`-scoped
PH-04 narrowing: vocabulary + adjudication contract + validator + fixtures; derivation + ingest
wiring + the prompt's new rejection ground (loop-core — fresh attestation); counts + render + spec
regeneration + deletion of the backlog entry in the same commit that states its trap. Landed on
`main` as `a0a5dab3`, `438c7e45`, `6e7b1d01` — the last of which also carries the INV-WH repair that
turned `main` green again (see *What independent review caught after implementation*).

---

## Cluster A — packet provenance and citation truth

### The corrected defect statement

All four premises **reproduced exactly at HEAD**. Recon changed none of them; it strengthened two.

`materializeCharterPacket` (`src/audit/orchestrator/charterPackets.ts`) is deterministic in bundle
plus disk, so re-running the HEAD builder against the run's own artifacts regenerates the packet the
run consumed: 72 comment sections named and **zero delivered**, 56 doc omissions, 50 revealed
omissions, 31 of 81 files' source. The arithmetic is an ordering artifact of one greedy loop — the
`stated` branch charges docs first, and the doc-intent files cost 3.07× the whole packet budget
before the comment loop is reached, so every comment section overflows to its heading. A member with
no comments is named in neither list, so the counts cannot even be reconciled.

The citation overshoots are mechanically explained rather than merely plausible: probing where run
1's line-ranged citations fall inside the regenerated packet, 8 of 11 land inside the packet section
for exactly the file named. They are offsets into the concatenated packet.

**The sharpest form of the defect is that obedience produced the wrong answer.** The extraction
prompt (`src/audit/cli/charterExtractionPrompt.ts`) tells the lane the packet is its only input and
forbids reading repository files, while the packet data model carries no line provenance at all and
three transforms — `extractCommentText`, `stripCommentText`, `topLevelDeclarationLines` — destroy
line correspondence before a lane sees the text. Run 1's lane obeyed and emitted packet offsets; run
2's lanes disobeyed, reopened the files, and emitted correct citations. That is the
auditor-agnostic-robustness invariant failing at its own boundary.

`validation_issues` never could have caught it: `assembleCharters`
(`src/shared/decompose/charterExtraction.ts`) validates node-file membership and the True-charter
gate only, and copies `provenance` verbatim. Both runs printed `[]` — at 1-of-15 correct citations
and again at 75-of-75 — and the field reaches no report. Packets are unlinked at ingest
(`src/audit/cli/nextStepHelpers.ts`) for a real reason, since a leftover packet would feed a later
re-extraction stale evidence, and **no test pins the deletion or its absence** — so this entry has
zero regression protection in either direction today.

### Invariants the tool now guarantees

- Every excerpt carries **copyable** provenance: a machine manifest at the head of the packet plus a
  per-line prefix carrying the true 1-based source line, computed against unstripped text.
- A non-contiguous excerpt carries contiguous line runs, never a first-to-last span, and a citation
  names one run. False precision is refused at the format, not repaired afterwards.
- Coverage is a value, not prose: per evidence class, named equals delivered plus omitted, each
  omission carrying a reason — so a file with no content is named rather than silently skipped.
- The packet ceiling stays as the bounded-never-whole-repo invariant; inside it the allocator is a
  two-pass water-fill under per-class quotas, so no class can be starved by another's ordering.
- `validation_issues: []` is only ever emitted beside a stated citation-validation status and count
  (`checked`, `not_run`, `no_citations`) — an empty array is never an implicit pass.
- The validator **rejects, never repairs**. No nearest-declaration resolution of a wrong number.
- The exact packet each lane received is archived before the live copy is unlinked; a failed archive
  is recorded, not silent.

### Decisive refutations and their adjudication

Seventeen amendments were bound into the implementer brief. The ones that changed the design:

| # | Refutation | Lane | Adjudication |
|---|---|---|---|
| A1 | A first-to-last span over an explicitly non-contiguous excerpt manufactures exactly the false precision the 2026-07-28 line-number trap rejected — a structural excerpt spanning 18→255 while delivering ~60 lines, which the proposed validator would certify | Claude Opus, blocking | **Accepted** — contiguous line runs; a citation names one run |
| A2 | The rejection of run headers rests on a false premise: a run header needs no offset arithmetic when every line also carries its own prefix | Claude Opus, advisory | **Accepted** — both ship. Gemini's stronger version (drop the per-line prefix as redundant) was **rejected**: copy-not-compute is the property this entry exists to deliver |
| A3 | The regex prefix strip mutilates markdown table rows, which is exactly what the doc class delivers | Claude Opus, advisory | **Accepted** — strip positionally at a fixed width recorded in the manifest |
| A4 | The budget arithmetic is optimistic: measured over this repo's own TypeScript the mean line is 38.7 chars, so the prefix is 15.3% not 12%, and the manifest adds roughly another 17% | Claude Opus + Gemini | **Accepted** — quotas derive from the post-metadata budget |
| A5 | The allocator is stated two incompatible ways, and the literal formula cuts every doc on the motivating repo to 789 chars — under the spec's own unusable-stub standard | Claude Opus, blocking | **Accepted** — the per-candidate share is the guaranteed floor of a two-pass water-fill |
| A6 | `evidenceCitesRealPath` cannot be a thin wrapper over an async core without going async, breaking 16 synchronous assertions across three remediate test files the spec never named | both, blocking | **Accepted** — the shared core is sync over injected content; async stays at the read boundary |
| A7 | Requiring a root at the runner makes the executor's omit branch throw and renders the spec's own abstention unreachable | Claude Opus, blocking | **Accepted** — pass the root through, abstain inside |
| A8 | The archive's copy-then-unlink fallback has two opposite arms in `514cd31c`; this call site sits after the fold has already applied the submission, so the record arm applies — and the spec gave no failure surface, which is `PACKETS-CONSUMED` again with an extra step | Claude Opus, blocking | **Accepted** — record-arm archive keyed by content hash, with an index row stating a failed archive |
| A9 | The emit site already pushes packet paths in IO-completion order and persists that into the step contract — a stable-order violation predating this change | Claude Opus, advisory | **Accepted** — derive from the kind list after the parallel writes |
| A11 | Declaration line numbers derived after comment-stripping are false, because the declaration filter is fed stripped text | Gemini, blocking | **Accepted** — compute against unstripped text |
| A12 | Folding multi-kind coverage into the register without a canonical order risks content-hash churn | Gemini, blocking | **Accepted** — kind-sorted before persist |
| A13 | The register schema bump moves hardcoded fixtures and a second writer, `charterDeltaExecutor` | Gemini, blocking | **Accepted** — fixtures and the delta writer carry through in the same commit |
| A15 | Re-exporting the new surface without consumers reds `check:deadcode` | both, blocking | **Accepted** — export only adopted symbols, per commit |
| A16 | The runtime-artifact-names row is wrong in both directions: the generator's sources contain neither touched file, and the drift test never imports the extractor it claims to re-run | Claude Opus, advisory | **Accepted** — row dropped |
| A17 | Six of the ten proposed tests are mis-specified: two clauses are green at HEAD, one targets a shape no implementation would produce, one reds on a missing import rather than on the property, and one needs an on-disk fixture the spec never mentions | both | **Accepted** — split, re-homed, and the minimal red moved onto the existing range case in `tests/remediate/grounding.test.ts` |

**Escalated, not adjudicated (A10).** True line numbers in the revealed channel disclose comment
block positions and sizes — never content — and there is no leak-free line-true option, because
padding the removed spans reproduces the negative space the module rejects. Owner question A-Q1.

### Retirement check

**No collision.** The packet builder and its budgets were introduced once (`3fb84823`) and never
narrowed; no coverage flag has ever existed to be removed; the packet-filename helper appears once,
in `94f1a4d0`, which is also where the deleted-once-ingested lifecycle was established; and no
audit-side citation gate has been built and retired. Two adjacencies constrain **how**, not whether:

1. The line-number trap in `docs/backlog/durable-traps.md` — cite a symbol, never a bare number, and
   an auto-repair pass to the nearest declaration was tried and rejected the same day. It governs
   hand-written prose citations that outlive the tree, while packet provenance is tool-emitted from
   the same read and dies with the run — but it forbids one tempting variant, adopted here as an
   explicit non-goal: **provenance must be given to the lane, never reconstructed from its answer.**
2. The blank-run collapse in `src/audit/extractors/commentDecomposition.ts` is a deliberate
   2026-08-05 choice (`3fb84823`) — what owner question A-Q1 asks about.

### Landing shape

Three planned commits on `lap/cluster-a-packet-provenance`, rebased onto `origin/main` before each:
the shared citation core with its remediate wrapper rewritten in the same commit (atomic replace, no
second copy); archive-then-unlink with the retention test that is this entry's only regression
protection in either direction; then the packet format, coverage, register bump, prompt grammar and
report leg together — splitting them would bump the register schema twice in one sprint and strand
an exported coverage value with no adopter. Four backlog entries are deleted in the commits that
state their traps. A **fourth** commit was added by independent review before landing, for the two
defects it found in the third. Landed on `main` as `5e656206`, `986a2382`, `830885fb`, `d500f2aa`.

---

## Cluster B — status truth

### The corrected defect statements

**`SELECTED-LENSES-IGNORED` holds, and the entry understates it.** The entry blamed prose in the
lane prompt telling the model not to default to one lens. No such prose exists. The operator's
`lens_selection` never reaches the design-review, conceptual or charter prompts in any form —
`DesignReviewOptions` has no lens field — and the two lenses that appeared are exactly the set of
hardcoded literals in `src/audit/extractors/designAssessment.ts` and
`src/shared/decompose/charterExtraction.ts`. `Finding.lens` is unvalidated free text; nothing checks
a returned lens against the selection or even against the canonical vocabulary. `lensBreakdown`
counts only what was produced, so a selected lens with zero findings has no key and the render
suppresses the whole line. The one live resolution, `resolveIntentLensSelection`, is honoured by the
per-file audit draw — which never ran in these audits.

**`CAPABILITY-ASSERTED` is partial, with a corrected mechanism.** The per-analyzer rows are honest:
the failed installs record `resolution: "absent"` with the install error. What is wrong is the
roll-up — `applied` whenever *any* analyzer contributed an edge — and the reader count: exactly one
consumer, `deriveAuditState`, which asks only whether the artifact exists. Nothing reads the status
or any per-analyzer row, which is the write-only-data class an existing reaches-a-reader test was
written to prevent. ⚠ The entry's Property names the wrong channel — the acquired-analyzer signal
already has a degradation vocabulary; the channel that degraded is the language-analyzer/graph one,
reached through `renderSharedStructuralContext`. The gate half holds verbatim and has a second
instance four lines from the first.

**`LANE-OUTCOMES-UNRECORDED` is partial; the core property holds.** The ledger is an *expectation*
record, populated only with lanes the tool itself ingests, so eight dispatched lanes produced two
rows. One sub-claim is **refuted**: two tool-owned artifacts do carry the full roster — what they
lack is an outcome, and they exist only for the deep conceptual pass. The archived run is the
strongest evidence for the property: five lanes that first exited 0 having written nothing were
re-dispatched until they delivered, and the final artifact tree is byte-indistinguishable from a run
where every lane succeeded first try.

### Invariants the tool now guarantees

- **One measured-outcome vocabulary** (`clean | findings | degraded | not_run | not_applicable`)
  with exhaustive `Record`s behind it, so widening it without answering every question is a compile
  error — the guarantee the analyzer channel already delivers, lifted one level up.
- Every findings contract from a run that carried a lens selection states, for **every selected
  lens**, whether it was exercised, and the render prints the un-exercised ones by name. Absence of
  a finding is never readable as absence of a defect.
- Presence and consistency are enforced at the boundaries that own them: synthesis cannot mint a
  summary without lens coverage when a selection resolves, and `validateAuditFindingsReport` — which
  never receives the checkpoint — validates only what it can establish and abstains on presence.
- The capability roll-up is derived from what each analyzer did, and it has **two readers**: the
  report's limitations section and `renderSharedStructuralContext`, the one function every
  design-review prompt renders through.
- An obligation whose input set is empty reports `not_applicable`, never `satisfied`.
- Every **dispatched** lane leaves a tool-written ledger row with a measured outcome, and no such row
  ever enters the expected set.

### Decisive refutations and their adjudication

| # | Refutation | Lane | Adjudication |
|---|---|---|---|
| B1 | `src/audit/contracts/wrapperResponse.ts` restates the obligation-state enum in a shipped JSON schema, so widening it reintroduces the hand-copied-vocabulary drift class the lens module's header exists to record. And `NON_PENDING_OBLIGATION_STATES` (`src/audit/supervisor/operatorHandoff.ts`) is a `Set` literal, which does not become a compile error when the union widens — so the new member silently reads as *pending* on the operator handoff, falsifying the "behaviourally inert" claim | Claude Opus + Gemini, both blocking | **Accepted** — single-source: derive the wrapper enum, regenerate the shipped schema, derive the non-pending set |
| B2 | Two last-event-per-submission readers break on new kinds: one deletes a refusal when a later dispatch row arrives, and the drift section computes "resolved" as trailing-state-is-not-rejected, so the report would claim refusals were re-landed when none were | Claude Opus + Gemini, both blocking | **Accepted** — an ingest-kind predicate applied at every last-event reader |
| B3 | The proposed observation point is an *emission* boundary never reached again once the obligation is satisfied, so a fully successful deep pass ends with 8 dispatch rows and 0 outcomes — indistinguishable from total failure — and a re-minted round id strands the old rows | Claude Opus, blocking | **Accepted** — observe at the round-terminal ingest fold, close superseded rounds, report delivery rate per round |
| B4 | Neither the lens instruction nor the graph provenance can reach the conceptual **judge** — the one lane the tool actually ingests — because its prompt renderer takes no options and never calls the shared structural context. The lens map would report every non-default lens un-exercised forever | Claude Opus, blocking | **Accepted** — the judge prompt gets both |
| B5 | `projectAuditFindingsReportSubset` spreads the summary verbatim, so a projected subset carries a coverage map that no longer matches its findings and fails internal-consistency validation during remediate intake | Gemini, blocking | **Accepted** — re-derive on projection, or omit |
| B6 | Exporting the new shared surface before its consumers land reds `check:deadcode` | both, blocking | **Accepted** — each commit lands producer, reader and test together |
| B7 | The stated red set is misattributed — the assertions named are not the ones that go red — and one proposed test passes at HEAD because the engine already filters strictly | Claude Opus + Gemini | **Accepted** — corrected red set; that test is kept as a guard, not claimed red; the P25 test is rewritten, not deleted |

Two further amendments carry no code: B8 states the three owner assumptions below rather than
silently adopting them, and B9 leaves the rest of the spec standing.

**Supports worth recording.** The lane that examined the retirement directly confirmed the design
keeps `expected: false`, the materializer's filter, and the expected-set builder's outright refusal
untouched, and that dispatch rows are structurally disjoint from the shortfall path.

### Retirement check

**One real collision, and it is the sharpest constraint in the lap.** `94f1a4d0` (P25) deliberately
made conceptual perspectives un-expected, because the tool never reads a perspective's findings — so
an expectation against one can never be satisfied or dropped, and accumulates as a permanent false
shortfall. Any fix that flips a perspective to expected re-adds a defect the repo deliberately
removed.

The design keeps expectation and observation apart structurally, not by convention. *Expecting* an
artifact claims the tool will be owed something and will re-ask until it arrives; *recording an
outcome* states what was observed once. Dispatch rows are appended before and independent of the
expectation recorder; shortfall diffs the expected **set** on a path that never reads ledger events;
a missing perspective ends with a dispatch row and no terminal row, which re-asks nothing and
accumulates in no set. `tests/audit/conceptual-perspective-round-identity.test.ts` is **rewritten,
not deleted** — narrowed to expectation events so the retired defect stays pinned, plus a third
assertion for the new property.

Entries 1 and 2 have no collision, and entry 2 has a precedent pointing the same way: `70da005d`
built the classified-analyzer-outcome vocabulary this cluster lifts. One constraint on *how*: all
lens-coverage code reads the canonical vocabulary from `src/shared/types/lens.ts` and nothing
re-enumerates it, because a hand copy of that list once wrongly rejected a real lens.

### Landing shape

Five commits on `lap/cluster-b-status-truth`, rebased before each, **no seam** — every commit is a
complete replace at its own boundary: the shared vocabulary with its existing consumers re-pointed at
it; the obligation member; the capability record with both readers; the dispatch rows with the
drift-section reader; and last, the lens selection reaching the prompts together with the report
stating what it never exercised, because the report half alone would land a deliberately inert field.
Commits 3-5 are loop-core and each carries a fresh staged-tree-bound attestation. Landed on `main`
as `01cb369e`, `44065eaa`, `aad1d945`, `8dc3ab2c`, `7a624e00`.

---

## Owner decisions taken as working assumptions

Each is in force for the implementation and awaits confirmation.

1. **C-Q1 — what `judge_confirmed` means.** (A) judge-authored, with a required verification note,
   on the same footing the P0 gate already approved for the judge's percentages; (B) permit it only
   on a finding carrying an executable anchor, making the bit the tool's own run.
   **Assumption: (A).** (B) would start the measured rate at zero — zero of 27 conceptual findings
   carried an anchor.
2. **C-Q2 — two count populations.** (A) label them (candidate-scoped on the adjudication artifact,
   finding-scoped on the summary); (B) reconcile them into one number. **Assumption: (A).** They
   legitimately differ — a merged candidate's final finding can still be quarantined downstream.
3. **C-Q3 — the P0 exception.** The two new persisted fields and the summary breakdown extend the
   owner-approved narrow exception to the no-new-persistent-schema rule. Both refuter lanes raised
   it. **Assumption: proceed** — the entry's Property requires them and the lap approval covered the
   entry. Confirm.
4. **A-Q1 — revealed-channel line fidelity.** (A) line-true excerpts, disclosing comment-block
   positions and sizes but never content, undoing part of the deliberate 2026-08-05 collapse;
   (B) path-only provenance for that channel, leaving the Property met for two of three channels and
   the report saying so. **Assumption: (A).** (B) is the smaller rework if the owner picks it.
5. **A-Q2 — stated-channel quota.** (A) an even doc/comment split with spill; (B) weighted toward
   comments, the class the channel is named for, since docs are reachable through another artifact
   and comments are not. **Assumption: (A)** — neither class is a priori more valuable, and the
   measured zero-comment outcome was never chosen.
6. **A-Q3 — retention footprint.** (A) retain all three packets; (B) retain the stated packet only
   and hash the rest. **Assumption: (A).** (B) would not have answered the coverage dispute that
   motivated the entry, which was about the revealed channel. ⚠ **The footprint is not constant.**
   Amendment A8 keys each archived packet by its CONTENT HASH under a `charter-packets/` directory
   with one index row per packet, so a re-extraction **adds** rows and never overwrites — two packets
   differing by one character are two files. Each packet stays individually bounded by the existing
   ceiling, but the directory grows with the number of extractions, not with the number of channels;
   only an identical re-extraction is free.
7. **B-Q1 — delivery-rate policy.** (A) print it and proceed; (B) hold the affected obligation below
   a threshold. **Assumption: (A).** (B) re-creates the re-ask loop P25 removed.
8. **B-Q2 — where un-exercised lenses are reported.** (A) a Summary line; (B) an Audit Limitations
   entry. **Assumption: (A);** moving it is one line.
9. **B-Q3 — custom lenses.** Report non-canonical operator-added lenses in the coverage map like
   canonical ones? **Assumption: yes** — the incident used two custom lenses and the Property says
   *any selected lens*.

**Deferred, outside the three clusters.** sol-1: route the triage sweep through the relay's MCP stdio
dispatch at 60-180 s per entry with no schema channel, or first change llm-relay (a separate
repository) to serve a pool rung over HTTP. **No implementation until the owner answers.**

---

## What the gate cost and what it caught

| | C | A | B |
|---|---|---|---|
| refuter lanes | 2 | 2 | 2 |
| claim blocks returned | 19 | 39 | 25 |
| blocking refutations | 7 | 13 | 12 |
| amendments bound into the brief | 9 | 17 | 9 |
| refutations rejected with reason | 0 | 1 | 0 |
| questions carried to the owner | 1 | 1 | 3 |

Zero of the eight clustered entries survived the gate unchanged. One had its stated cause refuted
outright (C: the disposition it said was missing already existed and had been owner-authorized four
days earlier). One was understated (B's lens entry blamed prose that does not exist; the selection
reaches nothing). Two were narrowed from their stated mechanism (B's other pair). Four reproduced
exactly (A), two of them strengthened by reproduction rather than merely confirmed.

The two most expensive catches were both about *reach*, not about the fix: an observation point that
would never fire again after the first emission (B3), and a shared core that could not be a wrapper
without silently converting sixteen synchronous assertions in files the spec had not read (A6). Both
blocking, both from the deep lane, neither visible from the spec alone. One lane died mid-gate — AGY
Claude Opus hit quota after cluster C, so A and B took Claude Opus subagents instead.

---

## What independent review caught after implementation

The gate ends at the brief. Each cluster then went through a second independent pass — an implementer
who did not write the spec, and a reviewer who wrote neither — which found six things no refuter had.
That is the argument for keeping the two stages apart rather than folding review into implementation.

**The comment mask indexed by code point against code-unit span offsets** — reviewer, blocking.
`scanCommentSpans` walks the source with `source[i]` and `indexOf`, so its offsets are UTF-16 code
units, while `maskCommentSpans` indexed by code point (`[...source]`) and drifted one position left
per astral character before a comment. That is this cluster's own failure inverted: the revealed
channel, whose purpose is to carry code with comment text removed, shipped the `//` delimiter and the
comment text, blanked real code in its place, and `topLevelDeclarationLines` then published a comment
as a declaration. It fires on the motivating repository — three of its 123 source files carry emoji.
Fixed red-first by rebuilding the mask from `slice`, mirroring `stripCommentText`, so mask and strip
take the same indices by construction.

**Four raw NUL separators in a loop-core source file** — reviewer, blocking. In the archive index
keys; they made git classify the file as binary, undiffable and unmergeable. Replaced with `|`, which
cannot occur in a charter kind, a hex digest, or `true`/`false`; a sweep confirmed none remains.

**An unproducible vocabulary value, deleted rather than emitted.** The reviewer's third block was that
`per_file_cap` was declared an omission reason and never emitted; the resolution went the other way.
The per-file character constant is a delivery *clamp* — a candidate it truncates is delivered with
`truncated: true`, one it leaves under the minimum is omitted as `total_budget` — so no site would
honestly report it. A contract test now pins that every declared omission reason has a producer
outside the exhaustive-by-type render table, verified to discriminate by re-adding the value. A value
with no producer is a claim the data can never make: `validation_issues: []` in another shape.

**The cluster B implementer found the zero-task cases neither refuter named.** Both lanes examined the
new `not_applicable` state for drift and for readers; neither traced it to `INV-06`, where
`audit_results_ingested` on a run that owed nothing reported `satisfied`. Two design corrections
followed in flight — the capability roll-up excludes skipped and not-applicable analyzers, and a
resolved analyzer carrying a note is `degraded`.

**The cluster A implementer's own tests caught two allocator defects.** Writing the budget honestly is
what surfaced them: the class spill summed halves instead of tracking the remaining total, letting one
document take 200k against a 148k budget, and the manifest's per-row estimate was used as a bound. The
rendered packet is now measured and re-laid-out once when the real manifest overflows.

**The P50 landing went red on `main`, and only CI caught it.** The lander ran build, typecheck and the
touched area's suite — the repo's stated rule — and pushed. The new test imported `execSync` directly,
which the cross-area `INV-WH` windowless-spawn invariant (`tests/helpers/trackedSpawn.ts`) refuses; it
lives in another area, so no touched-area suite could see it. The repair rode with cluster C's second
commit and `main` was green again at `6e7b1d01`. The general form — a touched-area suite cannot see a
cross-area invariant, and nothing gates a push on a full-suite stamp — is routed to
`docs/backlog/open-bugs.md`.

---

## Friction the gate itself hit

Each is recorded at its home rather than restated here; this list is the routing.

- **Backlog entry text is gated only at commit, never at write time** — nine entries written in an
  earlier session failed `check:doc-code-citations` and then `check:backlog-line-numbers` in sequence
  at the first commit attempt. → `docs/backlog/open-bugs.md`.
- **A push to `main` is not gated on a full-suite stamp** (the P50 landing above).
  → `docs/backlog/open-bugs.md`.
- **Two heavy vitest files can hit the per-file timeout under full-suite load and pass alone.**
  → `docs/backlog/durable-traps.md`.
- **`wmic` is absent from Git Bash here**, and **the relay's proxy daemon loads its configuration
  once at start** (so a ladder edit did not take effect until a restart, and the first two dispatched
  lanes ran on the previous model without saying so). → machine-wide backlog, not this repository's.
