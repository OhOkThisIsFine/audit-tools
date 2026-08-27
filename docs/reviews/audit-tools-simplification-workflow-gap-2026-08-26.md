# Audit-tools simplification workflow gap analysis — 2026-08-26

## Question

Why does this standalone instruction:

> Use codebase-memory to hunt down unnecessary complexity that could be reduced
> with elegant code solutions. In parallel, examine the project's philosophy,
> choices, goals, and subsystem goals, and look for categorically better ways to
> achieve them.

produce stronger and more comprehensive results than `/audit-code`, even though
audit-tools already has conceptual design review, charter/telos extraction, a
goal graph, and a systemic second-order adversary?

## Executive verdict

The missing capability is **not another reviewer or another audit phase**.
Audit-tools already contains most of the right reasoning prompts. The failure is
that its normal execution path disables or starves those prompts:

1. A normal audit defaults to shallow conceptual review. That omits charter
   extraction and the systemic challenge, and uses one general reviewer instead
   of the deep fan-out and independent judge.
2. When the systemic challenge does run, its mandate closely matches the user's
   prompt, but the host task receives aggregate counts rather than the joined
   structural, telos, design-choice, and prior-finding evidence needed to carry
   out that mandate.
3. Rich charter outputs are computed, then reduced to subsystem purpose strings
   before conceptual review. Goal-graph relationships, deltas, triangulation,
   disagreement, and provenance do not reach the reviewer that should question
   the design.
4. Audit-tools' internal graph is a bounded file-edge summary. Codebase-memory
   supplies symbol search, bidirectional call traces, exact source snippets,
   generation/freshness state, pagination, and explicit index-coverage checks.
   The audit host contract neither requests those semantic capabilities nor
   normalizes their evidence.
5. Conceptual findings can be considered grounded when one affected path merely
   exists. That is much weaker than the standalone reports' exact-site counts,
   call-chain verification, live probes, test evidence, coverage limitations,
   and rejected alternatives.
6. The standalone prompt makes two obligations explicit and simultaneous:
   structural simplification and purpose/design-choice review. Audit-tools
   disperses those concerns across optional phases, so no required reviewer
   holds both bodies of evidence and no coverage contract proves both were done.

The shortest path to parity is therefore to **strengthen and connect the
existing machinery**, not add a parallel auditing framework.

## Evidence boundary

The main repository graph was ready with 21,006 nodes and 70,137 edges. Its
recorded full-index generation was `2026-08-26T23:18:45Z`; coverage metadata was
complete and generation-matched. `check_index_coverage` returned no recorded
issue for all 25 material source/test paths used in this report, but marked each
`metadata_changed` and recommended source reads/reindexing. Accordingly, graph
results were used as structural leads and every material claim below was checked
against the current source with targeted reads/searches.

The negative-claim scope check returned no recorded issue under `src/audit` and
one known gap under `src/shared`: the unrelated parse-partial range
`src/shared/analyzers/candidates.ts:450`. That range is not evidence for any
claim in this report.

`index_status` reported seven parse-partial files and no skipped files. None of
the parse-partial paths is material to this report. Deliberately ignored runtime,
build, tool-installation, and local-state directories were not treated as code
coverage. The named Markdown specifications and benchmark reports were read as
source artifacts rather than inferred from the graph.

This is Auditor-tier accounting with a disclosed limitation, not a claim that a
clean coverage signal proves completeness.

## What the successful standalone run does differently

