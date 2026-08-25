# N-R13 and lean_fast_path — what the history actually says

Two owner questions, traced independently four times, each trace refuted by a second lane.
Every claim below carries a sha or a `file:line`. Where a refutation overturned a trace, the
correction is stated inline. Where nothing was found, it says *no evidence found*.

Tree anchor: HEAD `b3f198ad` (2026-08-25).

---

## Question 1 — the per-item document phase

### When it was dissolved

`13dd9288ce75bf2014abe724979b7aef2592c377` — 2026-06-11 13:51:24 -0700 —
**"feat: full pipeline redesign — rolling dispatch, seam negotiation, intent checkpoints,
dissolve document phase"**.

That single commit is the origin of the id. `git grep -n "N-R13" 13dd9288^` returns nothing.
It introduced every `N-R13` reference at once: two comments in `packages/remediate-code/src/steps/nextStep.ts`,
the invariant test `packages/remediate-code/tests/n-r13-document-phase-dissolved.test.ts` (+327),
and a `next-step.test.ts` case. It also removed the live `prepareDocumentDispatch` from
`src/steps/dispatch.ts` and `index.ts`.

The dissolution was **one line item inside a 46-node bundled redesign commit**.

Two corrections from the refutation lanes:

- A rival trace named `32769bff` (2026-06-15) as the earliest N-R13 commit. **Wrong.** That trace
  ran `git log -S` over `src/ spec/ docs/ CLAUDE.md` and missed the pre-`84ab9248` monorepo
  `packages/` path. Four commits carry the string; `13dd9288` predates all of them.
- `508e7096` (2026-06-09, "delete dead in-process document path") is **not** the dissolution.
  It removed only the CLI-unreachable `runDocumentPhase` (`phases/document.ts`). The live
  dispatch path survived until `13dd9288`.

### The stated rationale

`docs/remediation-workflow-design.md` was **added by the same commit** (`--diff-filter=A` on
`13dd9288`), §"The document phase dissolves", lines 245-253:

> With contracts, obligations, file scope, and test specs established upstream, the per-finding
> document worker has nothing left to invent. Document becomes a thin deterministic translation
> (DAG node + contracts → dispatch prompt). One worker type remains: implementers executing DAG
> nodes. The document/implement two-phase state machine, its separate dispatch/merge commands,
> and the documented→implementable handoff collapse into the rolling dispatch loop below.

Supporting complaint, same file, line 199:

> Today `tests_to_write` is invented by document workers at dispatch time — LLM judgment where a
> planned obligation should be.

There was a real problem that week. `4e20406f` (2026-06-10) logs it:
`docs/backlog.md@13dd9288^:21-27` — "**Document-phase dispatch prompts render empty Files/Read
allowlists.** … every 2026-06-10 contract-run documenter hit this."

### Whether the owner approved it

**No evidence found.**

Three strings read as approval. All three were written by `13dd9288` itself:

1. Commit message: "Implements the full both-pipeline redesign (46-node DAG) agreed 2026-06-10".
2. `docs/remediation-workflow-design.md@13dd9288:3` — "Agreed decisions from a full walkthrough of
   the remediation pipeline (2026-06-10)."
3. `docs/backlog.md@13dd9288` — "Remediation workflow redesign — *spec complete 2026-06-10* …
   Full design agreed".

The design doc was not committed on 2026-06-10 and reviewed before implementing. It was committed
on 2026-06-11, bundled with the implementation. Its only co-author trailer is
`Claude Sonnet 4.6`.

Nothing independent corroborates it:

- `.claude/nightly-decisions.json` — 208 entries, **earliest 2026-07-26**, six weeks after.
  No hit for "document phase", "documenting", "N-R13", or "document worker".
- `.claude/constitutional-doc-review/` — owner-decision records exist (e.g. the 2026-08-09 routing
  cut, quoting the owner verbatim). None mention the document phase.
- `docs/reviews/` — a rival trace claimed no June record exists. **Correction: two do**
  (`churn-context-enforce-pass-2026-06-27.md`, `quota-prewall-pacing-diagnosis-2026-06-30.md`).
  Neither mentions the document phase.
- `docs/handoff.md@13dd9288^` (2026-06-09) lists one next task. No redesign.
- Project memory store: zero hits.

