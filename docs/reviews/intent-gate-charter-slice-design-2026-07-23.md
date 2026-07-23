# Design v2 — intent-checkpoint gate wiring + charter slice-staleness

2026-07-23. Joint design for the two DECIDED backlog entries (intent-checkpoint over-staling,
charter phantom-staleness), per the spec's "design the two together". Premises verified against
HEAD `b9f38a31` (Codex trace + NIM mechanism map + direct read). v2 after AGY critique: finding
3.1 (baseline self-overwrite) killed the v1 "verdict-cache overlay in the staleness compare";
AGY §5's effective-hash materialization replaces it — simpler and it leaves the staleness
compare intent-free.

## Verified premises (recon record)

1. `intentCheckpointGate.ts` is built + tested, **zero production callers** (CONFIRMED).
2. `NON_SEMANTIC_FIELDS_BY_ARTIFACT` has **no `intent_checkpoint.json` entry** — `confirmed_at`/
   `confirmed_by` participate in the canonical hash; a byte-identical-prose re-confirm re-stales
   the cascade purely on the timestamp (CONFIRMED).
3. Dependency staleness keys on the **whole upstream artifact hash + revision**
   (`staleness.ts:131-139`); no per-edge slice exists (CONFIRMED). The charter path consumes:
   `intent_checkpoint` → only `design_review.ceiling` (fallback `conceptual_depth`);
   `structure_decomposition` → only `consensus[*].{node_id, members}`; `repo_manifest` → only
   `files[].hash` of consensus **member** paths (`charterExtractionExecutor.ts:18,38`,
   `charterExtractionPrompt.ts:21`).
4. `intent_checkpoint.json` fans out to charters, coverage_matrix, audit_tasks,
   audit_plan_metrics, requeue_tasks → dispatch planning → reporting. Results/redispatch are
   protected downstream by task-content signatures — the re-stale cost is the planning/charter/
   reporting tail, not worker re-runs.

## Mechanism

### A. Non-semantic strip (spec layer 1)

`NON_SEMANTIC_FIELDS_BY_ARTIFACT["intent_checkpoint.json"] = ["confirmed_at", "confirmed_by"]`.
A provenance-only re-confirm no longer moves the canonical hash → no revision bump → zero
downstream staleness. `schema_version` deliberately STAYS in the hash (a schema migration is a
semantic reinterpretation — AGY 1.3). Reports that render `confirmed_at` go stale on a
timestamp-only re-confirm by design — re-running planning to refresh a timestamp string is the
absurdity being fixed.

### B. Intent equivalence — obligation + effective-hash commit (spec layer 2)

**Widen** the semantic surface to every `IntentCheckpoint` field except
`confirmed_at`/`confirmed_by`, SPLIT into two normal forms (NIM finding: an LLM judge must never
arbitrate structured deltas — a `ceiling` 3→5 could be waved through as "equivalent" by a
prose-focused judge):

- **structured**: `schema_version`, `excluded_scope`, `must_not_touch`, `filters`,
  `constraint_clauses`, `disposition_overrides`, `lens_selection`, `design_review` — a structured
  delta is DETERMINISTICALLY `changed`, no judge, drainable.
- **prose**: `scope_summary`, `intent_summary`, `free_form_intent` — a prose-only delta (structured
  equal) is the ONLY thing the host judge arbitrates.

`NormalizeConfig` carries both lists; version bumps to `intent-checkpoint-normalize/v2`.

**Baseline side-store** in `artifact_metadata` (carried on CE-007 terms like `result_baselines`):

```
intent_baseline?: {
  normalized_structured: string;  // structured normal form downstreams last derived against
  normalized_prose: string;       // prose normal form ditto
  revision: number;               // intent entry revision at last RESOLVED state
  gate_version: string;           // computeGateVersion({ judgeId: "host" }) at stamp time
}
```