| Dimension | Standalone prompt + codebase-memory | Current `/audit-code` | Consequence |
|---|---|---|---|
| Objective | Explicitly requires elegant structural reduction and an independent philosophy/goal review | Simplification is implicit among broad conceptual lenses; systemic review is optional | The standalone run has a completeness obligation for the desired finding class |
| Default depth | The agent investigates until the request is satisfied | Omitted depth resolves to shallow | The strongest audit machinery is normally bypassed |
| Structural resolution | Symbol-level search, callers/callees, snippets, dead-code/fan-in/fan-out queries, coverage checks | File edges, route/reference heuristics, aggregate metrics, truncated packet previews | Cross-file primitives, duplicated state machines, and hidden call-chain duplication are easier to prove standalone |
| Telos | Project docs, philosophy, subsystem goals, and code are held in one investigation context | Telos is extracted into artifacts, then largely compressed before review | Governing choices and lifecycle costs fail to connect back to concrete machinery |
| Tool use | Reviewer can roam the repository and iteratively query the symbol graph as hypotheses emerge | Reviewers can roam and read source, but the workflow neither guarantees nor records symbol queries, pagination, graph generation, or coverage checks | Thoroughness depends on host initiative rather than an auditable evidence contract |
| Evidence | Exact traces/sites, graph generation, coverage limitations, probes/tests, and rejected hotspots | Conceptual grounding accepts an existing affected path | Audit output can be plausible without being comparably verified |
| Completion | The paired request remains salient through synthesis | One empty systemic round converges; shallow omits the loop entirely | A dry pass can mean missing context rather than exhausted opportunities |

The empirical difference is visible in the two benchmark reports:

- [`complexity-reduction-audit-2026-08-26.md`](complexity-reduction-audit-2026-08-26.md)
  verified seven concrete reductions, including one shared SCC/cycle primitive
  and one audit-obligation registry/drain.
- [`philosophy-simplification-audit-2026-08-26.md`](philosophy-simplification-audit-2026-08-26.md)
  produced ten governing-choice recommendations and seven additional code
  reductions, including one protocol with two bounded contexts, risk-scaled
  ceremony, one `advanceUntilBlocked` engine, and a lifecycle-cost test for hard
  gates.

These are not merely more findings. They connect repository purpose to exact
machinery and distinguish attractive-looking hotspots from reductions that
survive source and runtime checks.

## Current workflow and where evidence is lost

The enforced obligation sequence in
[`nextStep.ts`](../../src/audit/orchestrator/nextStep.ts) is intent confirmation,
intent equivalence, charter extraction and delta mining, contract plus
conceptual review, charter clarification, systemic challenge, planning/semantic
review, ingestion, runtime validation, deterministic findings, and narrative.
The diagram below zooms into the design/simplification branch where the observed
gap arises.

```text
confirm intent (default: shallow)
|
+-- shallow -------------------------------------------------------------+
|   no charter extraction                                                |
|   one general conceptual reviewer                                      |
|   no systemic second-order challenge                                   |
|                                                                         |
+-- deep/deepest --------------------------------------------------------+
    three charter estimator lanes -> delta/goal-graph mining
    five independent conceptual perspectives -> independent judge
                    |                          |
                    |                          +-- sees perspective files,
                    |                              but no required graph workflow
                    +-- prompt receives subsystem purpose strings,
                        not the full telos evidence

    systemic second-order adversary
    mandate: redundancy, duplication, over-building, assumptions,
             categorically better approaches
    actual materialized evidence: aggregate counts + prior finding count
```

The branching behavior is explicit in the code and tests:

- [`intentCheckpoint.ts`](../../src/shared/types/intentCheckpoint.ts) defines
  shallow/deep review plus the richer `ceiling` and `attention` controls, while
  [`intent-checkpoint.test.ts`](../../tests/audit/intent-checkpoint.test.ts)
  pins the user-facing default as shallow.
- [`charterExtractionExecutor.ts`](../../src/audit/orchestrator/charterExtractionExecutor.ts)
  resolves an omitted ceiling to shallow and does not request charters there.
- [`systemicChallengeExecutor.ts`](../../src/audit/orchestrator/systemicChallengeExecutor.ts)
  writes an omitted, converged result for shallow and opens the improvement loop
  only for deep/deepest review.
- Deep mode itself is substantial: [`conceptualDispatch.ts`](../../src/audit/cli/conceptualDispatch.ts)
  dispatches independent perspectives and a separate judge, and
  [`designReviewPrompt.ts`](../../src/audit/orchestrator/designReviewPrompt.ts)
  includes dedicated “Mathematician seeking elegance” and “Minimalist” lenses.

The latent capability is therefore real. The normal product path simply does
not reliably invoke it.

## Confirmed gaps

### 1. Deep review is exposed, but ordinary audits default to shallow

