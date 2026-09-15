# Conceptual / design review — design

> How the auditor's conceptual design pass finds *design* defects: not "is this module
> correct/clean" but "is this the right module, serving the right purpose, as well as a better
> design could." Durable conceptual design; no dated status here.

## Problem — the defect lives at a seam, not an altitude

Design reviews fail two ways, and both miss the class that matters most:

- **Too high** — "the architecture is coherent" → misses that a subsystem *underdelivers*.
- **Too low** — "this module is clean" → misses that clean ≠ serving its purpose.

The target class — a subsystem that is *locally* well-designed but does not serve its *true* goal as
well as it could (its usefulness is defined by its ties to other subsystems and to the top-level
goals) — is invisible at **either altitude alone**. It only appears when a reviewer holds **one
thread at full height at once**: this subsystem ↔ its real purpose ↔ the top goal. So the reviewer
is not given "everything and told to find problems" (it drowns); it is given a **thread to pull** —
full-height but narrow.

Two sweeps fall out, both needed:
- **Vertical (thread) review** — one full-height thread (subsystem ↔ its purpose ↔ the telos); the
  mechanism this whole doc describes.
- **Horizontal (ladder-integrity) review** — do the charters *collectively tile the telos*? A telos
  obligation **no** charter owns (a gap), two charters that **overlap** or **conflict** — these are
  findings a vertical thread reviewing each node individually cannot see. Here the fix is sometimes
  not a better module but a **re-drawn charter boundary**. (Distinct from the structure/charter
  non-co-localizations below, which are per-region; this is telos-wide coverage.)

This is *not* /init. /init is whole-repo distillation → a durable bootstrap doc (prose, one-shot, no
contract, output treated as authoritative). Two things transfer from it and nothing else: (1) its
**negative-constraint discipline** — most of its prompt is *what not to emit* (no obvious, no
generic, no discoverable, no fabricated) → port that into conceptual-reviewer worker guidance as an
anti-slop filter; (2) its **targeting** — "the cross-file big picture no single-file view catches."
The mechanism below is otherwise a different genre.

## The one operator — overlay-and-delta (used at two layers)

The single reusable primitive:

```
decompose(sources, target) → { consensus, contested }
```

Feed it several **independently-sourced** views of a `target`; where they **agree** you have signal,
where they **disagree** you have a finding *and* a hotspot for extra review. You never reconcile the
views into one truth. This operator runs at two layers:

- **Structure layer** — `target` = "what are the pieces." Sources = the decomposition signals below.
- **Charter layer** — `target` = "what are the pieces *for*." Sources = the four charters below.

"What are the pieces" and "what are they for" are the same question at two resolutions, so they share
the operator. **A subsystem is where a structure-consensus and a charter-consensus co-localize.**

## Nodes are discovered, not decided

Do not pre-define what a "subsystem" is. A node is an **emergent coincidence**:

- **Agreement across sources locates nodes** — a boundary multiple decompositions draw = a real node,
  the scaffold on which charter review runs.
- **Disagreement locates defects** — a boundary the code-graph draws but the docs-graph doesn't = a
  coupling the design never acknowledged (or a module serving no stated purpose); a boundary the docs
  draw but the code violates = an intended separation the implementation broke.

Nothing is wasted: the ambiguity that made "what is a subsystem?" hard **is** the two-sided output.

### Granularity resolves across scale, not by picking one
Cluster at **many resolutions**; a boundary is "real" to the degree it is **stable across scales**
(persists coarse→fine). This yields **emergent nested depth** — as deep as there are stable nested
boundaries, no deeper — which is why telos depth (L0, L1, L2, …) is *never mandated*; it falls out.
Each candidate node therefore carries **two orthogonal robustness scores**: *stable-across-scale* and
*agreed-across-source*. High on both = confident subsystem (run full charter review). Low on either =
contested (route to more adversarial review; is itself a finding).

### Which nodes are worth reviewing — the predicate (the stop-rule's other half)
Emergent nested depth would review endlessly. The bound is **not** a depth cap but two conditions:
- **Review-worthy predicate** — a node earns a review only if it has a charter *nameably distinct
  from its parent* **and** enough coupled implementation to be judged. (Filters degenerate levels.)