Baseline is written ONLY by the equivalence executor (never by `computeArtifactMetadata`, which
only carries it — AGY 3.1): (a) absent → stamp from current checkpoint (satisfied); (b) on a
judge-verdict commit; (c) on headless auto-resolve.

**Obligation `intent_equivalence_current`** — PRIORITY slot directly after
`intent_checkpoint_current`, before `charter_extraction_current` (every intent consumer sits at
or below the charter slot, so nothing derives against a pending pair). Unsatisfied iff intent
present ∧ baseline present ∧ gate-version-current ∧ (structured OR prose normal form differs from
baseline). Executor (`host_delegation`, mirrors `critical_flow_fallback`):

- **Deterministic drainable arms**: baseline absent → stamp + satisfied. Baseline
  gate_version stale (config-hash / prompt-version / judge-id component mismatch — all three
  locally derivable, judgeId is the constant `"host"`) → treat as CHANGED (over-stale, safe
  direction): leave the bumped entry, restamp baseline from current, done. STRUCTURED normal form
  differs → deterministic `changed` commit (no judge): keep the bumped entry, advance baseline.
- **Judge arm** (non-drainable host step; fires ONLY on a prose-only delta): render both prose
  normal forms + the judge prompt (template-versioned); host submits `{ verdict: "equivalent" |
  "changed", judged_pair: { prior_hash, new_hash } }` via the standard incoming
  consume-or-quarantine helpers.
  Consumption re-derives the live pair; a mismatch (intent moved again mid-judgment) discards
  the submission and the obligation re-fires on the new pair (AGY 4.2 safe).
- **Commit** (the effective-hash materialization):
  - `equivalent` → set the intent entry to `{ revision: baseline.revision, content_hash:
    currentHash }` — the interim unlisted-mismatch auto-bump is UNDONE, downstream
    `dependency_revisions` compare clean, nothing re-derives. Baseline `normalized` advances to
    current, `revision` stays.
  - `changed` → keep the bumped entry; baseline advances to `{ normalized: current, revision:
    entry.revision }`; downstreams re-derive normally.
- **Headless** (`advanceAudit` with no host): auto-resolve as `changed` (fail-safe, current
  behavior) — no livelock, no fabricated equivalence.
- Fail-safe default per the gate contract: malformed/uncertain submission → quarantine +
  re-emit; only an explicit `equivalent` restores the revision.

No verdict-pair cache is persisted: a verdict is materialized into the entry/baseline at commit,
so a seen pair never re-fires (only a revert A→B→A re-pays one judge round — accepted, rare,
fail-safe direction; AGY 2.3).

