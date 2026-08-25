# Audit workflow design decisions

The target design of the audit pipeline — a declarative contract describing the
system as it is meant to work. It is **not** a status log: completion is verified
separately against the code (audits, invariant tests, the periodic drift check),
and this document is never edited to record what has or hasn't shipped.

---

## Pipeline order

```
intake
  → batch_deterministic     [auto_fix → syntax_resolved → external_analyzers
                             → structure_artifacts]
  → critical_flow_fallback  [host_delegation, conditional — only when deterministic flow
                             inference falls below the confidence bar]
  → batch_deterministic     [graph_enrichment → design_assessment
                             → structure_decomposition → docs_digest]
  → intent_checkpoint       [user gate]
  → intent_equivalence      [host_delegation for a prose-only delta; every other arm
                             (baseline stamp, gate-version stale, structured delta)
                             resolves deterministically — DD-9]
  → charter_extraction      [host_delegation, gated by the intent-checkpoint ceiling;
                             three blind estimator lanes fed channel-pure packets]
  → charter_delta           [host_delegation, independent delta-miner + triangulation over
                             the Phase-C.1 charters; True nominations at deepest]
  → design_review × 2       [parallel host_delegation: contract + conceptual]
  → charter_clarification   [host_delegation loop, gated by ceiling+attention — Phase D]
  → systemic_challenge      [host_delegation loop, gated by ceiling — Phase E]
  → planning
  → host_review_handoff     [complete provider-neutral workload + bound result ingestion]
  → runtime_validation      [deterministic — runs planned runtime-validation commands]
  → synthesis
  → synthesis_narrative     [host_delegation]
```

---

## Batch deterministic block

The deterministic obligations (auto_fix → syntax_resolved → external_analyzers → structure_artifacts
→ graph_enrichment → design_assessment → structure_decomposition → docs_digest) run in a single next-step call. The orchestrator advances
through all pending deterministic obligations before returning. No separate
roundtrip per step. Execution halts at the first host_delegation obligation or
when all obligations are satisfied.

---

## Intent checkpoint (extended)

The main repo-specific user gate. Fires after the deterministic block, before
design review.

**Orchestrator prepares before showing the host:**

*Scope pre-digest:*
- Full/delta mode, files in scope, in-scope directory breakdown
- Excluded files displayed collapsed by directory prefix: if every file under a
  prefix shares the same status and reason, show the directory once with a file
  count. Enumerate individual files only where they are the odd ones out within
  an otherwise-included directory. The aggregation carries no row-count cap —
  prefix-grouping is its sole compaction. This
  aggregation is `buildExcludedSummary` in
  `src/audit/orchestrator/intentCheckpointExecutor.ts`; it groups ALL excluded
  files by top-level path prefix (not specifically vcs-ignored files), with no
  count threshold on the aggregate.

*Disposition override proposals:*
- Scan `file_disposition` for suspicious inclusions the heuristics missed
  (build output, vendored code, generated files that slipped through)
- Propose per-file status corrections with reasons

*Lens proposals:*
- Analyze `design_assessment` findings and codebase character to propose lens
  inclusions and exclusions
- Examples: no network code → suggest dropping `operability`; heavy crypto
  usage → suggest adding a relevant lens; test-only repo → suggest dropping
  `performance`
- Both inclusions and exclusions are proposed
- Mandatory lenses (`security`, `correctness`, `reliability`, `data_integrity`)
  cannot be excluded regardless of proposal or user input
- Proposals account for repository evidence and confirmed review intent only;
  execution capacity is not an audit-planning input

**User/host produces** (structured output inline, skill writes to disk):
- `scope_summary`, `intent_summary` (required)
- `excluded_scope`: path/prefix entries pruned from planning
- `must_not_touch`: glob patterns
- `disposition_overrides`: per-file or per-directory status corrections
- `lens_selection`: accepted or modified lens set
- `free_form_intent`: user's stated goals, concerns, or focus areas

**free_form_intent encoding:**
The orchestrator interprets `free_form_intent` to shape lens weighting, task
priority signals, and scope emphasis at planning time. It is not threaded
verbatim into worker prompts.

