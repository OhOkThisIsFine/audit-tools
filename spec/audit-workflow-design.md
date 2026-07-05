# Audit workflow design decisions

The target design of the audit pipeline — a declarative contract describing the
system as it is meant to work. It is **not** a status log: completion is verified
separately against the code (audits, invariant tests, the periodic drift check),
and this document is never edited to record what has or hasn't shipped.

---

## Pipeline order

```
provider_confirmation       [user gate]
  → intake
  → batch_deterministic     [auto_fix → syntax_resolved → external_analyzers
                             → structure_artifacts → graph_enrichment → design_assessment]
  → intent_checkpoint       [user gate]
  → design_review × 2       [parallel host_delegation: contract + conceptual]
  → planning
  → rolling_dispatch        [quota + capability-routed, ingestion folded in]
  → synthesis
  → synthesis_narrative     [host_delegation]
```

---

## Gate 1 — Provider confirmation

Fires before intake. Session-level: applies to the whole run, not specific to
what is found in the repo.

**Orchestrator discovers:**
- CLI tools on PATH (claude-code, codex, gemini CLI, etc.)
- Configured API endpoints and registered local backends
- Capability tier estimate for each discovered provider/model
- Current quota / rate status where queryable

**Shown to the user:**
- Each discovered provider: name, capability tier, quota state
- Which will be included by default

**User can:**
- Exclude any discovered provider
- Add providers not auto-discoverable (API keys for models not on PATH, local
  inference endpoints, IDE models the orchestrator cannot detect directly)

**Output:** confirmed provider pool with capability tiers, used by all
subsequent dispatch and lens-proposal decisions.

**Why before intake:** the provider pool informs lens recommendations at the
intent checkpoint. Lens proposals should be grounded in what is actually
dispatchable (a narrow fast pool suggests fewer lenses; a capable pool justifies
broader coverage).

---

## Batch deterministic block

Steps 2–7 (auto_fix → syntax_resolved → external_analyzers → structure_artifacts
→ graph_enrichment → design_assessment) run in a single next-step call. The orchestrator advances
through all pending deterministic obligations before returning. No separate
roundtrip per step. Execution halts at the first host_delegation obligation or
when all obligations are satisfied.

---

## Gate 2 — Intent checkpoint (extended)

The main repo-specific user gate. Fires after the deterministic block, before
design review.

**Orchestrator prepares before showing the host:**

*Scope pre-digest:*
- Full/delta mode, files in scope, in-scope directory breakdown
- Excluded files displayed collapsed by directory prefix: if every file under a
  prefix shares the same status and reason, show the directory once with a file
  count. Enumerate individual files only where they are the odd ones out within
  an otherwise-included directory. Cap is high (exact value TBD) to handle
  unusual projects. Generalize the aggregation already present in
  `buildFileDisposition` for vcs-ignored files above 200.

*Disposition override proposals:*
- Scan `file_disposition` for suspicious inclusions the heuristics missed
  (build output, vendored code, generated files that slipped through)
- Propose per-file or per-directory status corrections with reasons

*Lens proposals:*
- Analyze `design_assessment` findings and codebase character to propose lens
  inclusions and exclusions
- Examples: no network code → suggest dropping `operability`; heavy crypto
  usage → suggest adding a relevant lens; test-only repo → suggest dropping
  `performance`
- Both inclusions and exclusions are proposed
- Mandatory lenses (`security`, `correctness`, `reliability`, `data_integrity`)
  cannot be excluded regardless of proposal or user input
- Proposals are informed by the confirmed provider pool (capability tier
  influences how many lenses are realistic)

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

**Conceptual review depth (shallow / deep).** Depth is a provider-neutral
checkpoint field (`design_review.conceptual_depth: "shallow" | "deep"`, default
shallow). Shallow runs one conceptual agent. Deep fans out a configurable count
(`design_review.perspectives`) of independent perspective subagents — a built-in
roster of maximally-dissimilar perspectives — plus an **independent** judge/merge
agent (an author never marks its own work); the judge writes the single
conceptual-findings artifact the orchestrator ingests. The perspectives and judge
are themselves packetized JIT by the active provider, so deep review survives a
provider switch.

