# Charter extraction redesign — feedback on the owner's five-step outline (2026-09-15)

<!-- review-routing: backlog-bugs -->

Input: the owner's outline (five steps, quoted per section below). Design of record read for
this feedback: `spec/conceptual-design-review-design.md` §"The estimator charters", §"The
triangulation loop", §"What is explicitly rejected"; `src/shared/decompose/charterExtraction.ts`
(`CharterSubmissionSchema`, `assembleCharters`, `assembleDeltas`, `DELTA_ROUTES`);
`src/shared/validation/charterGate.ts`; the approved prompt 8 spec in
`docs/reviews/prompt-refinement-2026-09-13.md`; memories
[[charter-layer-independence-and-node-selection]] and [[conceptual-design-review-design]].

Two modes, kept apart: **conceptual critique** (is the step the right idea) and **contract
assessment** (what it changes in the persisted artifacts and their consumers).

## Where the outline and the current design already agree

- Three channel-pure lanes fed disjoint evidence packets (blindness by input) — built.
- Never reconcile; the differences are the product — the spec's central rule.
- Provenance on every claim; confidence on every charter — built (`CharterProvenanceSchema`,
  `charterReviewDisposition`).
- A separate reader compares — built as the delta miner (`charter_delta` obligation).

So the outline is not a new direction. It sharpens four places where the current build is
lossy or conflated. Each step below states which.

## Step 1 — three independent DAGs

> Each reviewer uses only their assigned evidence to describe the project's goals and supporting
> subgoals. Use common node and edge definitions, and attach evidence references to goals and
> relationships.

**Conceptual.** Agreed, and it corrects a real gap. Today each lane emits a *leveled* node list
(`premise_height` only). No lane emits edges. The only edge-bearing structure is `goal_graph`,
authored by the delta miner across all subsystems after the join — the fourth reader authors the
structure the three blind readers were supposed to reveal. Moving edge authorship into each lane
makes the DAG itself channel-pure evidence, and lets the comparison pass compare *hierarchy*, which
today it cannot.

**Contract.** `GoalGraphSchema` (`nodes{node_id, premise_height, statement}`, `edges{from, to}`,
`from` SERVES `to`) already exists. Reuse it per lane instead of inventing a second graph type:
each lane submission becomes `{ kind, graph: GoalGraph, nodes[].files, nodes[].provenance,
nodes[].confidence, edges[].provenance }`. The lane must mint local `node_id`s (today the tool
assigns ids after the join). That is fine: ids are local to one DAG and never a join key.
`premise_height` becomes derivable from the edges (longest path from a root); keep it as a
lane-stated field only if you want to detect a lane whose stated level contradicts its own edges.
Edge provenance is new; the `CharterProvenanceSchema` shape serves.

**One caution.** The Stated lane reads docs and comments. Docs describe goals, rarely files. Today
every node MUST carry `files` because the file set is the join key. If step 2 stops using file
overlap as the correspondence key (below), the Stated lane can carry provenance-only nodes, which
is what its evidence supports. Do not force a docs reader to guess file scopes.

## Step 2 — identify correspondences

> A separate comparison pass matches regions concerning the same subsystem or expressing the same
> goal. Allow one node to correspond to multiple nodes or a subgraph. Preserve all three original
> DAGs.

**Conceptual.** This is the most important change in the outline. Today `assembleCharters` maps
each node to ONE structure-decomposition unit by largest file overlap, then picks ONE
"best-overlap" node per kind as the unit's charter. Everything else survives only as the unit's
`teleologies` slice. Two losses follow: a goal that spans units is split, and a unit's charter is a
single node when the lane described it as a small subgraph. Many-to-many correspondence, with the
three DAGs preserved, removes both.

**The open design question is the correspondence key.** Three candidates:

| Key | Deterministic | Weakness |
|---|---|---|
| File-scope overlap (today) | yes | Stated nodes have weak file scopes; splits cross-unit goals |
| Semantic match by a host pass | no | An LLM deciding "same goal" is the exact place agreement can be manufactured |
| Hybrid: tool proposes candidates, host confirms and refines | bounded | Two mechanisms to keep honest |

Recommendation: **hybrid**, per the "right tool" rule. The tool computes candidate pairs from two
deterministic signals it already has — file-scope overlap, and provenance cross-references (the
comment lexer in `src/audit/extractors/commentDecomposition.ts` already extracts symbol
cross-refs from docs and comments, so a Stated node that cites `src/x.ts#Foo` corresponds to a
Revealed node whose files include `src/x.ts`). The host pass then confirms, rejects, or widens
each candidate to a subgraph, and may add a correspondence the tool missed — but every
host-added correspondence must cite the two provenance refs it rests on, and the tool checks that
those refs exist. A correspondence with no checkable evidence is dropped, not admitted.