---

## Structure decomposition

The deterministic structure layer of the conceptual design review. It builds
several **independently-sourced** views of the repo and treats their agreement,
not any single view, as the boundary signal: where independent sources co-locate
the same files you have a real subsystem; where they diverge you have a hotspot.
The views are never reconciled into one answer — the disagreement is itself the
product. This is the *overlay-and-delta* operator, and the same operator is
reused at the charter layer (below).

Sources fall into two families: **behavior** (what the system does — call/import
coupling, git change-coupling, data/state coupling) and **intent** (what humans
assert the pieces are — directory layout, docs, comments). Each discovered
subsystem carries two orthogonal robustness scores: how many independent sources
co-locate its members, and how stable the boundary is across scales (the same
weighted graph is clustered from coarse to fine, and a boundary that survives
every resolution is trusted). A node strong on both is a confident subsystem; a
node weak on either is *contested*, and its contested status is itself a finding
routed to sharper review.

Where the behavioral and intent views fail to coincide, the mismatch is a
first-class finding: a behavioral cluster with no coherent purpose points at
accidental complexity or a dead subsystem, and a stated purpose with no
behavioral cluster points at a goal smeared across the codebase and never
modularized — often the highest-value refactor. The phase is fully deterministic
and language-neutral (it operates on abstract node partitions, so any source of
coupling feeds it identically) and persists to `structure_decomposition.json`. It
is the scaffold the charter layer reviews against. The deeper rationale — the two
families, the two-score model, and the non-co-localization findings — is the
design of record in
[`conceptual-design-review-design.md`](conceptual-design-review-design.md).

## Charter extraction

The charter layer of the conceptual design review, and the first phase that
spends LLM judgment. Three blind lanes each author one channel-pure **estimator**
of the code's telos — *Stated* (testimony: docs + extracted comments),
*Structural* (intent frozen into organization: file tree, declarations, import
graph — no bodies, docs, or comments), and *Revealed* (behavior: comment-stripped
bodies) — each stated in terms of the telos, never mechanism, and each fed a
tool-materialized evidence packet holding ONLY its channel, so blindness is a
property of the input rather than an instruction. Every lane self-organizes a
leveled teleology whose nodes carry file scopes; the tool joins the lanes to each
other and to the structure decomposition (a hint, not a forced node list) by
file-set overlap. The channels are deliberately not reconciled; the value is in
their channel-pair deltas, each routed to whoever can act on it: doc rot and
says/does drift to the remediator, an architecture betrayed by its implementation
to a clarification prompt, and a wrong-goal provocation to the human.