The contract pass and the conceptual pass dispatch simultaneously as independent
host_delegation agents (the conceptual pass expanding to its perspective fan-out
under deep). Finding sets merge into synthesis as distinct report sections,
separate from auditor findings.

**Structured output:** every worker — design-review agents, auditor workers, and
the synthesis-narrative agent alike — WRITES its result JSON directly to a result
path (via its own Write tool), then replies with a short confirmation. Inline
emission (the worker returns the payload for the skill to capture and write) is
rejected because it silently drops results; the worker-writes-the-file pattern is
the design of record, matching audit-code's packet dispatch
(`src/audit/cli/dispatch/packetPrompt.ts`, which asserts the write-instruction
wording via a regression test).

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

**Lens selection:** `resolveEffectiveLenses` is called with `lens_selection`
from the intent checkpoint. Mandatory lenses are always included.

**No N-file task cap:** `max_task_files` is a degenerate guard only; the token
budget (`max_task_lines`, byte-based `sizeIndex` sizing) is the real constraint.

**free_form_intent shaping applied:** orchestrator uses the interpreted intent
to adjust lens weighting and task priority signals before tasks are built.

**Planning's persisted output is a provider-neutral task-affinity graph** (not a
packet list). Nodes = tasks (unit × lens), each carrying a deterministic
byte-based **token estimate** and a **risk estimate** (lens sensitivity,
critical-flow membership, analyzer signal, blast radius), both frozen after one
always-on LLM estimate review. Edges = soft, weighted **affinity** (`kind` +
`weight`: shared file → same unit → same directory → critical-flow/call adjacency
→ cross-lens-same-file → same lens), deterministically derived (LLM-tunable),
never frozen — they are the flexibility each provider uses to cut its own packets.
Kept distinct from `graph_bundle.json` (code structure). Packets do not exist at
plan time, and the plan encodes no provider/model/concurrency decision — so a run
resumes across providers/IDEs mid-flight with no replanning (this is the
plan/dispatch seam).

---

## Dispatch — rolling, quota + capability-routed

The rolling/admission-control model — one-at-a-time admission against a live
per-pool budget, emergent concurrency, the shared account-keyed reservation
ledger, and folded-in ingestion — is specified in
[`audit/dispatch-admission-control.md`](audit/dispatch-admission-control.md).
This section covers only what is unique to the audit side: how the
task-affinity graph is partitioned into packets, how packets are risk-routed
across model tiers, and prompt caching.

**JIT graph partition (no plan-time packets).** Each time a provider picks up the
run it performs a capability handshake — the models it can dispatch to right now
(an opaque ordered roster with context/output windows + relative rank) and its
real parallel capacity — then partitions the task-affinity graph into packets by
greedy agglomerative merge along descending edge weight, under two
model-parameterized **ceilings (not quotas)**: a **token ceiling** (the chosen
model's discovered context minus overhead) and a **risk-mass ceiling** (aggregate
node risk one agent should scrutinize at once). A coherent high-risk cluster that
exceeds the risk-mass ceiling splits along its weakest internal edge; high-risk
packets are never padded with low-risk filler. With a multi-rank roster: partition
once under the largest window, then re-split any packet whose routed tier has a
smaller window (partition-then-validate, to preserve cross-tier coherence).

**Risk-routed tiering.** A packet's tier = its **max** node risk against relative
cut points, mapped to a relative rank in the roster (low → cheapest available;
high → top available). Complexity signals (isolated large file, critical flow,
analyzer signal, lens verification, high token estimate, sensitive lens) are
**escalators only** — they raise a tier, never lower it. No named models; degrade
gracefully when fewer ranks are reported. An optional opaque `model_id` per roster
entry keys per-model quota learning (`provider/<id>`) and is never a window
authority or matched to a name table. Handshake, partition, and routing are never
persisted as decisions — the dispatch-quota/capacity artifacts record this
session's JIT choices, not authority.

**Auditor structured output:** workers WRITE `AuditResult[]` directly to their
result path with their own Write tool, then reply with a short confirmation (the
worker-writes-the-file pattern established under *Design review → Structured
output*). Payload stays out of orchestrator context; orchestrator only sees the
path. Workers do not execute a submit command.

**Prompt caching for workers:** schema definition, general instructions, and
repo metadata form a fixed shared prefix identical across all workers in a run.
Per-packet content (file list, task IDs, graph context) follows. The shared
prefix is cache-eligible; structure should be maintained with caching in mind
even before explicit `cache_control` markers are available at the transport
layer.

