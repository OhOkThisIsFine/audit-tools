# Forward tracks

> Design-level directions and in-flight tracks — not yet bounded defects.
>
> Part of the split backlog — index: [`docs/backlog.md`](../backlog.md).
> A living to-do list, not a status log. Remove an entry once it ships; record durable
> contracts and rationale in project memory or `CLAUDE.md`, never "where the code is today".

## Open tracks

**Track 2.5 — Slim-down: ~9,400 removable lines, mapped and ranked in
[`slimdown-review-2026-07-28.md`](../reviews/slimdown-review-2026-07-28.md). Nothing applied.**
Deliberately a pointer, not a summary — the report carries 48 items with per-item mechanisms and
corrected estimates, and a second copy here would decay against it. Confidence is **9 CONFIRMED /
7 PARTIAL / 32 UNVERIFIED**; the UNVERIFIED set is grep-backed leads, so re-confirm before deleting.
**The structural finding, which outlives any single deletion:** 56% of the total is whole modules
built, tested, exported and never wired, and **neither knip mode can report that class** — knip finds
unused *exports*, and a barrel re-export or a same-subgraph test counts as a consumer. Whole-file
orphan detection over the relative-import graph, filtered to "referenced only from `tests/`", found
all of it in one pass; that belongs beside the manual `knip --production` sweep as a periodic check
(report §4.7). [[orphan-modules-are-invisible-to-both-knip-modes]]
⚠ Two claims elsewhere are FALSE against HEAD and worth fixing regardless of whether the deletions
happen: this file asserts the F3/O3/F4 emit-validate-repair seam is live (it has zero importers in
`src/`), and `CLAUDE.md` documents `resolveHostConcurrencyLimit` as dispatch concurrency machinery
(zero call sites in `src/` — definition, one unconsumed re-export, and its own tests).
Unpinned on purpose: this is a map to draw from, not the next thing to do.

---



## Forward tracks

- **▶ Mechanical analyzer layer — item C (re-verify loop) is the remaining piece.**
  Items A (safety-derived default set: hadolint/actionlint/type-coverage promoted, jscpd stays
  gated as `config_execution:"executable"`, semgrep pinned, `duration_ms` measured), B (consent
  surfacing: fold-level batched offer + `analyzer_consent` decisions persisted, admission =
  default ∨ granted ∨ token, token overrides declined) and D (lizard, source-walk detection,
  leads-only threshold bands) SHIPPED 2026-08-06. Spec of record stays
  [`spec/mechanical-analyzer-layer-design.md`](../../spec/mechanical-analyzer-layer-design.md);
  item C (mechanical re-verify at remediation close) still requires `/design-check` — the prep
  record (retirement-collision sweep, refutation pass, red-first test plan, all advisory) is in
  [`reviews/backlog-sprint-2026-08-06.md`](../reviews/backlog-sprint-2026-08-06.md).

- **A2 finding-quality oracle — the corpus is SMALL, PUBLIC, PINNED git repos, never labeled
  self-audit runs.** The mechanical answer to "a lane can return success-shaped EMPTY results"
  ([`open-bugs.md`](open-bugs.md)): without ground truth, per-lane yield is a noisy signal and
  lane quality stays a hand-benching judgement, which the tool-enforced rule forbids. Its affirmation
  half (`reviewed_clean`) is shipped; the oracle is what lets yield gate ELIGIBILITY. The
  `score-audit` scorer exists. The REFUTED alternative — hand-labelling a live run's findings into
  `corpus/<run-id>.labels.json` — must not be re-proposed; it has two structural flaws: (a) labels against our own moving tree ROT — findings reference
  file:lines that drift within days, so a labeled run is a one-shot number, never a regression
  gate; (b) labeling only what the tool FOUND measures precision only — misses are invisible, so
  recall is unmeasurable without ground truth the tool didn't author.
  **SPEC:** `corpus/` becomes a manifest of pinned public repos — `{repo_url, commit_sha,
  labels[]}`, each label a ground-truth defect (file, region, kind, evidence — ideally the upstream
  FIX commit that proves it). Ground truth comes from someone-else-maintained inventories where
  possible (bugs fixed in later upstream commits; CVE-tagged pre-fix versions; suites like
  Defects4J / BugsInPy) per the synced-not-forked table principle; hand-authored labels are a
  bounded one-time cost per repo and never rot (the SHA is pinned). `score-audit` gains a
  corpus-repo mode: clone at the pinned SHA (hermetic state via `AUDIT_CODE_STATE_DIR`), run the
  audit ($0 NIM lanes make this per-release cheap), match findings against labels → precision AND
  recall as a repeatable release-time gate. Prefer small-but-REAL repos (real libraries at pre-fix
  commits) over purely synthetic bug suites — synthetic-only corpora overestimate transfer. Rust /
  Ruby pins double as clippy/rubocop analyzer targets (toolchain availability still gates the live
  spawn). **Scope honesty:** this measures finding QUALITY; pipeline-at-scale behavior (charters
  over 1000+ components, quota walls, deepening) stays validated by dogfood runs. The re-dogfood
  run's hand-label is optional large-target calibration, never a blocker for this.



