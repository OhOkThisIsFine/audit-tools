# Backlog remediation — plan of record (2026-06-24)

Full reconciled design for remediating the entire actionable backlog (`docs/backlog.md`
Open bugs + Forward tracks + Deferred slivers; **Durable traps** excluded as reference).
Produced by `/remediate-code docs/backlog.md`; this doc is the **plan of record**. The
ephemeral contract artifacts live under `.audit-tools/remediation/intake/contract/`
(gitignored) — this doc is the durable capture so the design survives the run.

**Delivery is phased** (independent design review flagged single-run execution as
over-scoped — 3 blocking concerns: over-scoping, prose-only edit-ordering, F2
mis-sequencing). See *Phasing* below. **This run implements the foundations phase only.**

## Modules (10)

| id | module | one-line |
|----|--------|----------|
| O1 | friction-capture | auto-capture mechanical friction via one `captureFrictionEvent` sink + mandatory blocking host-triage close-out + drop empty-`[]` false-green; both orchestrators |
| O2 | append-only-ledger-and-lock | immutable append-only results ledger (content-key re-association, retain-unassigned) + `withFileLock` around advance/persist + exported semantic-equivalence staleness gate (normalize → bounded LLM judge, fail-safe uncertain⇒changed) |
| O3 | emit-validate-repair-seam | one shared `src/shared/repair` seam: deterministic optional-coercion+identity-backfill (warned) → bounded errors-only LLM patch (~1) → re-dispatch; single-sourced canonical validator + field classification |
| F1 | granular-staleness | per-unit/per-task content-addressed staleness; skipped-by-construction; single adjacency table + dep-map literal parity |
| F2 | codebase-churn-context-enforce-review | non-mutating codebase-wide review pass → report + spun-off fix blocks (runs AFTER O2/O3/F1/F3) |
| F3 | schema-enforced-generation | per-backend strongest output-constraint (forced tool-call / json-schema / structured) at emit, provider-agnostic discovery; degrade to O3 |
| F4 | dispatch-broker-and-driver | single gated broker (read-quota / deterministic-local estimate / refuse-over-budget / await-completion) + capability-tiered Y/slot-pull driver + classify capable hosts off cold-start floor |
| F5 | analyzer-acquisition-engine | own-only-agnostic; acquire ecosystem-native tools on demand (probe→run→normalize via adapter→degrade-to-empty); mechanical run-safety gate + default set + per-run consent, no allowlist |
| F6 | git-history-mining | owned language-agnostic `git_history.json`: co-change coupling, churn×complexity, author concentration/bus-factor → graph/risk/maintainability |
| D | deferred-code-slivers-and-surfacing | D7 prompts.ts `DO_NOT_TOKEN_WRAP_NOTE` deletion (gated), D8 prose-staleness narrowing (gated), D1-D6 surface-external-blocker-only |

## Reconciled seams (single source of truth per seam)