**Contract.** New artifact: a correspondence set, `{ id, members: [{kind, node_ids[]}],
basis: tool|host, evidence[] }`. `members` allows one node on one side and several (a subgraph)
on another. The three lane DAGs persist unchanged beside it. The structure decomposition stays as
the *grouping* key for the report (step 5), not as the correspondence key — today one file-overlap
mechanism serves both roles, which is the conflation the outline undoes.

## Step 3 — record differences

> Compare purpose, goal presence, subsystem responsibility, hierarchy, conditions, and level of
> detail. Distinguish equivalent wording, complementary explanations, and incompatible claims.

**Conceptual.** Agreed, and it replaces a table that is too coarse. Today a delta is a channel
`pair` plus a free-text `summary`; `DELTA_ROUTES` derives the delta's kind and recipient from the
pair alone (`stated|revealed` → says/does drift → remediator). The pair says *which channels*
differ, not *what kind of difference* it is. Your six difference types and three relation classes
are the missing axis.

Two rules to state now, because they decide what becomes a finding:

- **Complementary is never a finding.** A doc that does not mention a subgoal the code reveals is
  not a discrepancy; absence is not disagreement (the same rule the docs philosophy applies to
  staleness). Only `incompatible` yields a finding. `goal presence` differences therefore need a
  qualifier: absent-where-the-source-should-cover-it versus absent-because-out-of-channel.
- **Routing keys on the difference, not the pair.** Doc rot is a `purpose` or `detail` difference
  between Stated and anything; an architecture betrayal is a `responsibility` or `hierarchy`
  difference between Structural and Revealed. Re-key `DELTA_ROUTES` on
  `(pair, difference_type, relation)`. Keep it a fixed tool-owned table; the host never picks a
  route.

**Contract.** `CharterDeltaInputSchema` gains `correspondence_id`, `difference_type` (closed
enum of your six), `relation` (`equivalent | complementary | incompatible`), and per-side
`account` text with provenance. `equivalent` records are worth keeping as corroboration (they
raise the confidence of the matched goal) but generate nothing downstream.

## Step 4 — verify source fidelity

> Check each differing claim against its own source. Record whether the discrepancy reflects a
> supported difference between sources or uncertainty introduced by a reviewer's interpretation.
> Treat source differences as findings.

**Conceptual.** This is the step the current design lacks entirely, and it addresses the spec's
own named central failure mode ("confident-but-wrong findings from bad charters"). Today the only
guard is the lane's self-reported `confidence`, which `charterReviewDisposition` turns into
"flag for human" — a lane grading its own homework.

Recommendation: make this a **separate adversary lane** that is allowed to refuse, fed only the
differing claim and the tool-materialized provenance slices it cites (the same packet mechanism as
`charterPackets.ts`). Two halves, per the deterministic-first rule:

1. **Mechanical pre-check.** Every `provenance.ref` and `quote` is re-read from disk before the
   lane runs — the finding grounding pass (`verifyFindingGrounding`) already does this for
   findings. A claim whose quote is absent at its ref is `unverifiable` and never reaches the lane.
2. **Judgment.** The lane returns one of `supported` (the two sources genuinely say different
   things), `interpretation` (a reviewer read more into a source than it says; name which side),
   `unverifiable`. Only `supported` differences become findings. `interpretation` verdicts are a
   lane-quality signal: record them, and consider re-running that lane node when the rate is high.

**Contract.** A fidelity verdict per difference record: `{ difference_id, verdict, which_side?,
rationale, checked_refs[] }`. The verdict is tool-stamped onto the difference record; the report
(step 5) reads only `supported` ones.

## Step 5 — produce a discrepancy report

> For each finding, include the corresponding nodes, each source's account, the difference,
> supporting evidence, and a concrete investigation question. Group findings by subsystem and
> difference type; preserve disagreements without merging the DAGs or choosing a majority account.

**Conceptual.** Agreed, and it is a deterministic render, not a host pass: every field it needs
exists after step 4. "Preserve disagreements, no majority account" is the spec's rule already. It
collides with one thing the current miner emits: the **triangulated telos** per subsystem. The
spec defends it as a lead held beside the deltas, but it is also the one place a reader is invited
to state a unified account, and the clarification prompt already shows it above each question.
Recommendation: drop it from the comparison pass. If a single-sentence orientation is wanted, let
the report render the three accounts side by side; that is the honest form of the same thing.

The **investigation question** is the input the triangulation loop already consumes
(`charter_clarification`, VOI-ranked). Two things it needs from the new artifacts:

- **Blast radius** is computed today from the miner's single `goal_graph`. With three DAGs,
  compute it per DAG over the corresponding nodes and take the maximum; a goal high in any one
  source's hierarchy is high-blast.
- **True nominations** stay where they are: downstream of the report, at the `deepest` ceiling,
  nominated by a reader who has seen the report, gated by `applyTrueCharterGate`.

**Contract.** The report is a render (`.md`) of a machine record; the machine record IS the
difference set after fidelity stamping, grouped by structure-decomposition unit (file overlap of
the corresponding nodes' scopes) and by `difference_type`.

## The resulting pipeline (bounded steps, in PRIORITY order)

| Obligation | Who | Replaces |
|---|---|---|
| `charter_extraction_current` — three lane DAGs | host, three blind lanes | same obligation, submission gains edges |
| `charter_correspondence_current` — candidates then confirmation | tool proposes, host confirms | the file-overlap join inside `assembleCharters` |
| `charter_difference_current` — typed differences | host comparison pass (may share the correspondence pass) | `charter_delta_current` |
| `charter_fidelity_current` — verdict per difference | tool pre-check, adversary lane | nothing (new) |
| `charter_register` render — discrepancy report | tool | `charter_register.json`'s subsystem-centric shape |
| `charter_clarification_current` — VOI loop | host, unchanged | unchanged |

Consumers that read `charter_register.json` today and must be re-pointed: `charterClarification`
(reads `triangulated`, `disagreement`), `systemicChallenge` (charter projection), the
blast-radius computation, and `renderCharterContext` in the design-review prompt (reads one
charter per kind per subsystem — it would read the three accounts instead). The dependency map
rows for `charter_register.json` and `charter_clarification.json` gain the new artifacts.

## Owner decisions (2026-09-15)

1. **Correspondence key: hybrid.** Tool-proposed candidates (file overlap + provenance
   cross-refs), host confirmation/widening, every host-added pair cites two refs the tool re-checks.
2. **Triangulated telos: dropped.** The report shows the three accounts side by side; no unified
   sentence is authored anywhere.
3. **Difference types: a closed seven-dimension `difference_type` enum**, revised from the
   owner's six after a double-check (own pass + an independent relay lane, which converged):
   Purpose, Presence, Responsibility, Hierarchy, Scope, Standing, Standard. Detail was dropped
   (always the complementary relation; a missing mechanism is a Presence gap one level down),
   Conditions and scope became Scope, and Standing (lifecycle status) and Standard (success
   threshold) were added, each with a decision rule. The table and rules are in the spec.
   `relation` (`equivalent | complementary | incompatible`) stays orthogonal; findings come from
   `incompatible` on any dimension plus the covered-channel Presence gap.

4. **Fidelity check: a separate adversary lane**, not combined with the delta miner. In the new
   pipeline the miner IS the comparison pass; the fidelity reader must be a different reader,
   because it judges whether the comparison reader over-interpreted a source. What is shared is
   the INPUT: the fidelity lane receives the packet slices the miner cited, materialized by the
   tool through the existing packet mechanism.

5. **Stated lane may emit provenance-only nodes.** `files` becomes optional on every lane's
   nodes; the tool derives candidate files for a scope-less node from its provenance
   cross-references where it can, and a node with neither has no tool-proposed correspondence and
   depends on the host confirmation step.

6. **Differences and answers are n-ary (owner, 2026-09-15).** A difference record holds every
   channel's account in its correspondence (two or three); the relation is judged across all;
   an incompatible record states its split (`two_against_one` naming the odd channel, or
   `three_way`); routing keys on `(dimension, relation, split)`; a three-way disagreement is
   always a clarification. The clarification answer names the governing channel, or
   `rewrite_all`, or `leave_open`, replacing the binary pair enum.

## What follows from the decisions

- DONE 2026-09-15: the spec's §"The estimator charters" is rewritten as the five-step pipeline
  (subsections 1–5), with consistency edits to §"Ties to existing machinery" and §"What is
  explicitly rejected". The spec is the home for the decided design; this file is the record of
  how it was reached.
- The memory `charter-layer-independence-and-node-selection` and the design-of-record memory
  `conceptual-design-review-design` describe the superseded delta-miner shape; update both when
  the implementation lands (a decision recorded and never applied is a known trap here).
- Prompts 8 (`charter_extraction`), 9 (`charter_delta`) and 10 (`charter_clarification`) in the
  prompt-refinement review are re-specified FROM the updated spec: 8 gains edges and optional
  scope, 9 becomes the correspondence + difference pass, a new fidelity prompt appears, 10 reads
  side-by-side accounts instead of a triangulated telos.
- Implementation crosses loop-core and shared contracts, so it runs through `/design-check`
  before code.