- **Backend-identity axes — settle transport / service / locus once (design of record: [`spec/backend-identity-axes.md`](../../spec/backend-identity-axes.md)).** `provider` still names two concepts (the adapter that carries a request vs. the declared capacity service), and `endpoint` holds two shapes (URL vs. launcher command). The spec settles the vocabulary and the axis each remaining local question binds to; the invariant is **co-locate and name, do not unify**.
  **Staged migration — each stage atomic + green on its own (atomic-replace ordering invariant).**
  The vocabulary rename + chokepoint normalization, the co-located projections in
  `src/shared/providers/identity.ts`, and the axis-explicit exclusion grammar with its capacity
    guard are retired where they represented operator routing policy; the mechanical self-spawn
    guard remains. Open remainder:
  - **Normalization left the declared-account fold unmigrated.** `service = declared ?? transport`
    activates the fold for a source carrying `account` but no `service`, changing those CapacityPool
    ids and orphaning their learned `quota-state.json` keys — those pools silently fall back to blind
    defaults. Not a correctness break, but no migration was ever written.
  - **Stage 3 — KNOWN WRONG, not queued work.** The `Locus` two-arm union (`{kind:"url"} | {kind:"command"}`) is refuted and must not be re-proposed; the reasoning is at [`spec/backend-identity-axes.md`](../../spec/backend-identity-axes.md) → *the url | command locus union*.
  **Property to hold:** a new consumer PICKS an axis from the spec's table; it never invents an identity. ⚠ Do NOT collapse the keyspaces — that instinct is what produced both the bypass and the fail-open proposal.

- **One repo intent, three filenames — the audit/remediate intent split is a `one core, two draws` smell.** Audit's intent is `<root>/.audit-tools/audit/session-config.json` (`src/audit/supervisor/sessionConfig.ts` + `auditArtifactsDir`); remediate's is `<root>/.remediation-artifacts/session-config.json ?? <root>/session-config.json` (`src/remediate/steps/sessionConfigLoad.ts`, called from `nextStep.ts`); a stale guard-message in `claudeCodeProvider.ts`/`agyProvider.ts` still points operators at a third path, `.audit-tools/remediation/session-config.json`, that nothing reads. The wrapper itself no longer seeds it (`wrapper/remediate-code-wrapper-install-hosts.mjs` deliberately creates the config empty on demand). Two draws still read one concept from different homes.
  **SPEC — one canonical intent path for both draws, and make the migration LOUD rather than silent.**
  The intent is one concept and belongs in one place; two draws reading different files is the fork this
  project's "one core, two draws" rule exists to prevent, and the third path is already dead — nothing
  reads it, so it is deleted outright along with the guard messages still advertising it.
  **The reason this was never done is the real constraint, and it is about MIGRATION, not design:**
  silently changing which file a run reads would change behavior for any existing checkout without
  telling anyone, and a run that quietly picks up a different config is far worse than one that stops.
  So the unification refuses to guess. Both draws read the canonical path; if a legacy path still holds
  a config, the tool fails loudly and names the file to move rather than falling back to it or merging
  the two. A one-time explicit operator action is the correct cost, and it is bounded — nobody has more
  than a handful of checkouts.
  **Property to hold:** one concept, one path, both draws; and no code path ever silently resolves an
  intent from a location the operator was not told about.

- **Generate the executor↔artifact mapping from the registries (anti-drift).** `executor-catalog.md` +
  `dependency-map.md` both render the executor→artifact relation, hand-maintained over `EXECUTOR_REGISTRY`
  (`src/audit/orchestrator/executors.ts`) + `ARTIFACT_DEFINITIONS` (`src/audit/io/artifacts.ts`) — it drifted
  once. The mapping is now consolidated to one hand-maintained home (`dependency-map.md`), but the durable fix
  per "never hand-maintain a table someone else could generate" is to GENERATE the mapping from the two
  registries at doc-build/check time. Forward track.