- **Convergence (loop-until-dry)** — keep seeding overlapping reviews until TWO CONSECUTIVE rounds
  surface no new misalignment; a single quiet round never terminates the loop. The enforcement
  executor derives the rule from the persisted rounds and records it on the register as
  `convergence_rule`.

Together these are the stop rule; blast radius (below) then ranks what remains.

### Structure decomposition sources — two families
- **Intent-declared structure** (what humans *assert* the pieces are): docs, README, ADRs, user
  feedback, **comments**, directory/naming. ↔ Stated/Structural charter.
- **Behavior-exhibited structure** (what the system *does*): call/import coupling clusters;
  **data/state coupling** (code touching the same artifact/state even with no direct call);
  **change-coupling** (git co-change — files that historically change together; temporal, independent
  of the static graph, language-neutral pure git-mining). ↔ Revealed charter.

Two rules:
1. **Behavioral graphs are computed deterministically** (coupling / co-change clustering) — cheaper
   and better than an LLM eyeballing code. Spend LLM reviewers on the *intent graph*, on *semantic
   grouping* (modules doing "the same kind of thing" that coupling misses), and on *interpreting the
   deltas*. A comments-stripped LLM pass is worth running as a semantic-cohesion signal **that
   disagrees with** pure coupling — an addition to the deterministic backbone, not a replacement.
2. **Comments are their own delta** — comments are stated intent embedded in code. Run stripped and
   unstripped; where a comment claims a boundary the code doesn't honor, that's a drift finding.

### The two non-co-localizations are first-class findings
When structure-consensus and charter-consensus **fail** to coincide:
- **Behavioral cluster with no coherent purpose** → accidental complexity / dead subsystem.
- **A purpose with no behavioral cluster** → a goal *smeared* across the codebase, never modularized
  (often the highest-value refactor).

## The estimator charters — three blind goal DAGs, then correspond, differ, verify, report

There is no single "charter." There are three channel-pure **estimators** of what the code is for —
each fed a disjoint evidence channel (blindness is a property of the INPUT packet the tool
materializes, never an instruction the agent must obey) — plus the downstream-nominated **True**.
The value is in the **differences** between the estimators, verified against their own sources
and reported without a merge.

| Charter | Channel (fed, not instructed) | Node scope |
|---|---|---|
| **Stated** | testimony — docs + extracted comments | provenance only; file scope optional |
| **Structural** | intent frozen into organization — file tree / declarations / import graph; no bodies, docs, or comments | file scope + provenance |
| **Revealed** | behavior — comment-stripped bodies | file scope + provenance |
| **True** | none — nominated by a reader of the discrepancy report at the `deepest` ceiling | — |

The layer runs as five bounded steps. Each is one obligation; the first three are host judgment,
the fourth is host judgment behind a mechanical pre-check, the fifth is a tool render.

### 1. Three independent goal DAGs

Each lane self-organizes ONE leveled goal DAG from its own packet: nodes are purposes stated as
telos (the WHY, never the mechanism), edges mean `from` SERVES `to`, and both nodes and edges carry
evidence references into the packet. The three DAGs share one node and edge definition
(`GoalGraphSchema`), so they can be compared, and they are **persisted as three graphs** — nothing
downstream collapses them into one. A lane mints its own local node ids; ids are never a join key.
`premise_height` is derived from the edges by the tool; a lane-stated level that contradicts its
own edges is a validation issue on that lane.

- **A charter states purpose in terms of the telos, not its mechanism** — "host handoff exists so
  bounded semantic work can be delegated safely and resumed," *not* "it writes workload JSON." A
  node that restates the code is useless as a yardstick — the difference against the implementation
  collapses to zero and the review can never find under-delivery.
- **Revealed is the objective anchor** — "what the code optimizes" is far more extractable than any
  intent charter. Not *right*, but the one you can pin down.
- **Every node and edge cites provenance** into its own packet — a difference is only adjudicable if
  each side is attributable — and **carries confidence**. A low-confidence node downgrades any
  difference that rests on it to "flag for human intent input," never opine. Confident-but-wrong
  findings from bad charters are the whole approach's central failure mode; this is the *general*
  guard, of which the fidelity step and the True-charter gates below are the strict instances.
- **Scope follows the evidence.** Structural and Revealed nodes name the files they describe.
  Stated nodes may carry provenance only: docs name goals and symbols, rarely files, and a guessed
  scope would pollute the correspondence candidates below.