The confirmation prompt and its tests present `shallow` as the default. The
runtime follows that default consistently: conceptual dispatch uses one
reviewer, charter extraction is omitted, and systemic challenge is pre-marked
converged. The schema supports `ceiling` and `attention`, including `deepest`,
but normal confirmation exposes only the older conceptual-depth shape. A user
running `/audit-code` without knowing these internal controls cannot reliably
request the system the design specification describes.

This explains a large portion of the observed gap by itself: the standalone
prompt always asks for the expensive whole-system reasoning, while audit-tools
normally selects the cheap path.

### 2. The best-matching reviewer is evidence-starved

[`secondOrderAdversaryPrompt.ts`](../../src/audit/systemic/secondOrderAdversaryPrompt.ts)
contains almost exactly the right mandate. It asks what is redundant,
duplicated, over-built, unnecessarily serial, based on an unquestioned
assumption, or replaceable by a categorically better subsystem approach. It
also says aggregate metrics are “necessary, NOT sufficient.”

The runtime contradicts that warning. In
[`nextStepCommand.ts`](../../src/audit/cli/nextStepCommand.ts),
`emitSystemicChallenge` renders the adversary from only:

- the round number;
- the prior systemic-finding count; and
- `aggregateMetricsDigest`.

The digest itself contains component, unit, surface, flow, dependency-edge,
metric-covered-node, and maximum-fan-out counts. It does not materialize project
philosophy, subsystem charters, goal relationships, design choices, graph
paths, source snippets, earlier non-systemic findings, or a retrieval plan.

This is the most direct answer to why the standalone prompt wins: its reviewer
can inspect the evidence needed to answer the question; audit-tools' designated
reviewer is told the question but handed counts.

### 3. Telos is produced, then flattened before it matters

The charter register has materially richer semantics than the conceptual
prompt consumes. It carries subsystem charters with provenance, a goal graph,
stamped deltas, triangulated teloses, disagreement density, and findings/leads.

`renderCharterContext` in
[`designReviewPrompt.ts`](../../src/audit/orchestrator/designReviewPrompt.ts)
reads only register status, subsystem identity, charter kind, and charter
purpose. Tests in
[`conceptual-charter-context.test.ts`](../../tests/audit/conceptual-charter-context.test.ts)
likewise assert purpose-string presence while their fixtures contain empty
goal-graph, delta, triangulation, and disagreement collections.

That is enough to tell a reviewer what a subsystem claims to do, but not enough
to expose conflicts between stated and revealed goals, cross-subsystem tradeoffs,
or which governing choices impose the machinery under review.

This is also a recurrence, not a new class of problem. The earlier
[`prompt-process-critique-2026-08-05.md`](prompt-process-critique-2026-08-05.md)
already confirmed “scope confirmation starved telos” and “orchestrator fed
subagent-only content.” Materialized fan-out improved lane reliability, but the
semantic evidence still does not reach the consumers that need it.

### 4. The internal graph is an orientation map, not an investigation tool

[`graph.ts`](../../src/shared/types/graph.ts) represents imports, calls,
references, routes, node metrics, and analyzer provenance primarily as path
edges. [`extractors/graph.ts`](../../src/audit/extractors/graph.ts) builds these
from language-neutral regex/heuristic extraction and optional external analyzer
edges. That is useful for partitioning, risk summaries, and reading-list hints.
It is not equivalent to an on-demand symbol graph.

Even that graph is aggressively summarized before host review. In
[`reviewPacketGraphContext.ts`](../../src/audit/orchestrator/reviewPacketGraphContext.ts),
packet context is capped at eight key edges and twelve boundary files. The
conceptual prompt also renders bounded structural summaries rather than a query
affordance.

Codebase-memory changes the investigation qualitatively:

- discover exact functions/classes by pattern;
- trace callers and callees in both directions;
- inspect exact source for qualified symbols;
- query high fan-in/fan-out, dead code, data flow, and cross-service edges;
- paginate instead of silently truncating;
- record project generation/freshness; and
- call `check_index_coverage` before negative or exhaustive claims.

Audit-tools need not depend on codebase-memory by product name, but a
comprehensive audit must require equivalent **semantic capabilities**. A
file-summary fallback cannot silently claim parity.

Conceptual prompts do grant repository roaming and tell strong hosts to read the
project's documentation and source. That is a useful escape hatch, but it is not
a contract: no workload says which symbol questions must be answered, no result
records the queries or coverage, and no validator distinguishes a thorough roam
from a reviewer that reasoned only from the preview.