One lane argued approval **is** evidenced, because `13dd9288`'s author is
`OhOkThisIsFine@users.noreply.github.com` — the owner's GitHub identity. **That argument is
neutralized.** The same identity signs plainly agent-generated commits, and the repo's commit
authorship splits across `test` (1498), `Test` (641), and `OhOkThisIsFine` (480) for the same
person. Git authorship discriminates nothing here.

The N-R13 node id implies a numbered 46-node plan (`N-S*`/`N-A*`/`N-R*`/`N-D*`). **No file in any
branch enumerates it.** If a plan was shown to the owner, the artifact is gone.

Honest read: **agent-originated, self-attested, never independently recorded.** Not remembering it
is consistent with the evidence. The one thing not searched is out-of-repo session transcripts —
no local transcript predates 2026-08-01, so this cannot be settled from this machine.

### What exists at HEAD instead

Nothing replaces it as a producing step.

- 8 statuses, no `document`/`documenting` — `src/remediate/state/store.ts:20-29`, mirrored at `:89-98`.
- `src/remediate/phases/` holds 6 files. No `document.ts`.
- `handlePlanning` runs `runPlanningReviewGate` (`nextStep.ts:2616`) and `runPlanAmbiguityGate`
  (`:2750`), then transitions straight to implementing (`:2874-2912`). Neither gate mints an `ItemSpec`.
- Items are minted with three fields — `finding_id`, `status`, `block_id` (`nextStep.ts:665-670`).

`ItemSpec` survives as a contract (`types.ts:143-173`, optional at `:376`) that **zero production
code writes**. An exhaustive grep finds two src hits, both readers projecting outward
(`close.ts:321`, `hostHandoff.ts:736`); the other 28 are test fixtures. `ItemSpecSchema` is never
`.parse()`d.

Consumers therefore always take the fallback:

- Enforced write scope = `block.touched_files` (`hostHandoff.ts:753-755`), not the spec.
- Access memory falls back to block surface (`accessMemory.ts:59-62`).
- Close attribution sees `[]` (`close.ts:1096`), so per-item test-failure attribution always misses
  and the fallback at `:1104` blocks **all** resolved items rather than the implicated ones.
- The autonomous gate synthesizes a stub spec (`autonomousGate.ts:207-216`); `:114` says outright
  "At the review gate there is no ItemSpec yet".

Lost with no successor: `tests_to_write`, `not_applicable_steps`, `no_change` — validated, never populated.

Two loose ends:

- The comment at `nextStep.ts:2875` claims the workload "reads item_spec from the plan DAG node when
  present". **Unbacked.** No DAG node carries one. The nearest candidate,
  `contractPipeline.ts:4254` (`concrete_change`), is stripped: `FindingSchema`
  (`src/shared/types/finding.ts:194`) is a bare `z.object` with no `.strict()`/`.passthrough()`, so
  `FindingSchema.parse` at `hostHandoff.ts:735` drops `concrete_change`, `preconditions`, and
  `expected_changes`. A refutation lane **executed** this parse and confirmed the strip.
- `nextStep.ts:760-768` carries forward a spec that no code can create.
- The invariant test is partly vacuous — audit finding `TST-cf496f2a`: the first describe block
  asserts a locally-declared literal array, not the real `RemediationState` type, so a reintroduced
  `documenting` status passes silently. The other three blocks test real code.

---

## Question 2 — lean_fast_path

### When it appeared and why

`4adbd9bd` — 2026-06-17 — "feat(remediate): A1 — conservative lean fast path past the contract
pipeline". Added `packages/remediate-code/src/steps/leanFastPath.ts` with `evaluateFastPath` (the
gate) and `buildLeanExtractedPlan` (the producer).

Rationale from the commit message: a handful of grounded, high-confidence, localized findings
should not "pay full adversarial + 3-repair-loop cost"; the gate defaults to the full pipeline on
any doubt.

It was greenlit two days earlier as backlog item **A1** — `docs/backlog.md@4adbd9bd^:43`,
"Fast path past the 15-phase pipeline", inside "## Accepted go-forward program (2026-06-15
review)" (`:29-35`), recorded by `111a91e7`. Caveat: that record is agent-authored prose, the
referenced artifact `.audit-tools/deferred-items-for-review.md` is untracked, and what was greenlit
was a one-line target — not the forked-classifier shape that shipped.