### 2. Correspondences — which regions of the three DAGs speak about the same thing

A separate comparison pass, run by a reader who authored none of the three DAGs, matches regions
that concern the same subsystem or express the same goal. A correspondence joins one node on one
side to one node, several nodes, or a connected subgraph on another. The three DAGs are preserved
unchanged beside the correspondence set; a correspondence is a record ABOUT them, never a merge of
them.

The key is **hybrid**, by the right-tool rule:

- **The tool proposes candidates** from two deterministic signals it already holds: file-scope
  overlap between nodes, and provenance cross-references (a Stated node whose provenance cites
  symbol Foo in file X is a candidate for the Structural and Revealed nodes whose scope holds
  file X; the comment lexer already extracts those cross-refs).
- **The host confirms, rejects, widens to a subgraph, or adds.** A host-added correspondence must
  cite two provenance refs, one per side, that the tool re-checks against the packets; one with no
  checkable evidence is dropped as a validation issue, never admitted.
- **A node with no candidate and no host match stays uncorresponded.** That is a fact the report
  states (a goal one channel sees and the others do not reach), not an error.

The structure decomposition is NOT the correspondence key. It remains the *grouping* key for the
report (step 5) — file overlap of the corresponding nodes' scopes places a difference under a
subsystem — which separates two roles the file-overlap join used to conflate.

### 3. Differences — what the corresponding accounts disagree on

For every correspondence the same pass records the differences between the accounts, each typed
on exactly one closed **dimension** and one **relation**. The decision rule says when a difference
is filed on that dimension and not another; every case has one home.

| Dimension | Definition | File here when |
|---|---|---|
| **Purpose** | The same subsystem serves different ends | Holding the subsystem fixed, the goal labels still contradict (an explicit non-goal against a pursued goal files here) |
| **Presence** | A goal has no counterpart in a channel that should cover it | No node at the same level matches; a missing child goal or intermediate purpose counts here, at its level |
| **Responsibility** | The same goal is grounded in a different subsystem | Goal labels match, owner or location differs |
| **Hierarchy** | The same goal has different parents or a different subgoal decomposition | The node matches, the edge set differs |
| **Scope** | The same goal applies at different times, to different actors, or to a different extent | Adding a when / for-whom / to-what-extent qualifier reconciles the claims |
| **Standing** | The same goal has a different lifecycle status: planned, active, deprecated, removed | The claims reconcile once versioned in time (a roadmap entry against live code is Standing, never Presence) |
| **Standard** | The same goal and scope carry a different success threshold or quality attribute | Both agree on what and where, disagree on how well |

There is no "detail" dimension: one account explaining more than another is the `complementary`
relation on whichever dimension the extra material belongs to, and a mechanism or intermediate
purpose absent from one account is a Presence gap at that DAG level. Importance is not a dimension
either: the DAG level and fan-in are severity evidence on a Presence or Hierarchy difference.

A difference record holds the account of EVERY channel in its correspondence — two or three —
each with its provenance. The **relation** is judged across all of them: `equivalent` (the same
claim in other words), `complementary` (no account contradicts another; one says more), or
`incompatible` (some two accounts cannot both hold). An incompatible record also states its
**split**: `two_against_one`, naming the odd channel, or `three_way`. The record carries the
correspondence it rests on, the accounts, the dimension, the relation, the split, and a
one-sentence statement of the gap. Three-way agreement is the strongest corroboration a goal can
have; a three-way disagreement is always a clarification, never a routed fix.

- **Equivalent records are corroboration.** They raise the confidence of the matched goal and
  generate nothing downstream.
- **Complementary is never a finding on its own.** Absence is not disagreement. The one exception
  is a Presence difference where the silent source's channel SHOULD cover the goal — a doc set that
  never states a subsystem's purpose — which the comparison marks explicitly as a covered-channel
  gap.
- **Incompatible records are the candidates for findings**, subject to the fidelity step.

### 4. Fidelity — is each difference in the sources, or in a reader's head

Every `incompatible` difference, and every covered-channel Presence gap, is checked against its
own sources before it can become a finding. The check has a mechanical half and a judgment half,
and the judgment is a **separate adversary lane** — a reader who authored neither the DAGs nor
the differences, allowed to refuse.