General caching principle: **shared context at the front, agent-specific
payload at the back.** Applies to design review agents, auditor workers, and
synthesis narrative.

---

## Synthesis narrative (always runs)

`synthesis_narrative_current` becomes a proper `host_delegation` executor.
Always fires; never skipped unless running headless (auto-complete writes
`status: "omitted"` so headless runs still terminate cleanly).

Host agent receives the findings and produces themes, executive summary, and
top risks, and WRITES the result to disk itself (the worker-writes-the-file
pattern established under *Design review → Structured output*).

The existing `synthesisNarrativePrompt.ts` is kept; the change is adding the
host_delegation wrapper and executor registration.

---

## Unchanged

- Runtime validation (step order and behavior)
- Synthesis executor (deterministic, unchanged)
- Mandatory lens set: `security`, `correctness`, `reliability`, `data_integrity`
- Gitignore guard logic (root-ignored, share-exceeded guards)
- Auditor hard file grants (scoped access declarations per packet)
- Graph context is per-packet, not per-task (already correct)

---

## Cross-tool alignment

The remediation walkthrough produced a companion design
([`remediation-workflow-design.md`](remediation-workflow-design.md)). Items
shared between the two tools — implement once, in `audit-tools/shared`:

- **Rolling dispatch engine.** The dispatch section above and remediation's
  rolling worktree dispatch are the same loop (quota tracking, per-packet
  provider selection, capacity re-check on result arrival) with different
  packet types. Build it as shared infrastructure, not twice.
- **Provider confirmation (Gate 1) is session-level.** One confirmed provider
  pool covers an audit→remediate pipeline run; remediation does not re-ask.
- **`free_form_intent` interpretation** (interpret to shape weighting/priority;
  never thread verbatim into worker prompts) is the rule in both tools; the
  interpretation logic is a shared concern.
- **Findings contract as remediation seed.** Remediation's contract pipeline
  now consumes `audit-findings.json` to seed goal normalization (both-paths
  design). The findings contract must stay rich enough for that: stable IDs,
  affected files with line evidence, lens/severity, theme links — kept rich
  enough to seed remediation through any audit-side refactor.
- **Token estimation** (`estimateTokensFromBytes`) and the **prompt-caching
  principle** (shared prefix first, per-agent payload last) apply identically
  to auditor workers, design-review agents, and remediation seam-negotiation
  agents.

---

## Hardening decisions

Surfaced while planning the implementation of this redesign through independent
critic→judge rounds. Audit-relevant items (the remediation companion carries the
full set):

- **Consumer-neutral dispatch terminal.** The shared rolling engine's empty-pool
  / no-progress-livelock terminal must not assume a `close` phase (that is
  remediation's). The terminal is a consumer-provided hook: when the confirmed
  pool empties mid-run and the livelock guard trips, audit marks the stranded
  units uncovered and proceeds to **synthesis on partial coverage** — synthesis
  is not hard-gated on full `audit_tasks_completed` once a sanctioned
  partial-completion terminal fires. "Never an undefined or indefinite stall"
  must hold for the audit consumer too.
- **`waiting_for_provider` paused state.** When the confirmed pool empties, the
  engine enters an explicit resumable paused state; re-discovery surfaces only
  genuinely-new providers and never re-offers a Gate-1 settled exclusion. A
  no-progress livelock guard bounds oscillation (N pauses without net new
  capacity → consumer terminal).
- **Per-clause `free_form_intent` escape hatch.** The interpreter decomposes a
  compound intent into clauses and assesses each clause's encodability
  independently; any clause it cannot encode as priority/lens/scope signals
  (e.g. "freeze the public API of Y") is promoted to a blocking checkpoint
  question and carried as an explicit machine-checkable constraint — even when
  sibling clauses encode cleanly. Detection keys on per-clause encodability, not
  total-encoding-failure.
- **Pinned shared APIs + integration checkpoint.** The three shared APIs
  (rolling dispatch engine, Gate-0/Gate-1 provider confirmation, free_form_intent
  interpreter) are pinned/versioned seam contracts; wire them through one real
  consumer (audit-code) end-to-end and validate before the full fan-out.