Chain semantics: A→B `equivalent`, B→C `equivalent` never compares C to A — equivalence is
committed per hop (drift-by-increments is bounded by the judge prompt's strictness; accepted).

### C. Charter dependency-slice layer

New module `src/audit/orchestrator/dependencySlices.ts`:

- `DEPENDENCY_SLICE_PROJECTIONS: Record<downstream, Record<upstream, (bundle) => unknown>>` —
  per-EDGE projections over the whole bundle (the member-file slice needs `structure_decomposition`
  membership to slice `repo_manifest`).
- `computeDependencySliceHash(downstream, upstream, bundle)` → sha256 of
  `stableStringify(projection(bundle))`; `undefined` when no projection registered; a throwing
  projection → treated as slice-changed (fail-safe stale).

| downstream | upstream | slice |
|---|---|---|
| charter_register | structure_decomposition | `consensus[*].{node_id, members}`, path-sorted |
| charter_register | repo_manifest | `{path → hash}` restricted to consensus member paths |
| charter_clarification | repo_manifest | same member-file slice |
| systemic_challenge | repo_manifest | same member-file slice |

Slice-direction invariant (stated in the module + pinned by contract test): a slice must be a
**superset** of what the consuming path reads — narrower under-stales. These four are exactly the
HEAD-verified consumption; widen when the charter path consumes more. (`charter_clarification`/
`systemic_challenge` keep their whole-artifact edges on `charter_register` + `intent_checkpoint` —
those are handled by A/B.) Intent edges get NO slice projections — layer B handles them.

**Stamping** (`artifactMetadata.ts`): on a LISTED re-derive, stamp
`dependency_slices?: Record<upstream, sliceHash>` on the entry for projected edges — computed and
preserved on EXACTLY the same terms as `dependency_revisions` (an unlisted mismatch-restamp
preserves both verbatim). Additive optional field — **no `METADATA_SCHEMA_VERSION` bump**; an old
manifest lacks recorded slices and falls back to the whole-hash compare until the next listed
re-derive stamps them.

**Compare** (`staleness.ts` per-dependency loop): when a projection is registered AND the entry
records a slice for that edge → the edge is stale **iff** `recordedSlice !== currentSlice`,
replacing the whole-hash + revision disjunction for that edge. The dependency-KEY-SET gate
(recorded-vs-expected dependency names) is untouched. No projection / no recorded slice →
behavior unchanged.

### D. Deletion (ideal-code rule, atomic with the wiring)

Superseded by the step-round-trip + commit-materialization: `intentCheckpointEquivalenceGate`,
`VerdictCache`, `verdictCacheKey`, `runIntentCheckpointGate`, `LedgerVersionToken` — DELETE with
their tests in the same commit. Kept live: `normalizeCheckpointValue`, `NormalizeConfig`,
`DEFAULT_NORMALIZE_CONFIG`, `computeGateVersion` (baseline gate-version currency),
`INTENT_GATE_PROMPT_TEMPLATE_VERSION` (judge-step template version).

## Review deltas already incorporated

- NIM (deepseek) judge-too-narrow → structured/prose normal-form split; the judge arbitrates
  prose ONLY; structured deltas are deterministically `changed`.
- NIM hard-vs-soft gate → the drain serializes on the highest-priority unsatisfied obligation and
  a host_delegation step halts the fold, so the gate is HARD by construction; headless never
  stalls because the executor's headless arm auto-resolves `changed`.
- NIM stamping hole ("computeArtifactMetadata has no slice logic") → implementation requirement:
  the LISTED-re-derive branch stamps `dependency_slices`; the unlisted-restamp branch preserves
  them verbatim alongside `dependency_revisions`; the carry branch carries them.

- AGY 3.1 (baseline self-overwrite) → baseline written only by the executor; v1 overlay dropped.
- AGY §5 (simpler effective-hash mechanism) → adopted as layer B's commit.
- AGY 2.1 (gate-version unvalidated on cache hits) → moot (no cache); baseline gate_version is
  validated with all three components locally derivable.
- AGY 1.3 (`schema_version` under-stale) → included in semanticFields + stays in canonical hash.
- AGY 4.2 (mid-judgment second edit) → judged-pair-vs-live check discards + re-fires.
- AGY 1.1/1.2 (charter slice too narrow / missing edges) → REFUTED by HEAD trace (consumption is
  exactly node_id+members; clarification/challenge have no structure_decomposition edge), drift
  risk carried by the slice-direction invariant + contract test.
- AGY 4.1 (verdict writes re-stale intent) → REFUTED: stores live in `artifact_metadata.json`,
  which is excluded from the DAG compare.

## As-built deltas (post Codex adversarial review + implementation)

- **Slice registry narrowed to `charter_register.json` only.** Codex REFUTED the
  `systemic_challenge` member slice at HEAD (it consumes the total repo file count and grounds
  findings against the COMPLETE path set — `aggregateMetricsDigest.ts`, `designFindingGrounding.ts`),
  and `charter_clarification`'s consumption is unverified. Both keep whole-artifact edges; residual
  over-staling on unrelated manifest churn is accepted (cheap steps; revisit with a verified trace).
- **Repo slice = member files ∪ `doc_only` files** (the Stated pass reads docs/specs/READMEs, which
  are never consensus members — member-only under-stales), with `hash ?? size:<bytes>` (oversized
  files are unhashed in the manifest; an empty fallback erased a real signal).
- **`constraint_clauses` is PROSE** per DD-9's explicit listing (host_answer rephrases are
  judge-arbitrated), not structured as first drafted.