- **Mechanical pre-check (tool).** Every provenance ref and quote on both sides of the difference
  is re-read from disk, through the same grounding pass findings already pass. A side whose quote
  is absent at its ref makes the difference `unverifiable`; it never reaches the lane and is
  recorded as a validation issue against the reader that cited it.
- **Judgment (adversary lane).** The lane receives ONLY the difference record and the
  tool-materialized source slices its provenance cites — the same packet mechanism the extraction
  lanes use, so blindness is again a property of the input. It returns one verdict:
  - `supported` — the two sources genuinely say different things;
  - `interpretation` — a reader read more into a source than it says, naming which side;
  - `unverifiable` — the cited material does not settle it.
- **Only `supported` differences become findings.** An `interpretation` verdict is a
  lane-quality signal: it is recorded on the difference, and a high rate against one lane is
  grounds to re-run that lane, never grounds to keep the difference.

This is the general guard against the approach's central failure mode — confident findings from
a misread source — and it replaces self-reported confidence as the only line of defence. The lane
is combined with nothing: the comparison reader cannot judge its own over-interpretation, and the
True-charter reader below needs the fidelity verdicts as input.

### 5. The discrepancy report — the product, rendered, never merged

The report is a tool render of the difference records that survived fidelity. Nothing in it is
authored by a host: every field exists after step 4. For each finding it shows the corresponding
nodes from each DAG, each source's account with its provenance, the dimension and relation, the
fidelity verdict, and a concrete **investigation question** phrased for the triangulation loop
below. Findings are grouped by subsystem (the structure decomposition unit the corresponding
scopes overlap) and by dimension. Uncorresponded nodes are listed per channel as facts.

- **Disagreements are preserved.** The three accounts stand side by side; no majority account, no
  unified sentence, is authored anywhere in the layer. A consumer that needs one line of
  orientation renders the three accounts, never a merge.
