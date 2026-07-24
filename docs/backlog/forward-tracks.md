# Forward tracks

> Design-level directions and in-flight tracks — not yet bounded defects.
>
> Part of the split backlog — index: [`docs/backlog.md`](../backlog.md).
> A living to-do list, not a status log. Remove an entry once it ships; record durable
> contracts and rationale in project memory or `CLAUDE.md`, never "where the code is today".

## Open tracks


**Track 1 — Deploy + validate proxy swap live (LiteLLM integration + end-to-end confirmation).**
**(a)–(e) all VALIDATED live 2026-07-18** — LiteLLM 1.91.1 on `127.0.0.1:4000` fronting NVIDIA NIM,
9 aliases across tiers; record: [`docs/reviews/litellm-proxy-live-validation-2026-07-18.md`](reviews/litellm-proxy-live-validation-2026-07-18.md).
Config lives at `~/.audit-code/litellm-config.yaml`. One defect found + fixed (proxy lane never
reach-verified its own `api_key_env`). **Still open on this track:** dispatch through the proxy under
a real audit wave (packets validated only to the completion boundary), and quota/rate-limit behavior
at the proxy — both fold into the re-dogfood step this validation unblocks.
Original scope follows. Deployment/configuration work, not audit-tools code changes. Stand up a local LiteLLM proxy (`litellm --config config.yaml`, default port 4000, optional master_key for auth). Configure it with an openai-compatible backend (NVIDIA NIM, vLLM, LM Studio, etc.) and model roster. Point the generic `proxy` block in `~/.audit-code/sources-declared.json` at it: `{endpoint, api_key_env, top_k?, cost_per_mtok?}` (env note: `NVIDIA_API_KEY` and `LLM_BACKEND_BASE_URL` are already set on the box). Then run `/audit-code` and validate the full chain end-to-end: (a) `/v1/models` roster is discovered and merged into Gate-0 confirmed pool, (b) `/model/info` enrichment parses cost + context caps when available (graceful degrades when absent), (c) liveness via `/health/liveliness` (fallback `/v1/models` if missing), (d) auth: master_key threaded correctly + loud drop if `api_key_env` names an unset var, (e) workers receive `--model <alias>` verbatim and dispatch honors the order. Deployment guidance → `examples/`, never as code concept. ⬇ Closes the "swap never run against a live proxy" gap.

**Track 2 — Ranker contract. ⚠ The "design a contract" framing is SUPERSEDED — the contract already
exists and is in use.** The original deliverable was a new machine-level ranks file for audit-tools to
read. That is no longer the right shape: the ranker writes capability ranks into the local proxy's
per-model metadata, and audit-tools already ingests that metadata and rides it to the capability floor.
So the join is done, it needed **zero audit-tools code change**, and adding a separate ranks artifact now
would be a second channel carrying the same fact — the parallel-channel mistake the original entry
explicitly warned against.
**The property held and still holds:** audit-tools stays agnostic — starting, stopping, or swapping the
ranker changes zero audit-tools source, because the tool consumes a general metadata field rather than
anything ranker-specific.
**What is actually open is smaller: the ranker is a hand-run generation step, not a refreshed pipeline.**
Ranks are produced once by hand and then age silently — the same staleness shape as the proxy catalog
cache, and it should be resolved the same way rather than invented separately. Ranking itself remains a
distinct project outside this repo; only its freshness touches audit-tools, and only through the cache
whose read path already needs an age rule.