### 5. The MCP field is metadata, not capability negotiation

`allowed_mcp_tools` exists in the step artifact schema and writer, but source
usage does not implement general structural capability negotiation. It is not
dead: the semantic-review step serializes it into the live step contract. That
is also the only production writer found, and it publishes only
`auditor_continue_audit`. Conceptual and systemic review do not request
`list_projects`, `search_graph`, `trace_path`, `get_code_snippet`, or
`check_index_coverage`, and no provider-neutral structural-evidence request is
handed to the host.

Merely adding codebase-memory tool names to one prompt would be brittle. The
contract needs to say what evidence is required; the host adapter should map
that requirement to codebase-memory or another equivalent graph provider. A
deterministic/file-summary fallback must be labeled degraded and cannot support
a comprehensive acceptance claim.

### 6. Conceptual grounding proves addressability, not correctness

[`designFindingGrounding.ts`](../../src/shared/validation/designFindingGrounding.ts)
explicitly treats a design finding as grounded when at least one cited
`affected_files` path resolves to a real repository path. It does not verify a
quoted source fact, enumerate claimed duplicate sites, confirm a call chain,
check a stated fan-out, or establish that an alternative actually removes the
named machinery.

Path grounding is a useful quarantine floor, but it is not a sufficient
acceptance bar for simplification findings. The successful standalone reports
show the missing contract: graph generation and coverage, exact affected sites,
trace/source verification, probes or tests where material, and explicit
rejection of tempting false hotspots.

### 7. Completion is “one dry round,” not demonstrated coverage

For deep review, one submitted systemic round that adds no new deduplicated
finding marks the loop converged. For shallow review, the loop is omitted and
pre-converged. Neither condition demonstrates that both requested objectives,
all subsystems, all governing choices, or the important structural lead classes
were examined.

The right correction is not an unbounded “keep asking for more findings” loop.
It is an auditable coverage ledger plus finite, risk-scaled dry semantics. A
review may stop when every required area has a disposition and an independent
synthesis pass produces nothing material—not merely when an evidence-starved
agent returns an empty array once.

### 8. The user's paired objective is not durable through planning and synthesis

Free-form intent is interpreted into lens, priority, scope, and constraint
signals by [`intentInterpreter.ts`](../../src/audit/orchestrator/intentInterpreter.ts)
and consumed by
[`planningExecutors.ts`](../../src/audit/orchestrator/planningExecutors.ts).
That lets the planner honor many ordinary preferences, but it does not create
stable objective identities for “structural elegance” and “philosophy/telos
challenge,” nor does every resolved but unencodable clause remain attached to
downstream work.

Final merging in
[`mergeFindings.ts`](../../src/audit/reporting/mergeFindings.ts) then
concatenates conceptual, charter, systemic, and semantic findings and
deduplicates them chiefly by finding identity/lens. It does not prove that each
user objective produced an independently evidenced result or explicit dry
disposition. The narrative layer cannot repair the loss: it is instructed not
to re-audit or invent findings, and
[`synthesisNarrativePrompt.ts`](../../src/audit/reporting/synthesisNarrativePrompt.ts)
renders only the first 120 findings before pointing at the complete JSON.

The standalone instruction avoids this failure because its two obligations stay
verbatim and salient in one investigator's task. Audit-tools needs stable
`review_objectives`, not only inferred lenses.

## Recommended design

### Design rule: repair the existing workflow before adding contracts

The first implementation should add no audit phase, objective schema, evidence
bundle, governing-choice type, or coverage protocol. It should make the
existing deep fan-out, charter artifacts, independent judge, and systemic
adversary receive the context they already need.

In P0, the following are prompt and quality requirements, not a new typed
capability protocol:

- symbol discovery;
- inbound and outbound tracing;
- exact source retrieval;
- structural query pagination;
- project generation/freshness; and
- coverage accounting for negative or exhaustive claims.

Codebase-memory is the preferred provider because it already supplies those
operations. Invocation belongs to the Codex, Claude Code, OpenCode, or other
host integration. Core audit-tools owns provider-neutral workloads and
accepted results; it must not become an MCP client, import a codebase-memory
namespace, or own provider discovery.