- **Routing keys on the difference, not the channel pair.** A fixed tool-owned table maps
  `(dimension, relation, split)` to who acts: a `two_against_one` with Stated odd on Purpose or
  Scope is doc rot for the **remediator**; a Structural-odd or Revealed-odd Responsibility or
  Hierarchy difference is an architecture question for a **clarification**; a Standing or Standard
  difference is a **clarification** (which account is current is the owner's call); a Presence
  covered-channel gap routes by the silent channel; every `three_way` difference is a
  **clarification**. The host never picks a route.
- **Blast radius** is computed per DAG over the corresponding nodes and the maximum is taken: a
  goal high in any one source's hierarchy is high-blast.
- **True is nominated downstream of the report**, at the `deepest` ceiling, by a reader who has
  seen the report and the fidelity verdicts, under the hard gates below.
- **Staleness gains a teleological layer**: Revealed re-extracts on code change, Stated only on
  user input → a *closed* difference that **reopens** is itself a signal ("this subsystem is
  drifting from its charter over time").

### The True charter needs hard gates (or it discredits the reviewer)
An LLM asserting "what you *really* want is X, not what you said" is the canonical over-confident
failure, and where a model hallucinates profundity ("what you truly want is elegance") — /init's
anti-fabrication ban at the top of the stack. Non-negotiable:
- **Nominatable, never assertable** — the tool nominates candidates for the human to recognize or
  reject; framed as provocation, never verdict.
- **Falsifiable-or-drop** — a True claim must name a concrete alternative + a concrete cost the user
  seems to be paying unaware ("Quicken exists; you're rebuilding a worse one"). Un-falsifiable → slop
  → kill it.
- **Human-only channel, never auto-actioned** — it routes to strategic provocation, never into the
  fix pipeline (its remedy might be "delete the project").
- **Highest adversarial bar** — max independent refutation before it reaches the human at all.

## Blast radius — the ranking and the risk gate

Every finding carries a **blast radius**: how far up the goal graph its fix ripples (goals are a
**DAG, not a tree** — a node serves multiple parents; an L2 change on one side can force an L1 reframe
on the other). Blast radius is simultaneously:
- **priority** — high-blast = high-value (re-drawing a charter boundary beats a leaf fix), and
- **risk** — acting on a *wrong* high-blast finding is catastrophic → it must clear a **much higher
  bar of independent adversarial refutation** before it is actionable.

Because clean decomposition is impossible (goals overlap; reviewing each node once cannot cover them),
findings come from **many overlapping, differently-scoped, redundant reviews mined for
disagreement** — a fleet across the matrix {altitude/span} × {which charter} × {adversarial role},
independent and bounded (the provider-neutral host workload is built for exactly this), converged by
**loop-until-dry** (keep seeding until two consecutive rounds surface nothing new — the
convergence rule above).

## Control surface — three currencies, three dials

Every knob must meter a **currency no other knob touches** (else it is a smell — see *auditor-agnostic
robustness*). There are exactly three:

### 1. Intensity — currency: compute/tokens (auto-scaled)
How much redundant adversarial effort *at* each level (more overlapping reviewers, more refutation
rounds). Pure budget → scale it automatically; the user does not set this.

### 2. Ceiling — currency: premise-height / consent (intent checkpoint, defaulted)
**How far up the premise stack a finding may reach.** This is the single axis that "deep vs shallow"
and "independent-vs-guided decomposition" both collapse onto — they are not separate options:
- **shallow / guided** → leaf + contract findings, Stated−Revealed drift (low blast). "Review the
  code *within* my design."
- **deep / independent** → charter-deltas, smeared-purpose, accidental-cluster findings (mid–high
  blast). "Review my design *within* my goals."
- **deepest** → Revealed−True, Stated−True provocations (max blast). "Review whether these are the
  right goals."

Independent-and-intersect decomposition is "deeper" *because* it produces higher-blast findings — so
it falls out of the ceiling, it is not its own switch. The ceiling carries **consent** (its top rung
is the tool telling the user to abandon/rescope), so it is **meta-intent captured at the
`intent_checkpoint`**, not a CLI flag — *"take your goals and module boundaries as given, or put them
up for challenge?"* Defaulted from how goal-specified the repo looks (rich docs/charters → boundaries
more trustworthy → start conservative; sparse → boundaries suspect → start higher); the top rung
requires **explicit** opt-in. Conversation-first: no answer needed unless the user overrides.

### 3. Attention — currency: human attention (the clarification loop)
How much the user will converse to align the charters. Independent of tokens (you can be compute-rich
but attention-poor) — which is why it earns a third dial.

## The triangulation loop — review-first is what makes charter questions answerable

The True charter is **inexpressible cold** — "what do you really want?" is the unanswerable blank
page. The review's job is to **convert that into a decidable question**: not "what do you want?" but
*"your code optimizes X, your docs say Y, they collide at this seam — which governs?"* So charter
alignment is not a post-step; it is a **loop** interleaved with re-review:

```
show delta → user picks → charters update → deltas re-derive → next question
```

Each answer is a coordinate; the True charter is the point the answers converge toward (triangulated,
never extracted). The attention dial = **how many rounds** / how far down the question queue. Rules:

- **Rank questions by value-of-information** — how much charter-uncertainty each answer collapses
  (one that resolves a high-blast True-delta *and* cascades to settle several downstream findings
  beats a leaf clarification). The dial = how far down the VOI-ranked queue you go, so low-appetite
  still gets the **highest-leverage** questions, not merely fewer.
- **Questions are symmetric** — any charter may move, **including Stated**. The tempting
  "here's where your code violates your intent, shall we fix the code?" silently anoints Stated as
  ground truth and throws away the entire True-charter payload. A question resolves to any of:
  *this side wins / that side wins / rewrite both to a third thing / leave open.*
- **"Leave open" is a first-class answer** (a deliberate held tension is a decision, not a failure),
  and the loop is **interruptible** — the user taps out mid-loop; the tool banks what's resolved and
  reports the rest as findings.
- **Zero attention = the autonomous mode** — appetite 0 → every charter-delta becomes a written
  finding, nothing interactive, no human in the loop. Attended and unattended are two settings of one
  dial, not a forked path.

## Ties to existing machinery (reuse, don't rebuild)

- **`intent_checkpoint` carries the CEILING only** — the consent meta-intent that seeds the charter
  layer. The three goal DAGs, correspondences, differences and fidelity verdicts live on the
  charter OUTPUT artifacts; embedding them back on the checkpoint would create a staleness cycle
  with the checkpoint those artifacts depend on.
- **Charter-clarification reuses the clarification-pause *pattern*, NOT remediate's
  `ClarificationRequest` type or `waiting_for_clarification` status.** Charter-alignment questions are
  symmetric charter-pair arbitrations (VOI-ranked, risk-gated) resolved by an inline symmetric answer
  re-applied on deterministic re-derivation — genuinely different in shape AND resolution semantics
  from remediate's finding-ambiguity questions (which resolve via an imperative keep/reject/defer
  action that mutates item state). So audit uses its own `CharterClarificationRequest` and an
  obligation-gated pause (the `charter_clarification_current` obligation — audit has no dedicated
  `waiting_for_clarification` status; its status enum is `not_started|active|blocked|complete`). This
  is a deliberate **category difference, not drift** — the resolution semantics are two different
  operations, not two policy settings of one core, so a shared type would be a false unification.