**Track 3 — Gate-0 operator-confirmed priority order fallback (UX enhancement when no ranks exist).**
Gate-0 ALREADY has the full machinery: operator-submitted `cost_order` persists to `SharedProviderConfirmation.provider_pool[].cost_order` + host/source pools; dispatch reads it back via `readConfirmedCostPositions()` and applies it as rung-1 of costRank. What's MISSING is prompt clarity + fallback when no external ranks exist. (a) Gate-0 should explicitly surface that `cost_order` is the operator's **DISPATCH PRIORITY ORDER** — distinct from `exclude[]`/`include[]` (binary gating). (b) When no ranker has populated prices, Gate-0 should default-suggest an ordering by tier (`frontier > capable > fast > unknown`). (c) Operator can accept, reorder manually, or exclude pools — all decisions persist to shared confirmation. (d) Dispatch routing must be explicit: operator priority order is rung 1 of costRank, below capability floor ∧ available ∧ quota headroom. 
**Both design questions resolved.**
**(i) The suggested order lists EVERY pool.** Restricting the suggestion to the stronger tiers would
reintroduce the exact confusion (a) exists to remove: an order is DISPATCH PRIORITY, not inclusion.
A pool missing from the suggested ordering reads as excluded, so a suggestion that silently omits the
weak tiers teaches the operator the wrong model of what the field means. Weak pools belong at the
bottom of the order, not absent from it — and if the operator wants one gone, exclusion is the separate
control that says so.
**(ii) Operator order is authoritative WITHIN the cost axis; λ decides how much the cost axis weighs.**
These do not conflict and no reconciliation mechanism is owed. The operator's ordering already sits as
the first rung of cost ranking, and λ trades the cost axis against throughput — so a throughput-biased
operating point can legitimately outrank the operator's cost preference, exactly as it outranks price.
What IS owed is that this be stated where the operator sets the order, since "my priority order was not
followed" is otherwise indistinguishable from a bug.

---



## Forward tracks



- **Backend-identity axes — settle transport / service / locus once (design of record: [`spec/backend-identity-axes.md`](../spec/backend-identity-axes.md)).** The Gate-0 bypass (fixed v0.33.11) was one symptom of a naming defect: `provider` names TWO concepts (the adapter that carries a request vs. the vendor that serves the model), `endpoint` holds TWO shapes (URL vs. launcher command), and every downstream keyspace had to independently rediscover which it needed. Quota got it right, the gate got it wrong for months, and a proposed "one identity function" fix would have been fail-OPEN. The spec settles the vocabulary and the axis each question binds to; the invariant is **co-locate and name, do not unify**.
  **Staged migration — each stage atomic + green on its own (atomic-replace ordering invariant):**
  1. ✅ **SHIPPED 2026-07-19. Vocabulary.** `DispatchableSource.provider` → `transport`, `backend_provider` → `service`; normalize `service = declared ?? transport` ONCE at the source-gather chokepoint. Landed as four commits: the service-axis price fix, the 394-ref rename, the `id`-outranks-derivation precedence fix (+ populate-cache de-stamping + `PROXY_CATALOG_VERSION=2`), and a loud validator error for operator files still using the old names. ⚠ **Normalization went in `collectDispatchableSources`, NOT the `gatherDispatchableSources` wrapper** — both are exported, so the wrapper would have left a bypass. ⚠ **Residual:** normalization activates the declared-account fold for a source carrying `account` but no `service`, changing those CapacityPool ids and orphaning their learned `quota-state.json` keys (degrades to blind defaults — not a correctness break, but unmigrated). Record: [`identity-migration-stage1-plan-2026-07-19.md`](reviews/identity-migration-stage1-plan-2026-07-19.md).
     <br>*(original spec, retained for the stages below)* normalize at the `gatherDispatchableSources` chokepoint so it is never optional downstream (this alone kills the declaration-dependent fold fragility, where a direct source omitting `backend_provider` stopped folding with its proxied twin and re-prompted the operator). ~527 refs / 29 files, mechanical — but any site the classification pass flags as reading transport where it MEANS service is a behavior fix and must be split into its own commit, never smuggled into a rename.
  2. ✅ **SHIPPED 2026-07-20. Co-locate the projections.** All four now live in `src/shared/providers/identity.ts`, each documented with the question it answers: `backendIdentity` (gate) / `sourceService` / `quotaPoolKey` (ledger, was `buildProviderModelKey`) / `exclusionPattern` (routing filter; renamed from `transportRoute` in stage 4, itself originally the private `backendExclusionPattern`). Pure move — every call-site argument preserved. ⚠ **Deviation from the spec's literal "same module"**: the target was `providerConfirmation.ts`, but that file imports `dispatch/costRank.ts` → `quota/modelStatics.ts`, so quota importing it would point quota back at providers through dispatch. A LEAF module with zero value imports satisfies the spec's own stated rationale ("the lowest module both consumers can import") without the cycle. ⚠ **A claimed axis divergence here was FALSE and is not a follow-up**: `dispatchableSourceId` (the persisted ledger key) already passes `service` post-stage-1; the transport-passing sites are a documented-unreachable fallback and a throwaway key feeding `resolveAccountIdSafe`, not ledger keys. `apiPool.ts`'s doc comment had said `transport[#account]/…` since before stage 1 and was corrected.
  3. **`Locus` discriminated union** (`{kind:"url"} | {kind:"command"}`); host-tier rules apply only to URLs. Lowest priority of the five — justified BY stage 4, not independently (there is no live parsing bug; `endpointHosts` guards on `//`).
  4. ✅ **SHIPPED 2026-07-20 (`a6adc9b`). Axis-explicit exclusion grammar** (`transport:` / `service:` / `host:`). Retires two defects outright: an unknown axis becomes a PARSE ERROR rather than a silently-inert host rule (the "typo'd rule matches nothing, silently" item), and `service:nim` closes every transport reaching that vendor. Carries a persisted-policy migration — one user, so MIGRATE rather than dual-parse. ⚠ **No `model:` axis** — the spec records it as REFUTED (a model-only rule matches one model string across every service, recombining the identities the gate exists to keep apart); the `url | command` locus union is likewise refuted. Do not re-propose either.
     **Prerequisite ✅ SHIPPED 2026-07-20 (`b220171e`): the capacity guard.** `buildSourcePools` returns `{pools, zeroedByExclusion}` — non-null only when reach EXISTED and the rules removed all of it, so an unconfigured run is not a false alarm — and both seams emit an `exclusion_zeroed_capacity` friction fact naming the culprit patterns. `DispatchExclusion` gained `excludedBy`, with `excludes` DERIVED from it so a zeroing the guard cannot name is unrepresentable. Record: [`capacity-guard-2026-07-20.md`](reviews/capacity-guard-2026-07-20.md).
     ✅ **SHIPPED 2026-07-20 (`a6adc9b`).** `parseExclusionRule` now parses the axis-explicit `transport:`/`service:`/`host:` prefixes (`VALID_EXCLUSION_AXES`); an unrecognized or absent prefix is `{kind: "invalid"}`, not a silent fallback to a host/endpoint rule. `ExcludableBackend` gained a `service?: string` field, and `ruleMatches` evaluates `service`/`service_model` rules against `backend.service ?? backend.transport`. A read-time `migrateExclusionPattern` helper translates persisted pre-stage-4 bare-form patterns to the new grammar (applied in `resolveDispatchExclusion`), so there is no dual parser standing. Landed together with the prerequisite capacity guard above, per the "ship both together" requirement.
  5. **Fail-closed autonomous write emits the `service` axis.** Closes the multi-transport residue durably: a transport snapshot decays the moment proxy expansion adds a route, a service rule does not. Touches `intakeExecutors.ts` → loop-core, attestation required.
  **Property to hold:** a new consumer PICKS an axis from the spec's table; it never invents an identity. ⚠ Do NOT collapse the keyspaces — that instinct is what produced both the bypass and the fail-open proposal.