- **Slice-protected edges also block TRANSITIVE propagation** — implementation surfaced that the
  propagation loop re-created the phantom re-fire (manifest churn → structure stale → charter
  pre-emptively staled). A slice-protected edge defers to the post-re-derive slice compare; safe
  under PRIORITY ordering (upstream obligations run first, staleness re-derives per drain
  iteration). Regression-pinned in `tests/audit/dependency-slices.test.mjs`.
- **The O2↔F1↔D8 seam line in `docs/backlog-remediation-design.md` was updated** to the as-built
  shape (deterministic normal forms + host-judged step + persisted baseline; no in-process judge
  callback, no verdict cache) — the recorded planned consumer follows the new mechanism.

## Independent-review record (loop-core tier)

Four independent reviewers over design + as-built code; Codex CLI quota-walled mid-lap (its
completed design review still counts below):

- **Codex (design review, pre-implementation):** refuted the `systemic_challenge` member slice and
  the member-only doc set (findings 3–5) — both incorporated; confirmed drain/pause and deletion
  premises.
- **AGY gemini-3.6-flash (design critique, inlined):** found the v1 baseline self-overwrite (3.1 —
  design-changing) and proposed the effective-hash materialization (§5) that shipped; its diff
  review's finding 4 (gate-flap revision snap-back) drove the `Math.max` no-rewind guard.
- **NIM deepseek/glm (mechanism + wiring reviews):** judge-scope split (structured deltas never
  LLM-judged) came from deepseek's design critique; its as-built review's ordering question is
  answered by `advance.ts` (stamper runs on the post-executor `run.updated`); glm's wiring findings
  all resolved against the fuller engine context (satisfied obligations are never selected; the
  crash-resume double-apply is idempotent by status re-derivation).
- **Host-subagent repo-grounded review (final):** verdict FIX-FIRST with F1 (delta-producer grounds
  against the FULL path set → sorted path list added to the repo slice), F2 (doc predicate
  single-sourced with `isDocIntentFile` = doc_only ∪ doc-extension), F3 (normalize-config
  exhaustiveness contract test), F4 (stale-pair discard now loud on stderr) — ALL APPLIED, each
  test-pinned. Its remaining notes: pure-headless does not pause but converts the judgment to a
  deterministic `changed` (documented headless fail-safe), and the one-time CHANGED cascade on
  legacy run dirs at first post-upgrade contact (the hash-scheme change makes the stamp arm's
  pending branch fire once) is the accepted, safe direction.

My own re-trace additionally found and fixed the legacy first-contact fail-open (stamp arm now
resolves a hash-mismatched first contact as CHANGED) and the propagation-loop re-fire (slice edges
block transitive propagation), both test-pinned.

## Risk notes for reviewers

- Loop-core (`staleness.ts`, `artifactMetadata.ts`, `nextStep.ts`, state derivation) —
  attestation required.
- The 'equivalent' commit REWINDS a revision (entry.revision := baseline.revision). Verify no
  consumer treats revisions as strictly monotonic within a run (cycle detection uses content
  hashes, not revisions — `computeArtifactStateSignature`).
- The interim window: between the host's intent write and the judge commit, a metadata pass
  auto-bumps the intent entry (unlisted mismatch restamp). Confirm no obligation ABOVE the
  equivalence slot consumes intent_checkpoint (verified: consumers all sit at/below charters).
- Slice compare replaces the revision compare on the four charter edges: confirm no signal rides
  the revision-only path for those edges (e.g. a repo_manifest re-extraction that changes NOTHING
  in the member slice but legitimately should re-fire charters — by the verified consumption, it
  should NOT).