- **Contract vs conceptual modes** — the charter-delivery review is *conceptual*, and it *consumes*
  the contract-assessment obligations as part of "what the subsystem really owes."
- **Leads-not-verdicts** — every finding, especially high-blast and True ones, is a lead the owner
  judges; nothing here is a verdict.
- **Language-neutral** — goals and charters are not code; the layer stays repo/ecosystem-agnostic.

## The reviewer's contract — enable the judgment, ground and gate the output

The conceptual review is the **one place in either tool to lean *into* judgment, not toward
determinism**. Architectural insight is irreducibly a judgment call — you cannot make it
deterministic and should not try. So the tooling's job is to **enable** the judgment and to
**ground and gate** its output — **never to constrain** it with checklists or project-specific
lenses. The review is a **repo-agnostic** tool that audits any codebase, so it asks **general**
first-principles questions. The restorations:

- **Ask general first-principles questions (primary).** The prompt asks the general architectural
  questions — *"is the fundamental approach the right one? what core assumption underlies this
  design, and is it sound? what would a clean-sheet redesign do differently? where is the deepest
  structural risk?"* Repo-agnostic by construction; no project-specific lenses baked in.
- **Orient, then roam.** The reviewer gets a small **context package + the project docs + an
  `/init`-style codebase overview**, then roams the actual files freely (read wherever the code
  leads, not a risk-truncated summary feed).
- **Make the judge judge.** The deep-path judge holds an evaluative role — assess
  merit / validity / severity, decide what is real, and flag what is *missing* — not just fold
  duplicates.
- **Ground the output.** Conceptual/contract findings require component-level evidence, enforced at
  ingest by `groundDesignFinding` (`src/shared/validation/designFindingGrounding.ts`), called from
  `nextStepHelpers.ts`.
- **Gate it — cannot auto-complete empty.** There is no auto-complete path. A pass's review flag
  (`contract_reviewed` / `conceptual_reviewed`) is set ONLY when a validated host submission is
  consumed (`src/audit/cli/nextStepHelpers.ts`); a submission that fails validation is quarantined
  and recorded on `design_assessment.rejected_submissions` instead of merged, so it never sets the
  flag. An absent or empty assessment is therefore deliberately NO-SIGNAL — it means "unreviewed /
  nothing detected", never "reviewed and clean", and no consumer may read absence as evidence (the
  documented stance of `collectLensEvidence`,
  `src/audit/orchestrator/intentCheckpointExecutor.ts`). If auto-completion is ever reintroduced, a
  stamp that distinguishes "a real review found nothing" from "auto-completed empty" must be
  designed as part of that same unit — without one the two are indistinguishable on the artifact.

Determinism for the mechanical; empowered, general, well-fed judgment for the architectural.

## What is explicitly rejected

- **/init as the review mechanism** — wrong genre (distill-to-durable-doc vs bounded adversarial
  findings). Only its negative-constraint discipline and cross-file targeting transfer.
- **Reconciling the charters, or the decompositions, into one truth** — the differences are the
  product; a merge that DESTROYS them is rejected.
- **A triangulated or unified telos authored by any reader** — dropped 2026-09-15. It was defended
  as a lead held beside the deltas, but it is the one place a reader is invited to state a merged
  account; the report shows the three accounts side by side instead.
- **A separate "independent vs guided" knob** — it collapses into the ceiling.
- **Assuming Stated is ground truth** — it forfeits the highest-value findings.
