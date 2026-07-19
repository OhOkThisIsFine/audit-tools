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
**negative-constraint discipline** — ~80% of its prompt is *what not to emit* (no obvious, no
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
- **Convergence (loop-until-dry)** — keep seeding overlapping reviews until N rounds surface no new
  misalignment.

Together these are the stop rule; blast radius (below) then ranks what remains.

### Structure decomposition sources — two families
- **Intent-declared structure** (what humans *assert* the pieces are): docs, README, ADRs, user
  feedback, **comments**, directory/naming. ↔ Stated/Inferred charter.
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

## The four charters — hold all four, mine the deltas

There is no single "charter." There are four, and the value is in their **pairwise deltas**, routed
by *who acts on them*:

| Charter | Source | Delta of interest | Routed to |
|---|---|---|---|
| **Stated** | user-expressed (docs, feedback) | — | (anchor of intent) |
| **Inferred** | LLM's model of intent | Inferred − Stated → unstated assumption / miscommunication | a **clarification** prompt |
| **Revealed** | what the code actually optimizes for | Stated − Revealed → spec drift | the **remediator** |
| **True** | the "shining city" ideal — possibly inexpressible, the user may be unaware of it | Revealed − True, Stated − True → serves the wrong goal; "you asked for a tax app, you want Quicken" | the **human**, as a provocation |

- **A charter states purpose in terms of the telos, not its mechanism** — "quota/dispatch exists so N
  cooperating auditors extract max value from finite provider budgets," *not* "it manages quota." A
  charter that merely restates the code is useless as a yardstick — the delta against the impl
  collapses to zero and the review can never find under-delivery.
- **Do not reconcile the four.** Hold all four; the deltas generate the findings.
- **Revealed is the objective anchor** — "what the code optimizes" is far more extractable than any
  intent charter. Not *right*, but the one you can pin down → measure the intent charters against it.
- **True is a horizon, never asserted.** You triangulate toward it (below); you never conclude you
  found it.
- **Persist all four with provenance** (Stated cites where the user said it; Revealed cites code) — a
  delta is only adjudicable if each side is attributable.
- **Tag each charter with confidence, not just provenance** — a low-confidence charter (sparse or
  ambiguous source) **downgrades any review that depends on it to "flag for human intent input,"
  never opine.** Confident-but-wrong findings from bad charters are the whole approach's central
  failure mode; this is the *general* guard, of which the True-charter gates below are the strictest
  instance.
- **Staleness gains a teleological layer**: Revealed re-extracts on code change, Stated only on user
  input → a *closed* Stated−Revealed gap that **reopens** is itself a signal ("this subsystem is
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
cheap and independent (the cooperating-dispatch machinery is built for exactly this), converged by
**loop-until-dry** (keep seeding until N rounds surface nothing new).

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
- **Questions are symmetric** — any of the four charters may move, **including Stated**. The tempting
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

- **`intent_checkpoint` upgrade** — capture the goal **graph + edges** (the four charters with
  provenance + the ceiling meta-intent), not a flat intent list. This seeds the charter
  layer.
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

## What is explicitly rejected

- **/init as the review mechanism** — wrong genre (distill-to-durable-doc vs bounded adversarial
  findings). Only its negative-constraint discipline and cross-file targeting transfer.
- **Reconciling the four charters, or the decompositions, into one truth** — the deltas are the
  product; a merge destroys them.
- **A separate "independent vs guided" knob** — it collapses into the ceiling.
- **Assuming Stated is ground truth** — it forfeits the highest-value findings.