- **One repo intent, three filenames — the audit/remediate intent split is a `one core, two draws` smell (surfaced by G3 recon 2026-07-16).** Audit's intent is `<root>/.audit-tools/audit/session-config.json` (`src/audit/supervisor/sessionConfig.ts:16` + `auditArtifactsDir`); remediate's is `<root>/.remediation-artifacts/session-config.json ?? <root>/session-config.json` (`src/remediate/steps/sessionConfigLoad.ts:63-67`, called from `nextStep.ts:1779-1783`); a stale guard-message in `claudeCodeProvider.ts:15`/`agyProvider.ts:9` still points operators at a third path, `.audit-tools/remediation/session-config.json`, that nothing reads — the wrapper itself no longer seeds it (`wrapper/remediate-code-wrapper-install-hosts.mjs:665-667` deliberately creates the config empty on demand). They are DISJOINT — audit never writes a file remediate reads as intent — which is precisely why the root-scoped `provider-confirmation.json` exists as the only cross-tool decision channel (`sharedProviderConfirmation.ts:4-9`). Two draws of one concept with three homes and no shared store. Unifying the path is a prerequisite for ever collapsing the Gate-0 artifact into the intent (a G3 draft proposed exactly that and was refuted on this). Too large to ride G3. One more live instance of the split-artifact cost (re-dogfood 2026-07-22): the per-tool `.audit-tools/audit/provider_confirmation.json` (4 legacy providers, no source fields) read as "sources dropped" and cost 20 min of misdiagnosis before the real decision at `.audit-tools/provider-confirmation.json` was checked.
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

