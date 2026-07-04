# Backlog-remediation design (canonical conceptual spec)

Durable design for the backlog-sweep modules and the cross-module seam contracts they
share. Timeless: the *contracts* and the *verified invariants*, not run status. Live
shipped-vs-open status lives in [`backlog.md`](backlog.md) and [`HANDOFF.md`](HANDOFF.md);
this doc is the architecture those track against.

## Modules

| id | module | one-line |
|----|--------|----------|
| O1 | friction-capture | auto-capture mechanical friction via one `captureFrictionEvent` sink + mandatory blocking host-triage close-out + drop empty-`[]` false-green; both orchestrators |
| O2 | append-only-ledger-and-lock | immutable append-only results ledger (content-key re-association, retain-unassigned) + `withFileLock` around advance/persist + exported semantic-equivalence staleness gate (normalize → bounded LLM judge, fail-safe uncertain⇒changed) |
| O3 | emit-validate-repair-seam | one shared `src/shared/repair` seam: deterministic optional-coercion + identity-backfill (warned) → bounded errors-only LLM patch (~1) → re-dispatch; single-sourced canonical validator + field classification |
| F1 | granular-staleness | per-unit/per-task content-addressed staleness; skipped-by-construction; single adjacency table + dep-map literal parity |
| F2 | codebase-churn-context-enforce-review | non-mutating codebase-wide review pass → report + spun-off fix blocks (runs after O2/O3/F1/F3) |
| F3 | schema-enforced-generation | per-backend strongest output-constraint (forced tool-call / json-schema / structured) at emit, provider-agnostic discovery; degrade to O3 |
| F4 | dispatch-broker-and-driver | single gated broker (read-quota / deterministic-local estimate / refuse-over-budget / await-completion) + capability-tiered Y/slot-pull driver + classify capable hosts off cold-start floor |
| F5 | analyzer-acquisition-engine | own-only-agnostic; acquire ecosystem-native tools on demand (probe→run→normalize via adapter→degrade-to-empty); mechanical run-safety gate + default set + per-run consent, no allowlist |
| F6 | git-history-mining | owned language-agnostic `git_history.json`: co-change coupling, churn×complexity, author concentration/bus-factor → graph/risk/maintainability |
| D | deferred-code-slivers | D8 prose-staleness narrowing (gated), D1–D6 surface-external-blocker-only |

## Reconciled seams (single source of truth per seam)

- **content-key (O2↔F1):** ONE canonical-input derivation chain (`src/shared/contentKey.ts`) yields three
  nested keys — `identityKey` (grouping, excludes task-content signature), `idempotencyKey`
  (signature-stable re-association/idempotency anchor), `contentKey` (signature-sensitive staleness
  driver) — related by a documented invariant (equal `contentKey` ⟹ equal `idempotencyKey` ⟹ equal
  `identityKey`). O2's ledger re-association and F1's element-staleness gate both import all three from
  this single seam.
- **semantic-equivalence gate (O2↔F1↔D8):** O2 exports ONE reusable gate; F1/D8 consume; `staleness.ts`
  edit order O2→F1→D8. The verdict must be cached/persisted in `artifact_metadata` so the staleness DAG
  stays reproducible across runs (LLM sampling otherwise flips it).
- **validator + field classification (O3↔F3):** O3 single-sources the canonical validator +
  REQUIRED/OPTIONAL + tool-owned-identity classification in `src/shared/repair`; F3 imports it. One
  schema-of-record per emit path.
- **broker handle (O3↔F4):** O3's stage-2 patch + stage-3 re-dispatch issue only through F4's broker;
  `awaitNextCompletion` hands the raw result to O3.