The installed host directive is also the P0 capability boundary. Before it
starts a comprehensive audit, it checks whether codebase-memory or an
equivalent structural provider is available. If not, it does not launch or
label the run comprehensive: it returns an explicit degraded/non-comprehensive
preflight limitation and may offer the existing quick/shallow path.

If the user proceeds with that degraded path, the host integration writes a
high-severity `AgentReflection.tool_friction` entry with the reserved
`task_id: "audit-capability-preflight"` to `agent-feedback.jsonl`. The
existing
[`AgentReflection`](../../src/shared/agentReflections.ts) parser and renderer,
artifact loader in
[`artifacts.ts`](../../src/audit/io/artifacts.ts), and both synthesis paths in
[`synthesisExecutors.ts`](../../src/audit/orchestrator/synthesisExecutors.ts)
already carry that entry to the Markdown report's Process Feedback section.
P0 should promote only reflections with that reserved task ID and
`high`/`critical` severity to a dedicated `## Audit Limitations` block, so
the human report cannot bury the disclosure or misclassify unrelated tool
friction.
This uses an existing artifact channel and requires no persisted-schema change.
If the limitation must also be machine-readable in canonical
`audit-findings.json`, no suitable field exists today; that requirement
triggers conditional P1.


## Implementation sequence

### P0 — Rewire the existing deep workflow

1. Resolve bare whole-repository `/audit-code`, explicit comprehensive/full
   intent, and philosophy/goal challenges to existing deep mode and its deep
   charter ceiling. Keep shallow for explicit quick, named-file, tightly
   scoped, or low-cost intent; label shallow output non-comprehensive.
2. Expose the existing `ceiling` and `attention` controls in normal
   confirmation, including `deepest`; add no new depth dial.
3. Reserve two slots in the existing fan-out. Use `Mathematician seeking
   elegance` for structural simplification and `Minimalist` for purpose/telos
   challenge. Keep the remaining perspectives and independent judge; add no
   new lane kinds or objective schema in P0.
4. Render compact views or artifact references for the existing charter goal
   graph, deltas, triangulated telos, disagreement, and provenance to both
   required perspectives and the judge.
5. Give the existing systemic adversary the docs digest, full charter
   register, both required perspective outputs, judge output, and actual prior
   findings. Its host task must explicitly allow repository reads and available
   structural tools, and require material graph claims to be checked against
   source with limitations reported.
6. Require the judge and systemic reviewer to retain, merge, or explicitly
   reject each concrete simplification/telos candidate. Rejected attractive
   hotspots are useful evidence, not discarded scratch work.
7. Add the host capability preflight and reuse
   `AgentReflection.tool_friction` for any degraded path. Promote matching
   `task_id: "audit-capability-preflight"` feedback with `high`/`critical`
   severity to a dedicated Markdown `Audit Limitations` block; do not claim
   machine-readable limitation support in P0.

## P0 benchmark gate

Run the quality benchmark immediately after P0. P0 either meets the user's bar
without new schemas, or its measured failure determines the smallest
subsequent contract.

### Pinned paired protocol

Create a manifest that pins the repository commit and clean fixture state;
audit-tools commit/package version; codebase-memory version, project
generation, and index status; host build, model, reasoning effort, and tool
inventory; exact control and candidate prompts; context/output budgets,
maximum turns, timeout, depth/ceiling/attention, and all relevant
configuration.

Run exactly five paired trials on the primary pinned repository and exactly
five more on the held-out repository or snapshot:

- **Control:** the user's standalone prompt verbatim with codebase-memory.
- **Candidate:** ordinary comprehensive `/audit-code` with P0 behavior.
- Give both the same pinned repository, host, model, reasoning effort, tool
  access, and budgets.
- Randomize pair order and mask A/B identity from an independent evaluator.
  Neither auditor sees the benchmark reports, candidate list, or scoring
  rubric.

Use the two 2026-08-26 reports as the acceptance corpus, normalizing overlaps
so one underlying opportunity is scored once. Add one held-out repository or
snapshot chosen before tuning, seeded positive cases for duplicated machinery,
duplicated advancement/state ownership, goal conflict, and disproportionate
lifecycle ceremony, plus negative controls for intentional bounded-context
duplication and a safety gate whose removal would increase risk.

