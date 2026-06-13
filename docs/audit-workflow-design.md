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
  → batch_deterministic     [auto_fix → syntax_resolved → structure_artifacts
                             → graph_enrichment → design_assessment]
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

Steps 2–6 (auto_fix → syntax_resolved → structure_artifacts → graph_enrichment
→ design_assessment) run in a single next-step call. The orchestrator advances
through all pending deterministic obligations before returning. No separate
roundtrip per step. Execution halts at the first host_delegation obligation or
when all obligations are satisfied.

---

## Gate 2 — Intent checkpoint (extended)

The main repo-specific user gate. Fires after the deterministic block, before
design review.

**Orchestrator prepares before showing the host:**

*Scope pre-digest (existing, improved):*
- Full/delta mode, files in scope, in-scope directory breakdown
- Excluded files displayed collapsed by directory prefix: if every file under a
  prefix shares the same status and reason, show the directory once with a file
  count. Enumerate individual files only where they are the odd ones out within
  an otherwise-included directory. Cap is high (exact value TBD) to handle
  unusual projects. Generalize the aggregation already present in
  `buildFileDisposition` for vcs-ignored files above 200.

*Disposition override proposals (new):*
- Scan `file_disposition` for suspicious inclusions the heuristics missed
  (build output, vendored code, generated files that slipped through)
- Propose per-file or per-directory status corrections with reasons

*Lens proposals (new):*
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

Both passes dispatched simultaneously as two independent host_delegation agents.
Finding sets merge into synthesis as distinct report sections, separate from
auditor findings.

**Structured output:** both agents emit findings inline; skill writes to disk.

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

---

## Dispatch — rolling, quota + capability-routed

**No pre-computed wave size.** Dispatch is not batched into fixed waves.

**No separate concurrency cap.** With accurate token estimation, quota limits
are the only throttle. RPM and TPM per provider/model are tracked from: prior
quota queries, estimated in-flight token usage per task, and results as they
arrive.

**Per-packet provider selection:** before dispatching each packet, the
orchestrator scores its complexity (priority, lenses, estimated tokens, critical
flow membership) and selects the provider/model from the confirmed pool
accordingly. High-complexity packets route to more capable models;
lower-complexity packets route to faster/cheaper ones.

**Rolling dispatch loop:**
1. Check quota state across all providers in the confirmed pool
2. Dispatch all packets that fit within available quota, matched to appropriate
   providers by complexity
3. As each result arrives: update quota estimates, immediately dispatch the next
   fitting packet
4. Continue until all tasks complete

**Ingestion folded in:** when results arrive, ingestion and re-dispatch happen
in the same logical turn. No separate next-step call just to ingest.

**Auditor structured output:** workers emit `AuditResult[]` inline in their
response. Skill captures and writes the file. Payload stays out of orchestrator
context; orchestrator only sees the path. Workers no longer manually write JSON
or execute a submit command.

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
top risks. Emits inline; skill writes to disk.

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

## Cross-tool alignment (added 2026-06-10)

The remediation walkthrough produced a companion design
([`remediation-workflow-design.md`](remediation-workflow-design.md)). Items
shared between the two tools — implement once, in `@audit-tools/shared`:

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

## Hardening decisions (adversarial review, 2026-06-10)

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