The division of labour is strict: the LLM contributes only judgment (each lane's
teleology; later the miner's deltas); the tool owns enforcement. It grounds every
file scope against the repo universe — a scope citing files the repo does not
contain refuses the lane — performs the overlap join, assigns stable charter and
delta ids, and derives each delta's kind and routing from its channel pair
against a fixed routing table rather than host discretion. The independent
delta-miner (a later pass — no author marks its own homework) additionally
distills a **triangulated telos** per subsystem — a unified opinion the owner
reacts to, a lead beside the deltas, never a reconciliation — and, at the
`deepest` ceiling only, may nominate a *True* charter. True carries the hardest
gates, because "what you really want is X" is the canonical over-confident
failure: a nomination must name a concrete alternative and a concrete cost or it
is dropped, it is never asserted as a verdict, and it routes only to the human.
A low-confidence charter likewise downgrades any delta that depends on it to a
human-intent flag rather than an opinion. Depth is gated by the intent-checkpoint
ceiling — the consent dial that governs how far up the premise stack the review
is allowed to reach.

Surviving deltas are persisted to `charter_register.json` — with the per-kind
teleologies, the triangulated teloses, and the tool-counted per-channel-pair
disagreement density — and surfaced as finding *leads* under the architecture
lens — provocations for the owner to judge, never verdicts. The estimator
channels, the routing table, the gates, and the ceiling dial are specified in
full in
[`conceptual-design-review-design.md`](conceptual-design-review-design.md).

## Design review (two parallel passes)

Runs after the intent checkpoint so the reviewer works within confirmed scope.

**Both passes receive:**
- Full structural context: file inventory, unit structure, dependency graph,
  surfaces, critical flows, risk register, deterministic structural findings
- Each unit/file annotated `[in scope]` or `[excluded: <reason>]`
- Instruction: generate findings only for in-scope units; use the graph for
  cross-boundary coupling reasoning; do not produce findings about excluded files

**File access — soft grant with graph-constrained expansion:**
- Starting grant: top-N highest-risk in-scope units (heuristic from risk
  register)
- Expansion allowed: reviewer may follow edges that exist in the graph bundle
  to adjacent files
- Out-of-scope files may be read for context only, not as finding targets
- Design reviewers use soft grants; auditor workers retain hard grants

**Pass 1 — Contract review** (adversarial, evidence-bound):
- Infer existing contracts from structure and code: invariants, trust
  boundaries, preconditions, postconditions, data lifecycle obligations,
  critical-flow guarantees
- Attack inferred contracts with concrete counterexamples
- Categories: `inferred_contract_gap`, `trust_boundary_gap`,
  `invariant_counterexample`, `critical_invariant_coverage_gap`

**Pass 2 — Conceptual review** (generative, exploratory):
- Tool and library opportunities
- Architecture pattern improvements
- Design simplification or under-design
- Integration and generalization opportunities
- Missing capabilities
- Categories: `tool_opportunity`, `architecture_pattern`,
  `design_simplification`, `integration`, `missing_capability`

**Conceptual review depth (shallow / deep).** Depth is a repository-intent
checkpoint field (`design_review.conceptual_depth: "shallow" | "deep"`, default
shallow). Shallow runs one conceptual agent. Deep fans out a configurable count
(`design_review.perspectives`) of independent perspective subagents — a built-in
roster of maximally-dissimilar perspectives — plus an **independent** judge/merge
agent (an author never marks its own work); the judge writes the single
conceptual-findings artifact the orchestrator ingests. Each perspective and the
judge is emitted as bounded host work, so execution mechanism never changes the
artifact contract.

The contract pass and the conceptual pass dispatch simultaneously as independent
host_delegation agents (the conceptual pass expanding to its perspective fan-out
under deep). Finding sets merge into synthesis as distinct report sections,
separate from auditor findings.

**Structured output:** every worker — design-review agents, auditor workers, and
the synthesis-narrative agent alike — WRITES its result JSON directly to a result
path (via its own Write tool), then replies with a short confirmation. Inline
emission (the worker returns the payload for the skill to capture and write) is
rejected because it silently drops results; the worker-writes-the-file pattern is
the design of record, matching audit-code's host-handoff boundary
(`src/audit/cli/dispatch/hostHandoff.ts`, which binds prompt digests and result
paths before any result is accepted).

**Prompt caching:** the shared structural context block (graph, surfaces, flows,
risk register, file inventory) is identical for both agents. It goes first in
both prompts, marked for caching. One cache write, two cache reads.

---

## Planning

**Disposition overrides applied:** `disposition_overrides` from the intent
checkpoint patch `file_disposition` before `initializeCoverageFromPlan` runs.
Overridden files never enter coverage. This is a deeper hook than
`excluded_scope` (which filters after coverage is initialized) and ensures
overridden files never become audit tasks.

**Lens selection:** `resolveIntentLensSelection` is called with `lens_selection`
from the intent checkpoint. Mandatory lenses are always included.

**No N-file task cap:** `max_task_files` is a degenerate guard only; the token
budget (`max_task_lines`, byte-based `sizeIndex` sizing) is the real constraint.

**free_form_intent shaping applied:** orchestrator uses the interpreted intent
to adjust lens weighting and task priority signals before tasks are built.

**Planning's persisted output is a provider-neutral task-affinity graph** (not a
packet list). Nodes = tasks (unit × lens), each carrying a deterministic
byte-based **token estimate** and a **risk estimate** (lens sensitivity,
critical-flow membership, analyzer signal, blast radius), both frozen once
derived. Edges = soft, weighted **affinity** (`kind` +
`weight`, descending: shared file → cross-lens-same-file → critical-flow (same
flow) → same unit → call adjacency → same directory, plus an additive same-lens
bonus), deterministically derived (LLM-tunable), never frozen — they are the
evidence used to form coherent host work items.
Kept distinct from `graph_bundle.json` (code structure). The plan encodes no
provider, model, routing, quota, transport, or concurrency decision, so a run
resumes in any host without replanning.