**It predates the conviction it collides with.** `spec/self-scaling-pipeline-design.md`
(`89d90bce`, 2026-06-26) was written to supersede it; conviction A6 entered
`docs/project-philosophy.md` on 2026-07-02 (`c3ee8d7d`).

Reconciliation, in order:

| sha | date | effect |
|---|---|---|
| `8efcbfd9` | 2026-06-26 | zero-scrutiny skip → mandatory light adversarial review floor |
| `1280d04b` | 2026-07-09 | deleted `evaluateFastPath`; lean path taken **iff** tier is `low` (D-68) |
| `02f13523` | 2026-07-11 | retired `steps/leanFastPath.ts`, relocated its two mechanisms (DD-21) |
| `594046d7` | 2026-08-25 | reworded the misleading "fast-path exception" heading |

One anachronism to correct: the intake risk tier (`riskSignal.ts`) only landed `23d12c07`
(2026-06-26). Calling `evaluateFastPath` a "second classifier" is accurate as of the fold, not as
of introduction — at introduction there was nothing to be second to.

### One pipeline at two depths, or two paths — the mechanical answer

**It splits at exactly one seam: the plan producer.**

Two producers:

- `buildLeanExtractedPlan` — `contractPipeline.ts:4543-4554`. Eleven lines, returns a literal,
  calls no phase, no gate, no LLM step.
- `promoteImplementationDagToExtractedPlan` — `contractPipeline.ts:4071`, terminus of the full sequence.

The lean branch is a **bypass, not a shallow traversal**. It returns at `nextStep.ts:2161-2170`
before `writePathASeedFromFindings` (~`:2203`), the pipeline's entry seed. Every reader of
`pathASeedFilePath` lives inside `contractPipeline.ts` / `contractPipeline/phaseCutArtifact.ts`.
The test asserts it too: `tests/remediate/lean-fast-path.test.ts:191-193` —
`expect(step.step_kind).not.toBe("contract_pipeline")`.

One of everything else:

- One classifier — `riskSignal.tier === "low"` (`nextStep.ts:2109`).
- One artifact — both writers hit `extracted-plan.json` (`nextStep.ts:2146-2149`,
  `contractPipeline.ts:4404`, path at `intake.ts:121`).
- One consumer — `handlePendingExtractedPlan` (`nextStep.ts:1265`) → `normalizeExtractedPlan`
  (`:575`) → `applyPlanPipeline` (`plan.ts:373`).
- One output contract.

Genuine dials also exist and are real: `adversarialDepthForTier` (`riskSignal.ts:63-65`) and
`roundTripGranularityForTier` (`:83-87`) are consumed **inside** the pipeline
(`contractPipeline.ts:1802`, `:3487`). That is literally "one pipeline, two depths" — and it is a
different mechanism from the lean bypass.

Correction to `CLAUDE.md`: its `touched_files` claim is true but mis-keyed. `normalizeExtractedPlan`
branches on `rawBlocks.length > 0` (`nextStep.ts:597`) — artifact **content**, not the source tag.
Lean plans carry no `blocks` (pinned by `lean-fast-path.test.ts:129`), so they fall to `:610-615`.
The only branch on `plan.source` anywhere in `src/` is `nextStep.ts:1316`, and it makes the lean
path **stricter** (`evidenceGrounding: plan.source !== "contract_pipeline"`), not laxer.

### Whether it collides with the one-pipeline conviction

Yes, and the owner already ruled on it.

`.claude/nightly-decisions.json` key `7fc1c1d310dda95d`, decided 2026-07-26:

> subject: "The lean fast path is a real structural fork at HEAD — sanctioned exception to 'one
> pipeline', or the defect?"
> answer: "**It is the defect.** THE BRIEF settles it: depth and granularity are dials on ONE
> pipeline, never a separate lighter path. Fold the lean fast path into the self-scaling continuum."

Again on 2026-08-25, key `a04a8cfcef8b908e`:

> "One mechanism, two depths: reword the goals doc to 'one mechanism, two traversal depths;
> plan.source records provenance only', matching the self-scaling pipeline design and conviction A6."