- **Free/cheap "quota-arbitrage" dispatch tier (9router-inspired) — extra SOURCE POOLS on existing
  machinery, not a new provider engine.** Fan dispatch across genuinely-free backends and (Phase 1)
  N captured subscription-OAuth accounts, rotating on 429/cooldown to exceed any single subscription's
  limit. The rotation engine is already ours: pool identity is `(provider, account[, model])`, the
  admission loop (`admitBatch` cost-first + spill) IS the rotation, `ReservationLedger` does per-key
  backoff, and Claude/Codex/Copilot accounts get live per-account quota free via `BaseHttpQuotaSource`.
  Worker shape ≈ `OpenAiCompatibleProvider` (thin `buildHeaders`/`buildUrl` subclass) except Kiro
  (AWS EventStream) + Cursor (protobuf). **Reuse (vendor+sync, MIT):** 9router's `PROVIDER_OAUTH`
  catalogue + per-provider token-refresh endpoints/client_ids — the someone-else-maintained table the
  sourcing rule prefers — and its `ERROR_RULES` text classes; a 2026-07-07 coverage diff confirmed its
  price table adds nothing over models.dev, so skip that.
  ⚠ **This entry previously declared Phase 1 "RULED OUT, not deferred" on ToS grounds; that ruling was
  REVERSED by operator directive 2026-07-23** ([[9router-functionality-wanted-tos-reversed]]; the
  2026-07-14 "don't cross it" decision was removed as a misinterpretation —
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
    (`OPENCODE_ZEN_API_KEY=public`); an inline `api_key` is refused by `verifySourceReach` as not
    ambient-verifiable (`src/shared/providers/auditorSources.ts`). Declared-free demotion is wired: a pool
    declared `0` that reports a positive cost is demoted out of free-first for the run and fires a
    `declared_cost_drift` friction event (`src/shared/friction/stepBoundaryCapture.ts`).
    **vertex-trial → deferred** (needs the operator's GCP $300-trial SA JSON). **Remaining = live
    validation only** (no more code): a real opencode-free run confirming declared-free routing, a live
    lapsed-free demotion, and the `declared_cost_drift` event end-to-end.

- **RESOLVED — quality stays a FLOOR, not a tradeable axis. Keep the 1D dial.** The dispatch dial trades
  cost against throughput; capability gates eligibility. Making quality a second tradeable axis was
  considered and is declined, on the shape of the quantity rather than on effort: **capability does not
  degrade smoothly.** A model above the floor produces usable output; one below it does not produce
  cheaper, slightly-worse output — it produces output that fails review and costs a full retry plus the
  wasted first attempt. A tradeable axis presumes a continuum that buys you something at the low end, and
  here the low end has negative value. That is exactly what a floor encodes, so the floor is not a
  simplification of a 2D model, it is the correct shape.
  It would also require a per-task "what is better output worth here" weighting that does not exist, is
  not derivable from anything currently measured, and would land as an operator knob — which the project
  treats as a bug signal.
  **Property to hold:** capability gates eligibility and is never traded away for price or speed.
  Design of record
  [`spec/dispatch-cost-speed-dial.md`](../spec/dispatch-cost-speed-dial.md); extends
  [[cost-first-routing-design]].

- **models.dev static window can over-state a specific deployment (carried from W1).** With no capability
  handshake and no `quota.models` override, `resolveLimits` falls to the vendored snapshot
  (`src/shared/quota/limits.ts` rung 2.5 → `source: "static_metadata"`, confidence `medium`), and the snapshot
  keys models by each provider's OWN id spelling — spellings that disagree: `claude-opus-4-7` resolves to
  1M context / 128k output while `claude-opus-4.7` is 200k and `anthropic/claude-opus-4.7` is 409k (same for
  `claude-opus-4-8` = 200k vs `claude-opus-4-8@default` = 1M). A headless host that reports the bare id but
  serves the 200k deployment therefore sizes packets off a ~5× window. The guards that actually hold are
  (a) discovered capability and explicit `quota.models` both outranking the static rung (`limits.ts`, pinned in
  `tests/shared/model-statics.test.mjs`), and (b) the per-pool fit gates — `context_cap_tokens`
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
  [`cross-provider-quota-matrix.md`](../spec/cross-provider-quota-matrix.md). Red line: self-monitoring
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

- **Context-efficiency access-memory track (items 1-3) shipped; non-blocking follow-up open:** packet `task_ids`/`lens` attribution missing from the token-usage ledger (`DispatchPlanEntry` carries neither).