- **content-key (O2↔F1):** ONE shared canonical key over `{unit_id, lens, pass_id, task-content signature}`; O2 ledger re-association and F1 element staleness both import it. *Open caveat (review C-006): re-association wants stability across re-plan; staleness wants it to bump on upstream change — prove one key serves both or derive two keys from one canonical input with a documented relating invariant.*
- **semantic-equivalence gate (O2↔F1↔D8):** O2 exports ONE reusable gate; D8/F1 consume; staleness.ts edit order O2→F1→D8. *Open caveat (review C-004): verdict must be cached/persisted in artifact_metadata so the staleness DAG stays reproducible across runs (LLM sampling otherwise flips it).*
- **validator + field classification (O3↔F3):** O3 single-sources canonical validator + REQUIRED/OPTIONAL + tool-owned-identity classification in `src/shared/repair`; F3 imports it. One schema-of-record per emit path.
- **broker handle (O3↔F4):** O3's stage-2 patch + stage-3 re-dispatch issued only through F4's broker; `awaitNextCompletion` hands raw result to O3.
- **provider capability (F3↔F4):** descriptor discovered once on the provider contract (F3); F4 surfaces it at the dispatch site (reads, doesn't compute).
- **friction sink (O1↔O3/O2/F4/F5):** ONE `captureFrictionEvent` under `src/shared/friction` wrapping `frictionCapture.ts`; all mechanical seams call it; appends ride O2's `withFileLock`.
- **git_history artifact registration (F6↔F1):** F1 registers `git_history.json` in the DAG + dep-map.md atomically with F6.
- **own-vs-acquire (F5↔F6):** git-history + secret-scan are owned (not acquired through F5's adapter seam).
- **D7 shared-file edit (D↔O1):** O1's remediate `nextStep.ts` edit lands first; D7's usage removal rebases.
- **F2 sequencing/ownership:** F2 last; findings carry overlap disposition vs O2/O3/F1/F3/D; spun-off blocks reconciled against D's edit ownership.

## Phasing (delivery)

1. **Foundations (THIS RUN):** O1, O2, O3 + the shared content-key seam. O2 is the data-loss
   fix (its absence can destroy the gitignored no-backup run tree), so it leads. These are the
   shared seams every consumer imports.
2. **Consumers:** F1, F3, F4, F5, F6 — each builds on a landed, dogfooded foundation.
3. **Review + slivers:** F2 (generates new fix blocks → its own run) and D.

Rationale: green-at-every-commit + atomic-replace across ~10 interdependent tracks on the
no-backup run tree maximizes blast radius and violates the project's own *no monolithic change*
/ failure-isolation principles. Phasing also creates a dogfood feedback loop — land O2/F1/F4,
run the tool in anger, prove the data-loss/dispatch fixes before the next track builds on them.

## Review caveats to fold into the relevant phase

- **C-004** semantic-gate verdict must be persisted/cached → deterministic-on-replay (Phase 1, O2).
- **C-006** content-key dual-purpose tension — prove or split (Phase 1, O2/F1 seam).
- **C-007** D7/D8 are gated on a manual proxy session / churn measurement this tooling can't
  produce — record as still-gated, do not present as landable now.
- **C-009** F5 fetch-and-run third-party tools is a real ACE/supply-chain surface; per-run
  consent should be the primary control, default set explicitly enumerated + first-use consent.
- **C-010** ensure parity is single-source extraction, not a drift-test (Ethan standing pref).

## Foundations-phase review caveats (must be honored in implementation)

From the independent critique of the foundations design (approved_with_concerns):

- **FC-001 (blocking)** `identity_key = hash{unit_id, lens, pass_id}` must be PROVEN unique per
  result. If two distinct tasks can share `(unit_id, lens, pass_id)`, O2 silently mis-binds/merges
  ledger records on re-association. Implementation must verify uniqueness (assert/test) or add a
  task-stable discriminator to the identity tuple.
- **FC-002 (blocking)** The `task_content_signature` builder must be OWNED by content-key-seam
  (the tool), not left to caller discretion — caller-built signatures are a false-fresh latent bug.
  Single-source the signature recipe so it's derived only from task-defining content.
- **FC-005 (blocking)** O1's `captureFrictionEvent` sink must be no-op-safe / inert-by-default so
  O2 can land before O1's full triage wiring without breaking green-at-every-commit (the two are
  mutually entangled, not linearly orderable). Land the sink as a callable no-op first, then O1
  wires the mandatory triage.

## Adversarial counterexamples — accepted, must fix in the foundations contracts

From the independent critic + judge (verdict needs_repair). All six are accepted as real design
flaws to fix in `finalized_module_contracts` before implementation:

- **CE-001 (identity_key not unique within a pass).** `{unit_id, lens, pass_id}` is NOT unique when
  the pipeline produces >1 result for one coordinate in one pass (deepening/steward + base worker;
  or O3 stage-3 re-dispatch emitting a fresh result with unchanged identity). Two distinct results
  then share identity_key → O2 ledger mis-merge (last-writer-wins). **Fix:** the ledger is keyed by a
  per-record **instance id** (append-only, every record distinct); `identity_key` is a *grouping*
  key for re-association (one→many), never a primary key, and re-association never collapses two
  records. content_key adds a result-content discriminator so same-coordinate distinct results differ.
- **CE-002 (cache key omits gate version).** The semantic-gate verdict cache keyed only on
  `(priorValue,newValue)` returns a stale 'unchanged' after the normalizeConfig or judge model/prompt
  changes (both change over the tool's life). **Fix:** version the cache key with a
  `gate_version` (normalizeConfig hash + judge identity/prompt version); a version mismatch forces
  re-judge (fail-safe toward changed).
- **CE-003 (O3 stage-2 LLM patch held across O2's lock).** Only O2's judge is fenced outside the
  lock; O3's stage-2 patch runs at the emit site inside the withFileLock persist path → lock
  starvation + sibling lock-timeouts. **Fix:** the same lock-short discipline applies to O3 — the
  stage-2 LLM patch runs OUTSIDE any held artifact-tree lock (repair completes before the locked
  persist, or the lock is released around it).
- **CE-004 (reflections surfaced but not in the satisfaction predicate).** Zero events + ≥1
  agent-feedback reflection auto-satisfies (empty-event set trivially disposed) while surfaced
  reflections go untriaged. **Fix:** the satisfaction predicate covers BOTH auto-captured events AND
  surfaced reflections — triage blocks until every surfaced item (event or reflection) is dispositioned.
- **CE-005 (cross-call read-judge-write window).** withFileLock is per-call; the judge runs outside
  it, so a concurrent ingest can append between A's read and A's commit, and the re-check only guards
  A's own append. **Fix:** the post-judge re-check compares a ledger/version token captured at read
  vs. at re-acquire; any interleaved append forces A to re-derive (not commit an S0 verdict over S1).
- **CE-001b / R2-C-001 (append-time idempotency, blocking).** Per-record instance-id keying with
  dedup forbidden (CE-001) lacks an idempotency rule, so an operator re-run or O2's own
  recovery/merge-retry replay mints duplicate records for the SAME logical result (equal contentKey)
  → coverage inflation. **Fix:** ingest is idempotent on **contentKey** — append a new instance record
  only when no existing record shares its contentKey; a replay of the *same* logical result is a no-op,
  while two genuinely-different results (distinct result_content_discriminator → distinct contentKey)
  both persist. This reconciles "every distinct result persists" (CE-001) with replay-safety.
- **R2 advisories (fold into impl):** result_content_discriminator needs a single defined authority
  per emit path (base = stable default tag; re-dispatch = attempt counter; deepening/steward = source
  tag) so it's never operator-chosen; the O2 cross-call re-check (CE-005) must bound retries (e.g. N
  attempts then take the lock across the judge) to avoid livelock under steady ingest; gate_version's
  judge-identity component must be a locally-known opaque id (no API call); make the O3→O2-lock and
  O3/O2→O1-sink edge ordering explicit in the build sequence.
- **CE-006 (array emit homogenizes per-element identity).** workerResult emits an AuditResult[] with
  one task-level caller identity; backfilling the single unit_id onto every element collapses distinct
  units. **Fix:** stage-1 backfill is per-element only where the element's own identity is recoverable;
  a missing per-element unit_id (where the array spans units) escalates as unrepairable, never
  homogenized.