### Scoring manifest and adjudication

Freeze a scoring manifest before any run. Give every normalized opportunity,
anchor, seeded case, and negative control a stable ID; record its class,
material evidence sites, causal mechanism, intended reduction, and the exact
conditions under which a broader finding may subsume it.

Two independent evaluators score de-identified outputs. For each positive ID
they record `recovered` (1), `validly_subsumed` (1), `partial` (0.5),
`evidence_refuted` (1), or `missed` (0). Valid subsumption requires the
broader finding to cover the same causal mechanism, material evidence, and
reduction outcome—not merely an adjacent symptom. An evidence-backed
refutation requires exact contradictory source/runtime evidence and counts as
a successful disposition rather than a recall miss.

Per-axis formulas are fixed in the manifest:

- structural and philosophy/telos recall are the mean disposition scores for
  their positive IDs;
- grounding precision is the mean of 1 for an admitted finding with exact
  support, 0.5 for explicitly limited support, and 0 for unsupported material
  claims;
- telos-to-code linkage is the mean of 1 only when a finding identifies the
  goal/choice, concrete machinery, and causal link, otherwise 0;
- reduction value uses a predeclared 0/0.5/1 rubric for whether the proposal
  removes the anchor's states, protocols, inventories, gates, or duplicate
  implementation; and
- false-positive discipline is the mean of 1 for correctly retaining or
  explicitly rejecting a negative-control hotspot, 0.5 for bounded
  uncertainty, and 0 for recommending the unsafe/invalid reduction.

Any evaluator disagreement is resolved by a third blinded adjudicator against
the pinned source evidence; the adjudication and rationale are recorded.
Within a pair, equal axis scores are a tie, a higher candidate score is a win,
and a lower score is a loss.

### Separate non-inferiority axes

Score each pair separately for:

1. structural recall;
2. philosophy/telos recall;
3. grounding precision, including exact sites, claimed traces, source checks,
   and relevant probes/tests;
4. telos-to-code linkage;
5. reduction value measured as states, protocols, inventories, gates, or
   duplicate implementations removed; and
6. false-positive discipline, including explicit rejected-hotspot handling.

P0 passes only if it is non-inferior on every axis, not merely on total finding
count. A practical first threshold is a tie or win in at least four of five
pairs with no lower median per axis, recovery or valid subsumption of the
strongest known benchmark opportunities in at least four candidate runs, and
no admitted high-confidence unsupported finding. The holdout must meet the
same per-axis rule; seeded positives must be found at least as often as the
control, and negative-control false positives must be no worse.

Run one graph-disabled trial separately. Its correct outcome is the host
directive's explicit degraded/non-comprehensive preflight notice without
starting a comprehensive run. That host is ineligible for comprehensive
quality acceptance until it supplies equivalent structural capability. If the
degraded quick path is accepted, its Markdown report must also contain the
promoted `Audit Limitations` disclosure.

### Conditional P1 — Add evidence semantics only for a failed benchmark axis

If P0 fails because hosts cannot request or preserve structural evidence:

1. minimally extend the existing provider-neutral workload/result records with
   the missing semantic request and normalized evidence references;
2. implement the codebase-memory mapping in each host integration, beginning
   with the installed host directive—never in audit-tools core;
3. keep the existing file graph as orientation and a degraded fallback until an
   equivalent symbol provider exists;
4. leave the live `allowed_mcp_tools` field as the execution allowlist it is;
   it neither requests structural work nor proves that evidence was obtained;
5. record generation, pagination, coverage, source fallback, and limitations in
   the extended run artifacts and final report; and
6. only if graph-disabled limitations must be machine-readable, add one
   top-level limitations field to the canonical findings report rather than
   hiding it in narrative text.

### Conditional P2 — Extend existing artifacts for the axis that failed

Do not add all of these pre-emptively:

1. If philosophy/telos linkage fails because choices do not survive
   extraction, add `governing_choices` to the existing charter register and
   delta output.
2. If grounding precision fails, add the smallest typed evidence references
   and verification rules to existing conceptual findings.