- **End-to-end remediate-run smoke exercising the tool-owned gate (from the 2026-07-12 dogfood).** The
  node:test-gate bug ([[remediate-gate-nodetest-runner-bug]], fixed v0.32.61) blocked EVERY remediate run
  yet no gate/release check caught it: the gate command only runs in a live remediate *run*, and the unit
  test asserted the broken shape as correct. Add a smoke that drives a tiny real remediation to at least one
  phase-boundary/final gate against the actual repo tree (or a fixture repo with vitest tests) so a
  tool-owned gate that can't pass on a clean tree fails the release, not a dogfood run. Sibling of the
  packaged-bin smokes but for the *gate execution path*, not just `--version`.

- **Free/cheap "quota-arbitrage" dispatch tier — extra SOURCE POOLS on existing
  machinery, not a new provider engine.** Fan dispatch across genuinely-free backends and (Phase 1)
  N captured subscription-OAuth accounts, rotating on 429/cooldown to exceed any single subscription's
  limit. The rotation engine is already ours: pool identity is `(provider, account[, model])`, the
  admission loop (`admitBatch` cost-first + spill) IS the rotation, `ReservationLedger` does per-key
  backoff, and Claude/Codex/Copilot accounts get live per-account quota free via `BaseHttpQuotaSource`.
  Worker shape ≈ `OpenAiCompatibleProvider` (thin `buildHeaders`/`buildUrl` subclass) except Kiro
  (AWS EventStream) + Cursor (protobuf). **Acquire and normalize:** use a vetted, externally maintained
  provider OAuth catalogue, token-refresh endpoints/client ids, and text-error classes rather than
  owning those volatile tables. Continue using models.dev for price data.
  ⚠ **This entry previously declared Phase 1 "RULED OUT, not deferred" on ToS grounds; that ruling was
  REVERSED by operator directive 2026-07-23** (the 2026-07-14 "don't cross it" decision was removed as a misinterpretation —
  [[repair-proxy-registry-and-codex-tos]]). Subscription-OAuth replay — read the CLI's on-disk creds,
  replay against the vendor's own model API (Codex → Responses, Gemini → Cloud Code Assist) — is IN, on
  the operator's own accounts at his own risk, and must stay **opt-in, per-provider, operator-consented,
  never default-on**. So the multi-account credential store + refresh-under-lock (encrypted,
  rotation-loss-safe, generalizing `ClaudeOAuthQuotaSource`) is live work again, and so is its named
  risk: long-lived refresh tokens at rest — never logged, atomic rotation under lock (recall the
  Antigravity OAuth-fragment leak).
  **The next move is an owner scoping decision, not code.** The directive's "run agents via the Claude
  harness" has two readings the design memory keeps distinct: (A) point a harness's `ANTHROPIC_BASE_URL`
  at a failover proxy so the Claude loop is served by whichever backend has quota — deployment/config,
  fastest; (B) build the arbitrage tier into audit/remediate dispatch so the loops themselves fan across
  captured accounts — the phased build. They compose but are different work; confirm which, and the
  target harness (Desktop vs Code), before building.
  **Property to hold:** free capacity is saturated before any metered pool, and every credential-capture
  lane is per-provider opt-in, operator-consented, and never default-on. Design of record + phases in
  [[arbitrage-dispatch-tier-design]]. Relates [[quota-dispatch-vision]] /
  [[dispatch-admission-control-design]] / [[cross-provider-quota-matrix]] /
  [[openai-compatible-provider]] / [[model-provider-ide-agnostic]].
  - **Phase-0 opencode-free — env-bound live validation remaining.** opencode-free ships as a pure-config
    source entry (`cost_per_mtok: 0`; see `examples/catalog/sources-declared.json`). It is declared
    machine-level in `~/.audit-code/sources-declared.json`, NOT the repo session-config, which cannot
    represent it — G2 put `sources`/`provider` in `DISPATCH_INVENTORY_FIELDS`, stripped from the persisted
    `RepoSessionIntent` (`src/shared/types/sessionConfig.ts`). Its key must be an `api_key_env`
    (`OPENCODE_ZEN_API_KEY=public`); the inline `api_key` field is RETIRED — a config carrying one is
    refused at validation (`src/shared/validation/sessionConfig.ts`). Declared-free demotion is wired: a pool
    declared `0` that reports a positive cost is demoted out of free-first for the run and fires a
    `declared_cost_drift` friction event (`src/shared/friction/stepBoundaryCapture.ts`).
    **vertex-trial → deferred** (needs the operator's GCP $300-trial SA JSON). **Remaining = live
    validation only** (no more code): a real opencode-free run confirming declared-free routing, a live
    lapsed-free demotion, and the `declared_cost_drift` event end-to-end.
  ⚠ **OWNER DECISION 2026-07-25 — reading (B): build the arbitrage tier INTO audit/remediate dispatch.**
  The scoping question is settled: (A) (pointing a harness's `ANTHROPIC_BASE_URL` at a failover proxy) is
  deployment config that rescues the HOST loop, while (B) adds captured-account source pools so the
  existing admission loop rotates across them, rescuing DISPATCHED work. The owner chose (B) with (A)
  not adopted. So the multi-account credential store + refresh-under-lock is live work, under the
  standing constraint that every capture lane stays per-provider opt-in, operator-consented and never
  default-on.

- **models.dev static window can over-state a specific deployment (carried from W1).** With no capability
  handshake and no `quota.models` override, `resolveLimits` falls to the vendored snapshot
  (`src/shared/quota/limits.ts` rung 2.5 → `source: "static_metadata"`, confidence `medium`), and the snapshot
  keys models by each provider's OWN id spelling — spellings that disagree: `claude-opus-4-7` resolves to
  1M context / 128k output while `claude-opus-4.7` is 200k and `anthropic/claude-opus-4.7` is 409k (same for
  `claude-opus-4-8` = 200k vs `claude-opus-4-8@default` = 1M). A headless host that reports the bare id but
  serves the 200k deployment therefore sizes packets off a ~5× window. The guards that actually hold are
  (a) discovered capability and explicit `quota.models` both outranking the static rung (`limits.ts`, pinned in
  `tests/shared/model-statics.test.ts`), and (b) the per-pool fit gates — `context_cap_tokens`
  (`resolveSourceContextWindowTokens`, `src/shared/quota/apiPool.ts`), the packer clamp in
  `deriveOverridePackerBudget`, and the `oversized_packet` warning in `src/audit/cli/dispatch/packetFilter.ts`
  (which fires at `medium` confidence — it suppresses only at `low`). `BLOCK_SAFETY_MARGIN` is NOT a guard
  here: the audit packet budget is raw `context − output` (`quotaPool.ts` `probeBudget`), and the 0.7 margin's
  only consumers (`resolveContextBudget` in remediate `plan.ts` / `repair/brokeredDispatch.ts`) never read the
  static rung — 0.7 × (1M − 128k) = 610k would not bound a 200k endpoint in any case.
  **Property to hold:** a run that cannot discover its window never sizes above what the endpoint actually
  serves. **⬇ Live-run watch** on a real headless metered run: does the static rung ever fire with a window
  wider than the served deployment (truncation / 413), or does discovery always land first? If it fires, the
  fix is a deliberate conservative pick at the static rung (`limits.ts`), not a wider margin.

- **Schema-enforced generation — CE-004 residual is every prompt-only backend, not just the host.**
  Emit-time constraint exists on `openai-compatible` alone: `discoverOutputConstraintCapability`
  (`src/shared/providers/providerFactory.ts`) returns `json_schema_constrained` there and `none` for
  every other resolved provider — `claude-code`, `codex`, `agy`, `antigravity`, `vscode-task`,
  `subprocess-template`, `worker-command`, `claude-worker` — because each takes a rendered prompt with
  no API-level constraint hook. On those paths CE-004 reduces to the repair floor (`enforceSchemaAtEmit`
  → O3 emit-validate-repair): no emit-time prevention. Backend-blocked, not a defect; it unblocks per
  backend as each gains a constraint endpoint, and the always-on conversation host (`claude-code`) is
  simply the one that can never be routed around.
  - **⬇ Live-run watch** on an openai-compatible run: results conform on first emit (repair rounds for
    schema-shape errors drop to ~0).

- **Tool-enforced dispatch broker with capability-tiered driver.** Desired end-state: (1) a gated
  primitive set as the single dispatch chokepoint (read quota, estimate tokens locally, dispatch/await);
  (2) a capability-tiered driver — Y-dispatcher (thin agent, no judgment) where the host supports nesting,
  slot-pull where it can't; (3) classify agent hosts off the cold-start floor. The single-source
  classifier, broker primitive, `HostSessionQuotaSource`, and driver selection/prompt rendering are
  **shipped**. **Open (env-bound):** live Y-dispatcher validation (needs a nested-agent host + live run)
  + proactive pre-wall quota-aware pacing.
  - **⬇ Live-run watch** (Codex backend, which nests agents): the driver-selection step must pick the
    **Y-dispatcher** path (thin dispatcher agent, no judgment) rather than slot-pull — confirm from the
    run's driver-selection log. Separately, on a metered run, pacing should slow *before* the wall (proactive)
    rather than only reacting after a 429. FAIL = slot-pull chosen on a nesting-capable host, or pacing that
    only ever reacts post-wall.

- **Deterministic analyzers: own-vs-acquire engine.** **Open:** clippy/rubocop landed fixture-only (no
  Rust/Ruby repo → live spawn unvalidated). *(Mutation testing was
  considered and dropped 2026-07-03: it doesn't fit the acquire+scan model — Stryker must run the full
  test suite per mutant and needs a per-repo test-runner config we don't own, so it either no-ops or is
  its own subsystem. Not an analyzer-registry add. Re-file as a scoped forward track only if a lightweight
  mutation signal appears.)* **Forward constraint:** if a future LLM-proposal channel is built for analyzer ids beyond
  the static registry, it must route through the same `admitSpawn` chokepoint; and
  `ExternalAcquisitionConfig.consent_token` must be stripped/redacted before any persistence of
  `SessionConfig` to a shared artifact. [[deterministic-analyzers-own-vs-acquire]]
  - **⬇ Live-run watch** (audit a **Rust** repo for clippy / a **Ruby** repo for rubocop, with the per-run
    consent token so the gate admits the non-default tool): the tool must actually **spawn and normalize**
    output into leads (cargo-clippy / bundle-rubocop), not skip. FAIL = "skipped" status when the ecosystem
    is present + consent given, or a parse that drops all output. (No Rust/Ruby toolchain on the box →
    install `rustup` / `ruby`+`bundler` first, or point at a repo that vendors them.)

- **Cross-provider quota — live-endpoint confirmation.** Per-provider mappings validated against
  live-shaped fixtures; confirming each source against its **real** endpoint (Claude/Codex live; Copilot/
  Antigravity gated→degrade) is environment-bound. Per-provider recipes:
  [`cross-provider-quota-matrix.md`](../../spec/cross-provider-quota-matrix.md). Red line: self-monitoring
  own-provider only, never IDE-GUI automation.
  - **⬇ Live-run watch** (run under each provider whose IDE/CLI you have — Codex CLI is available now):
    the provider's `QuotaSource` must return **live numbers off its real endpoint**, not the fixture/degrade
    fallback — confirm the quota reads are non-empty and move as the run consumes budget. Codex + Claude are
    reachable now; Copilot/Antigravity need those IDEs running. FAIL = a source stuck on degrade when its
    real endpoint is reachable.

- **Remediate's `phase:main` has no merge-time ownership re-check before persist — a correctness gap.**
  Audit's template re-checks that it still owns its claim immediately before persisting, so a claim
  reclaimed mid-step cannot land. Remediate's equivalent wraps its advance in the heartbeat but never
  re-checks — so a step whose claim was reclaimed can still write. Not mechanically mirrorable from the
  audit side: remediate's persists are distributed inside `advance()` rather than funnelled through one
  merge point, so the gate has to go somewhere else or the persists have to be funnelled.
  **Property to hold:** a step that has lost its claim cannot persist, on both draws.
  ⚠ Accepted residual on the shipped half: the probe window is stale-interval-wide, not instantaneous —
  worst case is a stale LAND a beat before an imminent reclaim, never a double-land (base mutations stay
  serialized by the per-node + base-branch locks).

- **Slice-3 — no live heartbeat on the LONG-lived execution claims (doc-review D-66/D-67/C-7; last open slice
  of the rolling-lifecycle unification).** Slices 1-2 are CLOSED: the OD3 layer-2 merge-time ownership gate is
  shipped on BOTH long-lived claim sets — audit at the single ingest chokepoint (`partitionByOwnership`,
  `mergeAndIngestCommand.ts`, fed by the run-scoped `owner-tokens.json` sidecar `dispatch.ts` writes) and
  remediate immediately before the cherry-pick (`acceptNode.ts` `params.ownership` → `registry.heartbeat`,
  threaded from `rollingSession.ts`) — and the "shared pause reducer" was verified not worth building
  ([[rolling-lifecycle-unify-full-unification-wrong]]: `PartialCompletionTerminal` is already the correct shared
  surface; `advancePausedState`/`LIVELOCK_PAUSE_LIMIT` is audit-only by nature and correctly forked).
  Still open is **layer 1 only**: `withClaimHeartbeat` (`src/shared/quota/claimLease.ts`) is wired ONLY to the
  short coordination mutexes — bundle-mutation (`auditStep.ts`, `CLAIM_HEARTBEAT_MS`) and remediate `phase:main`
  (`nextStep.ts`, `PHASE_CLAIM_HEARTBEAT_MS`), both 10s. The execution claims are lease-only: `task-claims.json`
  at `AUDIT_TASK_CLAIM_LEASE_MS` = 20 min, remediate node-claims at the default `STALE_LOCK_MS` = 30s. Cost
  today: a 30s remediate node lease is stale seconds into a multi-minute worker run, so any second driver's
  `claim`/`claimMany` re-grant rotates the token and the original driver's accept-time gate then correctly
  REFUSES to land finished work (quarantine); on the audit side a dead round's claims block re-dispatch for the
  full 20 min unless the in-process driver's `releaseOwnedTaskClaims` sweep ran.
  - ⚠ **Two premises of the earlier version of this entry are FALSE at HEAD — do not build from them.**
    (a) "the merge-time gate exists only inline on the bundle-mutation mutex" — both merge gates are shipped
    (above); `spec/multi-ide-concurrent-runs-design.md` OD3 already carries the corrected picture.
    (b) "the beater is the spawning process, and it already exists" — true ONLY for the in-process drivers
    (`rollingAuditDispatch`, the hybrid coordinator), which hold the event loop for the whole span. On the
    conversation-first HOST path the claiming process is already gone: `cmdPrepareDispatch` prints the plan and
    exits, `prepareHostRollingDispatch` writes `rolling-session.json` and returns, and only then does the host
    run its workers. `withClaimHeartbeat` has nothing to run in there.
  - ⚠ A shared `withExecutionClaim` must NOT fold in `registry.heartbeat(token)` as its gate: audit's gate
    deliberately uses `listLiveClaims()` so an ABSENT-or-STALE claim is not read as peer possession
    (`mergeAndIngestCommand.ts` doc-comment — `heartbeat` collapses "unclaimed" and "held by someone else" into
    one `false`, and both the merge-complete self-heal path and the crashed-peer resurrect path depend on the
    difference). Gate SEMANTICS are legitimately per-draw; only the heartbeat half is shareable.
  - **Owner decision blocking the slice:** what beats a claim on the host path — the host re-heartbeating on each
    `next-step`, a per-node lease sized to the work, or moving the claim from dispatch time to accept time. Until
    that is chosen, wrapping the in-process drivers alone would leave the two paths with different liveness
    semantics on the same registry. FOCUSED-LAP track — the most delicate machinery in the repo
    (pause/claim/quota); "redesign before scheduled autonomy" applies. [[multi-ide-concurrent-runs-design]] /
    [[dispatch-admission-control-design]]
  ⚠ **OWNER DECISION 2026-07-25 — size the per-node lease TO THE WORK, derived deterministically from
  signals the tool ALREADY produces** (per-node token estimate, complexity rating, risk rating). That is
  the decision for both paths, and it deliberately avoids a learned/measured input
  ([[concurrency-is-declared-or-absent-never-learned]]). ⚠ **OWNER DECISION 2026-07-25 (companion move
  SETTLED): the claim STAYS at dispatch time.** Relocating it to accept time reopens the double-dispatch
  window the claim exists to close — the lease must span the out-of-process worker run, which is the same
  property FLW-COR-003 established (`src/audit/cli/dispatch.ts`). Lease SIZING is the whole fix; claim TIMING is
  not in play. Do not re-raise it.

- **Packet `task_ids`/`lens` attribution is missing from the token-usage ledger** (`DispatchPlanEntry` carries neither). Non-blocking follow-up to the context-efficiency access-memory track, whose items 1-3 shipped.