---

## Host review handoff

Planning emits every eligible review item as one complete
`audit-host-workload/v1alpha1` artifact. Work items carry stable ids, lens and
scope, deterministic complexity/risk/token-estimate metadata, the full prompt,
its SHA-256 binding, and a repository-contained result path. Metadata describes
the work; it never selects an executor or asserts a fit against an execution
window.

The host decides whether and how to parallelize work. audit-tools performs no
backend discovery, routing, admission, launch, quota accounting, failover, or
rolling scheduling.

**Bound result ingestion.** A companion result map and tool-owned task bindings
pin run id, work-item id, prompt digest, result path, unit/lens identity, file
scope, and current line counts. Host-written results are untrusted until the
strict schema, bindings, coverage, and finding invariants pass. Accepted results
enter an append-only content-addressed ledger; exact replay is a no-op and
different bytes under an accepted identity are refused.

**Auditor structured output:** workers WRITE `AuditResult[]` directly to their
result path with their own Write tool, then reply with a short confirmation (the
worker-writes-the-file pattern established under *Design review → Structured
output*). Payload stays out of orchestrator context; orchestrator only sees the
path. Workers do not execute a submit command.

**Prompt caching for workers:** schema definition, general instructions, and
repo metadata form a fixed shared prefix identical across all workers in a run.
Per-item content (file list, task IDs, graph context) follows. The shared
prefix is cache-eligible; structure should be maintained with caching in mind
even when the active host does not expose explicit cache controls.

General caching principle: **shared context at the front, agent-specific
payload at the back.** Applies to design review agents, auditor workers, and
synthesis narrative.

---

## Synthesis narrative (always runs)

`synthesis_narrative_current` is a `host_delegation` executor. It always emits
bounded host work when narrative judgment is required; an explicit omitted
result remains a defined terminal when the user declines that optional layer.

Host agent receives the findings and produces themes, executive summary, and
top risks, and WRITES the result to disk itself (the worker-writes-the-file
pattern established under *Design review → Structured output*).

`synthesisNarrativePrompt.ts` builds the prompt; the host_delegation wrapper
and executor registration integrate it into the persisted step workflow.

---

## Cross-tool alignment

The remediation walkthrough produced a companion design
([`remediation-workflow-design.md`](remediation-workflow-design.md)). The
contract shared between the two tools — implement once, in `audit-tools/shared`
— is stated once in [`cross-tool-alignment.md`](cross-tool-alignment.md).

---

## Hardening decisions

Audit-relevant items (the remediation companion carries the full set):

- **Explicit host-work terminal.** A host handoff is either pending bound
  results, partially ingested with named remaining work-item ids, or complete.
  Missing and invalid results remain actionable diagnostics; no backend-capacity
  state can turn into an indefinite workflow pause.
- **Per-clause `free_form_intent` escape hatch.** The interpreter decomposes a
  compound intent into clauses and assesses each clause's encodability
  independently; any clause it cannot encode as priority/lens/scope signals
  (e.g. "freeze the public API of Y") is promoted to a blocking checkpoint
  question and carried as an explicit machine-checkable constraint — even when
  sibling clauses encode cleanly. Detection keys on per-clause encodability, not
  total-encoding-failure.
- **Pinned shared APIs.** Session intent, affinity/coherence artifacts,
  provider-agnostic execution records, and the `free_form_intent` interpreter
  are pinned/versioned seam contracts.