**Refutation correction:** one trace reported "no evidence of owner approval, question still open"
for this. That was wrong — it searched `docs/`, `spec/`, and `.audit-tools/`, but never `.claude/`,
where the decision ledger lives. Same trace claimed `D-68` and `DD-21` resolve to nothing; `D-68`
had a backlog entry inside the diff of the very commit it cited, sits at `nextStep.ts:2077`, and
`DD-21` is recorded in `.claude/hooks/doc-review-resolved.json`.

The 2026-07-26 ruling **post-dates** the fold that shipped 2026-07-09 (`1280d04b`). It confirmed a
direction rather than initiating it.

Residue: the fork the owner called the defect is 90% gone — selection, artifact, consumer, and
depth dials are single-sourced. What survives is the second plan producer plus its bypass branch,
and one doc (`spec/remediate/remediation-goals.md:104`) still describing it as a second mechanism.

---

## Where the two questions meet

Both are the same failure shape, four weeks apart.

1. **Deletion stopped at the producer.** N-R13 removed the writer of `ItemSpec` and left the
   schema, a hand-rolled validator, a carry-forward branch, and 28 fixtures serving a field nothing
   writes. `1280d04b` removed the fast path's classifier and left its producer. Neither swept
   consumers.
2. **The rationale doc shipped in the commit it justifies.** `13dd9288` added
   `docs/remediation-workflow-design.md` and implemented all 46 nodes at once. There was no
   reviewable interval.
3. **The invariant that was supposed to lock it is soft.** `n-r13-document-phase-dissolved.test.ts`
   has one vacuous block; `spec/self-scaling-pipeline-design.md:77` ("No separate document lean path
   ⇒ no separate plan-builder") dissolved the separate plan-builder for *document* input only — for
   structured-audit input one still exists at HEAD.
4. **N-R13's premise is the fast path's exception.** The dissolution rests on "contracts, obligations,
   file scope, and test specs established upstream." The lean branch never enters the pipeline
   (`nextStep.ts:2168-2170`), so on that path nothing is established upstream —
   `normalizeExtractedPlan:610-615` copies `finding.affected_files` instead. The premise holds for
   the contract-pipeline path and does not hold for the lean one.

Also worth noting: `CLAUDE.md:118-126` already states the N-R13 shape correctly, including the
"`ItemSpec` is NOT the write scope" correction. That is owner *awareness* of the dissolution. It is
not a record of the decision.

---

## What is genuinely undecided

Four owner decisions, stated as questions.

**1. Does the N-R13 dissolution stand?** It shipped without any recorded approval. It is now four
weeks of downstream design deep. Options: ratify it as-is and clean up the residue; ratify the
principle but restore `tests_to_write` as a *planned obligation* (the thing the rationale said it
should be); or reopen it. Nothing forces a choice today, but it is currently standing on
self-attestation alone.

**2. What happens to the `ItemSpec` corpse?** Zero writers, five readers, a `.strict()` schema, a
hand-rolled validator, a carry-forward branch, 28 fixtures. Delete it outright, or give it a
producer? Note the real bug riding on it: `close.ts:1096` always reads `[]`, so a close-gate test
failure blocks every resolved item instead of the implicated ones.

**3. Is the last lean fork closed, or deliberately kept?** You ruled "it is the defect" on
2026-07-26. Selection, artifact, consumer, and depth dials are unified. `buildLeanExtractedPlan`
(`contractPipeline.ts:4543`) and the bypass at `nextStep.ts:2161-2170` are not. Finish the fold, or
sanction this remainder as the low tier's realization?

**4. Apply the 2026-08-25 reword?** Ledger key `a04a8cfcef8b908e` is answered but carries **no
`completed_at`**, and `.audit-tools/nightly/open-items.json` still lists `docs-8` as open with three
unselected options — the ledger and the queue disagree.
`spec/remediate/remediation-goals.md:104` still calls `lean_fast_path` a second mechanism. Per this
repo's own convention, answered ≠ executed.

Homes for these: (1) and (2) → `docs/backlog/open-bugs.md`; (3) → `docs/backlog/forward-tracks.md`;
(4) → the nightly queue, already there as `docs-8`.