3. If recall or convergence cannot be evaluated, extend existing coverage
   machinery with dispositions for the two required obligations. Do not begin
   with a new subsystem-by-choice-by-lead-class matrix.
4. Every extension must cite its failed benchmark axis and carry a focused
   contract test, then the full paired and holdout benchmark must run again.

## Contract-test plan

P0's normal deterministic tests should prove only the workflow properties that
tooling can guarantee:

- ordinary whole-repository/comprehensive intent resolves to deep, while
  explicit quick or tightly scoped intent may remain shallow;
- normal confirmation round-trips `ceiling` and `attention`, and shallow
  output is visibly non-comprehensive;
- the deep fan-out includes the structural-simplification and purpose/telos
  perspective roles plus the independent judge;
- charter context exposes the existing goal graph, deltas, triangulated telos,
  disagreement, and provenance by compact view or artifact reference;
- systemic challenge receives actual prior findings and the two perspective
  outputs, plus explicit repository/source and available-tool instructions;
- a host without equivalent symbol search, bidirectional tracing, exact source
  retrieval, and coverage accounting is stopped by the host directive before a
  comprehensive run starts, with an explicit degraded/non-comprehensive
  preflight notice; if the user selects the degraded path, the host writes the
  existing `tool_friction` reflection using reserved
  `task_id: "audit-capability-preflight"`, and the Markdown renderer promotes
  only that high/critical record to `Audit Limitations`; and
- the judge/systemic result accounts for each concrete candidate as retained,
  merged, or rejected.

Relevant existing seams include
[`intent-checkpoint.test.ts`](../../tests/audit/intent-checkpoint.test.ts),
[`charter-extraction-executor.test.ts`](../../tests/audit/charter-extraction-executor.test.ts),
[`conceptual-charter-context.test.ts`](../../tests/audit/conceptual-charter-context.test.ts),
[`review-packets.test.ts`](../../tests/audit/review-packets.test.ts),
[`systemic-challenge.test.ts`](../../tests/audit/systemic-challenge.test.ts),
and
[`grounding-surfacing.test.ts`](../../tests/audit/grounding-surfacing.test.ts).

A conditional schema extension adds only the contract test for the failed axis
it addresses. It does not make generative quality a deterministic unit-test
claim.

## Benchmark decision

The pinned, blinded P0 gate above is the quality acceptance test:

- if P0 is non-inferior on every separate axis and passes the holdout/negative
  controls, ship P0 and add no persistent schema;
- if an axis fails, add the smallest extension mapped to that axis and rerun the
  full paired benchmark;
- a graph-disabled host is stopped by the host-directive preflight and cannot
  pass comprehensive acceptance until it supplies equivalent structural
  capability; and
- raw finding count, prompt depth, or one dry systemic round never substitutes
  for measured recall, precision, telos-to-code linkage, reduction value, and
  false-positive discipline.


## What not to build

- Do not add a third independent “elegance audit” pipeline beside conceptual and
  systemic review. That would reproduce the fragmentation causing the problem.
- Do not hard-code the `mcp__codebase_memory_*` namespace into durable artifact
  schemas. If the benchmark triggers conditional P1, name semantic capabilities
  in provider-neutral fields and keep provider names in host adapters.
- Do not dump the full graph or every charter artifact into every prompt. Supply
  compact orientation plus on-demand retrieval and existing artifact references;
  add typed evidence references only if the grounding benchmark requires them.
- Do not equate deeper review with more findings. Require better coverage and
  stronger dispositions.
- Do not upgrade path existence into a more elaborate-looking confidence score
  without verifying the underlying claim.

## Bottom line

The user's prompt succeeds because it creates one coherent, explicit search for
structural and philosophical simplification and gives that search a real
investigation tool. Audit-tools currently has the right reviewers but places
them behind a shallow default, separates their context, and gives the most
relevant reviewer counts instead of evidence.

The recommended redesign makes the existing deep conceptual review, charter
layer, independent judge, and systemic adversary operate as one evidence-backed
simplification workflow. Codebase-memory supplies the first high-quality,
host-side structural provider; a comprehensive run requires equivalent evidence
quality rather than loyalty to that implementation. Implement P0 and run the
blinded benchmark first. Add a durable capability or evidence contract only if
a measured failure proves the existing workload/result artifacts insufficient.