- **provider capability (F3↔F4):** descriptor discovered once on the provider contract (F3); F4 surfaces
  it at the dispatch site (reads, doesn't compute).
- **friction sink (O1↔O3/O2/F4/F5):** ONE `captureFrictionEvent` under `src/shared/friction` wrapping
  `frictionCapture.ts`; all mechanical seams call it; appends ride O2's `withFileLock`.
- **git_history registration (F6↔F1):** F1 registers `git_history.json` in the DAG + `dep-map.md`
  atomically with F6.
- **own-vs-acquire (F5↔F6):** git-history + secret-scan are owned, not acquired through F5's adapter seam.

## Dependency ordering (why foundations lead)

Foundations (O1, O2, O3 + the shared content-key seam) are the shared seams every consumer imports, so
they land first. **O2 is the data-loss fix** — its absence lets a re-plan destroy the gitignored,
no-backup run tree (see the concurrent-next-step staleness-cascade trap) — so it leads within foundations.
Consumers (F1/F3/F4/F5/F6) each build on a landed, dogfooded foundation; F2 (review pass) and D run last.
Green-at-every-commit + atomic-replace across ~10 interdependent tracks on the no-backup tree is why this
is phased rather than one monolithic run (the project's own *no monolithic change* / failure-isolation
principles). Phasing also creates a dogfood loop — land O2/F1/F4, run the tool in anger, prove the
data-loss/dispatch fixes before the next track builds on them.

## Verified design invariants (from adversarial counterexamples)

These are accepted design flaws found by independent critic+judge; the **fix** is the invariant the
implementation must hold.

- **Ledger identity (CE-001 / FC-001):** `{unit_id, lens, pass_id}` is NOT unique (deepening/steward +
  base worker; or O3 re-dispatch emitting a fresh result with unchanged coordinate). The ledger is keyed
  by a per-record **instance id** (append-only, every record distinct); `identity_key` is a *grouping*
  key for re-association (one→many), never a primary key; content_key adds a result-content discriminator.
- **Append idempotency (CE-001b, blocking):** instance-id keying needs an idempotency rule or replay /
  recovery / merge-retry mints duplicate records for the same logical result → coverage inflation. Ingest
  is **idempotent on contentKey** — append only when no existing record shares contentKey; same logical
  result replay = no-op; two genuinely-different results (distinct discriminator) both persist.
- **Gate cache versioning (CE-002):** a verdict cache keyed only `(prior,new)` goes stale after
  `normalizeConfig` or judge model/prompt changes. Version the cache key with `gate_version`
  (normalizeConfig hash + judge identity/prompt version); mismatch forces re-judge (fail-safe ⇒ changed).
- **Lock-short repair (CE-003):** O3's stage-2 LLM patch must run OUTSIDE any held artifact-tree lock
  (same discipline as O2's judge) or it starves siblings with lock-timeouts.
- **Triage predicate covers reflections (CE-004):** zero auto-captured events + ≥1 agent-feedback
  reflection must NOT auto-satisfy. The satisfaction predicate covers BOTH events AND surfaced reflections
  — triage blocks until every surfaced item is dispositioned.
- **Per-category friction walk (mandatory):** disposition of captured subjects is necessary but not
  sufficient — the close-out ALSO blocks until EVERY friction category in `FRICTION_CATEGORIES`
  (`ambiguous_direction` / `tool_should_decide` / `inefficient_feeding`) is covered by ≥1
  category-tagged `open_observations[]` entry OR an explicit `category_attestations[]` "nothing to
  report". A category can never be skipped by silence — the exact omission that let end-of-run friction
  go unlogged. An optional `free_form_notes` string carries anything that fits no category. Single-sourced
  in `src/shared/friction/triage.ts`; both orchestrators inherit it (they already render
  `buildFrictionTriageBlock`).
- **Cross-call read-judge-write (CE-005):** `withFileLock` is per-call and the judge runs outside it, so a
  concurrent ingest can append between read and commit. The post-judge re-check compares a ledger/version
  token captured at read vs. re-acquire; any interleaved append forces re-derive. Bound retries (N then
  take the lock across the judge) to avoid livelock.
- **Per-element array identity (CE-006):** a `workerResult` `AuditResult[]` carries one task-level
  identity; backfilling a single `unit_id` onto every element collapses distinct units. Stage-1 backfill is
  per-element only where the element's own identity is recoverable; a missing per-element `unit_id` (array
  spans units) escalates as unrepairable, never homogenized.
- **Owned signature (FC-002):** the `task_content_signature` builder is OWNED by the content-key seam, never
  caller-built (caller signatures = false-fresh latent bug).
- **No-op-safe sink ordering (FC-005):** land `captureFrictionEvent` as a callable no-op FIRST (so O2 can
  land before O1's full triage wiring without breaking green-at-every-commit), then O1 wires mandatory triage.

## Still-gated (not landable on tooling alone)

- **D7/D8** need a manual proxy session / churn measurement this tooling can't produce — record as gated,
  never present as landable now.
- **F5 fetch-and-run** of third-party tools is a real ACE / supply-chain surface: per-run consent is the
  primary control, default set explicitly enumerated + first-use consent.
- **Parity** is single-source extraction, never a drift-test (standing preference).
