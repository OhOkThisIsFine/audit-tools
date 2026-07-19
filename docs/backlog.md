# Backlog — open work, durable traps & future directions

A living **to-do list**, not a status log. Remove an entry once it ships — record durable
contracts/rationale in project memory or `CLAUDE.md`, never "where the code is today."

---

## Live-validation guide — READ FIRST if you're running a live audit/remediate

Most open items below are **code-complete and only await a real run to confirm**. Each such item
carries a **⬇ Live-run watch** line: exactly what to observe during the run to confirm it validated —
or to catch it failing. Pick a run config from this matrix; watch the items it lights up.

| Run config | Items it exercises (watch their ⬇ lines) |
|---|---|
| **Any** live audit, any provider | Selective-deepening convergence · knip `files`/`dependencies` dead-code leads |
| **Metered provider + LARGE target** — this is what exercises the wall (`AUDIT_TOOLS_LIVE_QUOTA=1` only enables the live-credential test probe in `tests/audit/inv2.test.mjs`, it does not force a production wall) | Quota-aware dispatch · M-QUOTA friction escalation · pre-wall pacing · retryable resume |
| **Codex backend** (`--provider codex`; Codex CLI is a nested-agent host) | Y-dispatcher driver selection · cross-provider quota (Codex live endpoint) |
| **openai-compatible / NIM backend** (`RUN_NIM_E2E=1` for the gated e2e) | openai-compatible dispatch pool · CE-004 emit-time-constraint build opportunity |
| **Rust or Ruby target repo** | clippy (cargo) + rubocop (bundle) live spawn |

**General fail-signals to log on ANY live run** (add a line under *Open bugs* if you hit one): a run
that wedges and needs `force-synthesis` to finish · orphaned pending `deepening:*` tasks · a *crash*
(not a graceful pause) when a rate limit is hit · an analyzer that silently skipped when it should have
spawned · knip dead-code leads that never reach the per-file lens. After a run, its findings are the
corpus to hand-label for the A2 oracle (see Deferred / waiting).

---

## Open tracks (2026-07-18 forward) — three parallel: proxy live validation, ranker contract, Gate-0 ordering

**Track 1 — Deploy + validate proxy swap live (LiteLLM integration + end-to-end confirmation).**
**(a)–(e) all VALIDATED live 2026-07-18** — LiteLLM 1.91.1 on `127.0.0.1:4000` fronting NVIDIA NIM,
9 aliases across tiers; record: [`docs/reviews/litellm-proxy-live-validation-2026-07-18.md`](reviews/litellm-proxy-live-validation-2026-07-18.md).
Config lives at `~/.audit-code/litellm-config.yaml`. One defect found + fixed (proxy lane never
reach-verified its own `api_key_env`). **Still open on this track:** dispatch through the proxy under
a real audit wave (packets validated only to the completion boundary), and quota/rate-limit behavior
at the proxy — both fold into the re-dogfood step this validation unblocks.
Original scope follows. Deployment/configuration work, not audit-tools code changes. Stand up a local LiteLLM proxy (`litellm --config config.yaml`, default port 4000, optional master_key for auth). Configure it with an openai-compatible backend (NVIDIA NIM, vLLM, LM Studio, etc.) and model roster. Point the generic `proxy` block in `~/.audit-code/sources-declared.json` at it: `{endpoint, api_key_env, top_k?, cost_per_mtok?}` (env note: `NVIDIA_API_KEY` and `LLM_BACKEND_BASE_URL` are already set on the box). Then run `/audit-code` and validate the full chain end-to-end: (a) `/v1/models` roster is discovered and merged into Gate-0 confirmed pool, (b) `/model/info` enrichment parses cost + context caps when available (graceful degrades when absent), (c) liveness via `/health/liveliness` (fallback `/v1/models` if missing), (d) auth: master_key threaded correctly + loud drop if `api_key_env` names an unset var, (e) workers receive `--model <alias>` verbatim and dispatch honors the order. Deployment guidance → `examples/`, never as code concept. ⬇ Closes the "swap never run against a live proxy" gap.

**Track 2 — Ranker contract (separate project, owner decision on where it lives).**
This is NOT audit-tools code. Owner decision: model ranking is a distinct project/repo outside audit-tools. Deliverable is the CONTRACT first — what shape the ranker PRODUCES and where audit-tools READS it. Natural home: alongside `~/.audit-code/sources-declared.json`, a machine-level file (JSON recommended for symmetry, path + name open) carrying model ranks keyed by pool identity (`backend_provider[#account]/model`), with fields like `rank: number` and optional `tier: string` per model. audit-tools reads it IFF present; zero audit-tools code changes if the ranker doesn't exist or is swapped. Note what audit-tools already CONSUMES today so the contract joins to it rather than inventing parallel channels: `resolveModelPrice()` in `src/shared/dispatch/costRank.ts` (reads `models.dev` catalog), `capability_rank` on `DispatchableSource`, `capabilityScore` in admission loop, and the existing fail-open floor (a model with no rank must stay dispatchable). **Property to hold: audit-tools stays agnostic — swapping, starting, or removing the ranker changes zero audit-tools source code.**

**Track 3 — Gate-0 operator-confirmed priority order fallback (UX enhancement when no ranks exist).**
Gate-0 ALREADY has the full machinery: operator-submitted `cost_order` persists to `SharedProviderConfirmation.provider_pool[].cost_order` + host/source pools; dispatch reads it back via `readConfirmedCostPositions()` and applies it as rung-1 of costRank. What's MISSING is prompt clarity + fallback when no external ranks exist. (a) Gate-0 should explicitly surface that `cost_order` is the operator's **DISPATCH PRIORITY ORDER** — distinct from `exclude[]`/`include[]` (binary gating). (b) When no ranker has populated prices, Gate-0 should default-suggest an ordering by tier (`frontier > capable > fast > unknown`). (c) Operator can accept, reorder manually, or exclude pools — all decisions persist to shared confirmation. (d) Dispatch routing must be explicit: operator priority order is rung 1 of costRank, below capability floor ∧ available ∧ quota headroom. Design questions: (i) does the suggested fallback order include *every* pool or only `capable+` tiers? (ii) how does operator-confirmed order compose with λ (cost-speed bias)? Name as owner calls if genuinely open; don't decide unilaterally.

---

## Open bugs / frictions — fix in tooling (never "host remembers")

- **The TEST TREE IS NOT TYPECHECKED AT ALL — `.ts` tests included (2026-07-19).** `tsconfig.json`
  is `include: ["src"]` and vitest has no `typecheck` configured, so no test file is typechecked.
  This keeps defeating "make the field required so `tsc` enumerates the sites": that guarantee is
  real for production (`CapacityPool.accountKey` correctly enumerated its 2 producers) and worth
  ZERO over fixtures. Concretely, three `.mjs` fixtures built pools without the new required field
  and failed at RUNTIME rather than at compile time, and two more (`tests/audit/inv2.test.mjs`,
  `tests/remediate/inv2.test.ts`) produced `account_key: undefined` through
  `summarizeDispatchCapacityPools` and PASSED because nothing schema-parsed there. This is the same
  class as the scope-less-window fixture problem. **Property to hold:** a fixture that omits a
  required contract field fails loudly — either the test tree is typechecked, or the wire crossing
  schema-validates on every path a fixture can reach.

- **Mixed credential REFERENCES on one real key split the account (2026-07-19).** `deriveAccountKey`
  compares `(endpoint, credential reference)`, so a source declaring
  `api_key_env: "NVIDIA_API_KEY"` and a sibling pasting that same key inline as `api_key` are two
  accounts and each meters its own allowance — a 2× over-admission of the same defect class as the
  main N× bug. Deliberately not fixed by hashing the credential VALUE: that would change the account
  identity on every credential rotation, orphaning ledger state and learned slopes for what is still
  one account. **Property to hold:** two references naming one credential meter as one account,
  without making identity depend on the secret's current value. Narrow today (inline `api_key` is
  documented as discouraged).

- **`INV-shared-core-14` is machine/PATH-dependent, NOT a flake (2026-07-19).** Long characterized in
  handoffs as "pre-existing + env-sensitive". Actual cause, identified by independent review: provider
  auto-resolution picks `agy` because that binary is on this box's PATH, and the test's dependency stub
  has no `createAgyProvider`. Reproduces alone, so it is not a hermeticity/concurrency flake — the test
  is coupled to whatever agent binaries happen to be installed. **Property to hold:** the test pins the
  resolution it means to pin regardless of what is on PATH (inject the roster, or stub every provider
  the resolver can reach).

- **Review rounds re-derive the same file map every time (inefficient-feeding, 2026-07-19).** Step 2
  ran 4 adversarial rounds; each spawned FRESH agents that re-grepped the same `tokens_per_pct` /
  `admit` / `reconcile` call-site map from scratch (~135k subagent tokens per round, much of it
  identical recon). Continuing a prior reviewer preserves its context but forfeits independence,
  which is the whole point of the round — so the two goals are in tension and the fix is not "reuse
  the agent". **Property to hold:** a review round receives the verified call-site map as INPUT
  (cheap, mechanical, produced once) and spends its budget on judgment, not rediscovery — while still
  reaching its own verdict. Candidate: a recon step that emits a map artifact each round refreshes
  rather than rebuilds.

- **Window-scope validation at the PRODUCER boundary — designed for step 2, deferred with reason
  (2026-07-19).** The design of record (Residual 1) says to validate scope once where a snapshot is
  created so consumers are safe by construction, "when step 2 touches this code". Attempted and
  REVERTED: it does not work as a drop-in. Every production caller swallows a throw from
  `probeQuotaSource` into `status: "degraded"` (`apiPool.ts`'s two `.catch`es, plus the
  `queryCurrentUsage` branch's own try), so asserting there converts a contract violation into a
  quiet `quotaSignalDegraded` pool rather than a loud failure — and `compositeQuotaSource` bypasses
  `probeQuotaSource` entirely, so "safe by construction" would be false regardless. **Property to
  hold:** a scope violation from a live producer is distinguishable from a network degrade and
  surfaces loudly — which needs a distinct error class that the degrade catches deliberately
  re-throw, not another assert call. Meanwhile `scheduleWave` still asserts (live path, throws) and
  `quotaSnapshotWindowPctMap` skips-and-warns (persisted path, must not throw).

- **`AdmissionGrant.resource_key` becomes partial under multi-constraint (2026-07-19).** Now that
  `reconcile(leaseId)` sweeps every key, this field has no reader — it is diagnostic provenance. Once
  steps 3–4 supply N constraints it will record one of N while looking authoritative. **Property to
  hold:** the artifact either records every key the lease was taken against, or does not record one
  at all. Documented in place at `admissionLoop.ts`.

- **Account-metering steps 3–4 carry two obligations step 2 could not hold (2026-07-19).** Step 2
  (multi-constraint ledger + `(scope,label)` slope key) landed the mechanism; these two properties
  belong to the callers it enables and are NOT yet pinned anywhere but a test comment:
  (a) **an uncalibrated pool must go through the cold-start probe path, not be waved through.** The
  ledger treats a non-finite budget as unbounded by design (optimistic start; the reactive 429 floor
  corrects), so whether a pool that cannot price a constraint reaches dispatch at all is decided in
  budget derivation (`deriveWindowTokenBudget` → `COLD_START_PROBE_BATCH`) and admission wiring. The
  design of record states this as a standing constraint (§ Standing constraints).
  (b) **account-key DERIVATION must distinguish two credentials on one `backend_provider`**
  (`accountId.ts`). The step-2 ledger test for "two accounts" pins only that two distinct map keys
  don't share a bucket — nearly trivial, and NOT the mechanism at risk. An earlier refused review
  round was about exactly this derivation.

- **`dispatch-quota.json` cannot re-parse its own output when a budget is cold-start
  (2026-07-19, found by independent review during account-metering step 2).** `pool.budget`
  defaults to `+Infinity` at cold start, so `headroom_before: Infinity` reaches the admission
  explain artifact. Zod's `z.number()` accepts `Infinity` in memory, but `JSON.stringify` writes
  `null`, and `admissionLoop.ts`'s `z.number().optional()` inside a `.strict()` object REJECTS
  `null` on read-back. Already on disk:
  `.audit-tools/audit/fanout-quota/design_review/dispatch-quota.json` → `"headroom_before": null`.
  Latent only because no production path re-parses `DispatchQuotaContractSchema` (it is `parse`d at
  emit only). **The test that should catch it cannot:** `tests/shared/admission-loop.test.mjs`
  validates the IN-MEMORY object, never a serialize/parse round-trip, and its `pool()` helper
  defaults `budget = Infinity` — so the one test named for artifact-shape validity asserts the
  schema accepts exactly the value that does not survive the round trip. **Properties to hold:**
  a non-finite headroom serializes to something the schema accepts on read-back (or the schema
  admits it explicitly), and the artifact-shape test asserts a round trip, not an in-memory object.
  Pre-existing; not introduced by the multi-constraint change.

- **`tests/audit/linux-cycle-regression.test.mjs` times out under full-suite parallel load
  (2026-07-19).** Passes alone in ~29s; exceeded its 120s timeout when run as part of `vitest run`
  over the whole suite, then passed alone immediately after. Load-sensitivity, not a regression —
  but it makes a full-suite run non-deterministically red, which is exactly the condition that
  trains a reader to wave at "known flaky" instead of resolving failures to names. **Property to
  hold:** the test's cost does not scale with unrelated suite concurrency (raise its timeout, or
  make it not contend on whatever shared resource slows it).

- **Per-site pinning gate — REAL BUT FAIL-OPEN ONE LEVEL UP; do NOT cite it as evidence yet
  (2026-07-19, was reported SHIPPED, independent review found two soundness holes).**
  `scripts/shared/assert-sites-pinned.mjs <spec.json>` reverts each site of a change individually and
  requires each reversion to turn the named suite red. The 7 sites it checks for
  `account-scoped-metering.json` ARE genuinely checked (independently confirmed, failure counts
  1/3/1/1/1/1/1), and its original fail-open parse bug is genuinely fixed. **Two holes remain:**
  (1) **it measures "the suite went red", not "a test asserting THIS behavior went red"** — renaming the
  `resolvePoolAccountKey` export so importers crash yields `71 failed` and the gate reports
  `PINNED … All 1 site(s) individually pinned`. That is the same fail-open shape the tool exists to
  catch, relocated up a level. (2) **the spec is a hand-written subset with nothing cross-checking it
  against the diff** — 7 declared vs ≥11 substantive hunks, and the two hunks carrying the fix's core
  claim (`capacity.ts:725`, `apiPool.ts:276`) are outside it and survive reversion with `tsc` clean and
  the suite byte-identical. "All 7 sites pinned" is literally true and materially misleading. A related
  tell: three dead imports exist only to make the gate's `replace` text compile, i.e. reversions were
  authored to fit the tool rather than derived from pre-fix code. **Properties to hold:** each spec site
  binds to the NAME(s) of the test(s) expected to fail, and the spec is DERIVED from the diff so an
  omitted hunk is impossible. Until both hold, a passing run is not admissible as attestation evidence
  (see the attestation-gate entries below). ⚠ Needs `npm run build` first (imports the compiled shim
  resolver from `dist/`).

- **⚠ Two concurrent `vitest run` invocations corrupt each other's results (2026-07-19, medium,
  friction: inefficient-feeding).** Running a targeted suite while a full-suite run was still going in
  the background produced 61 failures across 6 files in areas the diff never touched
  (`inferRepairTarget`, `archiveContractArtifact`); both areas passed cleanly on a serial re-run, twice.
  The tests share on-disk fixture dirs under `tests/remediate/.test-*`, so concurrent runs race. This
  cost a full stash-and-baseline cycle to attribute, and would read as a damning regression to anyone
  who did not re-run serially. **Property to hold:** either test fixture dirs are per-invocation
  (`AUDIT_CODE_STATE_DIR`-style, per [[state-dir-env-override-hermeticity]]) or a second concurrent
  vitest refuses to start. Same family as the other three known full-suite-only failures.

- **N models on ONE account are metered as N INDEPENDENT budgets — ROUND 2 REFUSED 3/3 (2026-07-19),
  owner call open (loop-core, `e500672f` on `wip/capability-evidence`, NOT on main).** Three independent
  lenses each refused sign-off. **Blocking owner call:** the lease key is account-scoped while the budget
  operand stayed pool-scoped, which starves an account's lowest-budget pool (executed: budgets 1000/200,
  20 packets → 10 granted all on the big pool, small pool 0) and drops the ceiling entirely when any
  sibling is uncalibrated. Not a partial fix — a new bug. Either budget goes account-scoped (needs an
  account-level `tokens_per_pct`) or the lease key returns to pool scope. Also: the motivating case is
  STILL unfixed for the inline `api_key` shape (third round running); the `concurrency_cap` revert's
  conclusion is a non-sequitur (enforcement keys on `poolId`, so 2 models × `max_concurrent: 2` on one
  endpoint admit 4); and the pinning gate is not yet admissible evidence (see its own entry). Full
  record:
  [`docs/reviews/account-metering-round2-independent-review-2026-07-19.md`](reviews/account-metering-round2-independent-review-2026-07-19.md).
  Round 2 addresses all
  eight defects: the account key is now resolved ONCE at `CapacityPool` construction (`accountKey`) and
  carried on the wire as a required `DispatchCapacityPoolSummary.account_key` that every consumer READS
  — one partition by construction, and the only way the host path (which never sees a `source`) can key
  an explicitly-`id`'d source correctly. The over-merge is fixed by checking `backend_provider` FIRST:
  a transport-fronted endpoint never becomes the identity. The per-account in-flight-cap change was
  REVERTED — `concurrency_cap` is documented as a per-ENDPOINT limit, which settles three defects at
  once and narrows the fix honestly to the BUDGET and COOLDOWN axes. All seven changed sites are now
  individually red-green validated (round 1 had two unpinned, including the one the record most
  emphasized). **The durable lessons stand regardless of whether round 2 passes:** (1) three of five
  sites were verified and the result GENERALIZED to "each fix" — verify every site, never extrapolate;
  (2) the round-1 test asserted a helper the metering path never calls, which reads as coverage and is
  not ([[verify-delegated-findings-mechanism-not-just-citation]]); (3) a required field did not break
  any test call site at compile time because the test tree is untypechecked — the runtime failure was
  the only signal (see the untypechecked-tests entry below). The attempt
  introduced `accountKeyFromPoolKey` + `resolvePoolAccountKey` and rerouted budget, in-flight cap and
  the cooldown fold. An independent adversarial review refused sign-off on eight defects — the two that
  matter most: **(a)** deleting the `provider !== "openai-compatible"` guard made rung 1 key on the
  TRANSPORT, so every backend behind one proxy collapses into a single cooldown account (a free-lane
  429 stalls a paid lane) — an over-merge WORSE than the original bug, and directly against
  `dispatchableSourceId`'s "the transport NEVER enters the quota identity"; **(b)** the motivating case
  is still unfixed — an explicitly-`id`'d source has no `/` in its pool id, so budget and cap remain
  per-model for exactly the `nim-nano`/`nim-super`-on-one-key scenario `accountId.ts:13-18` cites.
  Full list + sign-off conditions:
  [`docs/reviews/nim-dispatch-single-pool-2026-07-19.md`](reviews/nim-dispatch-single-pool-2026-07-19.md).
  **Two durable lessons, both about how a green tree lied:** (1) three of five changed sites were
  red-green validated and the result was GENERALIZED to "each fix" — the most-emphasized site was in
  fact unpinned, and reverting it kept every test green. Verify each site, never extrapolate from a
  sample. (2) the new test *looked* like it covered the motivating case but asserted a helper **the
  metering path never calls** — a test can assert a true statement about a function that is not on the
  path under test, which reads as coverage and is not
  ([[verify-delegated-findings-mechanism-not-just-citation]]).
  Original defect statement follows.

  **N models on ONE account are metered as N INDEPENDENT budgets (2026-07-19, HIGH, loop-core,
  observed configuring the NIM lane).** Expanding a proxy backend into K models yields K
  `CapacityPool`s with K token budgets, K in-flight caps and K independent 429 cooldowns — against
  one credential with one real rate limit. Admits ~K× the true ceiling; backoff learned on one model
  never throttles its siblings. Evidence: pool identity `(provider, account, model)` puts `model` in
  the *budget* key (`apiPool.ts:37-57` → `scheduler.ts:802-809`); quota state/ceilings/caps key off it
  (`apiPool.ts:425,428`, `state.ts:576`, `admissionLoop.ts:613,668-669,689`); 429 cooldown is
  per-model (`rollingDispatch.ts:1061,1087` → `state.ts:567`); and `admissionLoop.ts:227` assigns
  `resourceKey` — documented at :51-52 as "the metered account the lease keys to" — verbatim from the
  per-model `pool_id`. The account fold that exists for exactly this bug (`accountId.ts:8-10` cites the
  NIM incident) never fires here: `accountId.ts:39` gates it to `provider === "openai-compatible"` and
  proxy sources are `claude-worker` (`proxyCatalog.ts:342`); and even ungated it is contractually
  scoped to the cooldown axis alone, never budget (`accountId.ts:55-57`).
  **Property to hold:** pools sharing one credential share ONE budget, ONE in-flight cap and ONE
  cooldown; the model axis may subdivide *routing*, never *metering*. **Currently mitigated only in
  config** (`proxy.top_k: 1`) — latent for any `top_k > 1` or any operator declaring several models on
  one key. Fixing `accountId.ts:39` alone is NOT sufficient (propagates cooldown, leaves budget split)
  — this is the [[fix-the-defect-class-not-the-named-instance]] shape.
  Record: [`docs/reviews/nim-dispatch-single-pool-2026-07-19.md`](reviews/nim-dispatch-single-pool-2026-07-19.md).

- **Model selection within one budget is FREE-vs-METERED, not one rule (2026-07-19, owner ruling,
  RESOLVED — no code change needed).** Refines the first draft of this entry, which said "single pool ⇒
  always best model" unconditionally. The owner's actual rule: **free pool ⇒ always the best model at
  every complexity level** (no tradeoff exists — capability is the only axis); **metered pool (e.g. a
  Codex subscription) ⇒ the CHEAPEST model that clears the capability floor.** Both already fall out of
  `costFirstCmp` (`admissionLoop.ts:527`), `costRank ↑ || capabilityRank ↓ || capabilityScore ↑`: a free
  pool's costs all tie so capability decides, and a metered pool sorts on price with the floor gating
  eligibility. **Verified by reading the comparator, not assumed.** The rule was previously inert only
  because no capability ranks existed to break the tie — which the ranker now supplies. Residual: the
  operator still expresses "collapse this shared-budget roster to its best member" by hand as
  `proxy.top_k: 1`; nothing derives it.

- **A stale proxy catalog cache is served silently, and an absent one deletes the lane (2026-07-19,
  medium, friction: tool-should-decide).** `resolveAmbientSources` returned a `catalog-cache.json`
  whose `fetched_at` was a day old, with a roster that no longer matched the running proxy — no
  freshness check, no warning. Deleting the cache then dropped the whole proxy lane, and the
  operator-facing reason names an internal FUNCTION (`populateProxyCatalog`) rather than any runnable
  command — there is no CLI to populate it. **Property to hold:** the resolve path either revalidates
  the cache against the live roster or states its age; and every drop reason names an action the
  operator can actually take. Same family as the `dropped[]`-not-surfaced entry below.

- **`top_k` truncates ALPHABETICALLY when nothing is ranked, silently dropping the frontier tier
  (2026-07-19, medium, now mitigable).** With all `score` undefined, `expandSources`
  (`proxyCatalog.ts:327-335`) falls through to `a.alias.localeCompare(b.alias)` — so `top_k: 3` over
  the NIM roster kept a *flash* model and dropped every frontier one. Mechanism (3) of the
  unranked+free composition entry, now observed directly. **Mitigated** now that
  `model_info.capability_rank` is populated (see below), but the fallback remains
  silently-wrong-by-default for any unranked proxy. **Property to hold:** truncating a roster with no
  ranking signal must be loud, not alphabetical.

- **Durable trap — LiteLLM will not start on Windows with redirected stdout (2026-07-19).** Its
  startup banner crashes with `UnicodeEncodeError: 'charmap' codec can't encode characters` (cp1252)
  before the server binds; exit code 3, no proxy, and the traceback buries the cause under ~40 lines
  of FastAPI lifespan frames. Launch with `PYTHONIOENCODING=utf-8` (`PYTHONUTF8=1` also fine).
  Recorded in the generated config's header comment.

- **Anchored insertion makes RE-RANKING an already-ranked model unexpressible at roster
  scale (2026-07-18, medium, known limitation of the BL-1 fix).** `mergeCapabilityOrder`
  (`src/shared/providers/sharedProviderConfirmation.ts`) treats EVERY submitted id already
  present in `priorOrder` as a fixed anchor and seeds `positions` from `priorPos`, so a
  mentioned-but-previously-ranked model keeps its old position no matter where the operator
  puts it. The one escape — a TOTAL submission restating every prior model — is unreachable
  once the roster is large, which is exactly the regime anchored insertion exists for.
  Net: the operator can ADD new models anywhere, but can never say "that model I ranked
  highly is actually worse than I thought." That is the likeliest follow-up action, since the
  point of operator ranking is that judgment improves with use.
  **Not a livelock** — the merge converges and the delta empties; this is an expressiveness
  gap, deliberately accepted to close a critical livelock, not an oversight.
  **Property to hold:** an operator must be able to reposition a previously-ranked model
  without restating the entire roster. **Likely fix:** distinguish a TOOL-OFFERED anchor
  (from `selectCapabilityAnchors`, genuinely a fixed reference point) from any OTHER
  previously-ranked model the operator chose to mention — the latter should be repositioned
  by the same interpolation new models get. That makes demotion/promotion expressible while
  keeping anchors stable, and needs no new field. Predicted in advance by the round-4 review
  ("merge-always makes removal and reordering unexpressible"); recorded here so the
  prediction is not lost if the fix is deferred.

- **A DEADLINE should drive λ, not become another dial (2026-07-18, medium, forward track,
  needs live data first).** The measurement half of this shipped — the speed axis now ranks on
  `min(concurrency-derived, rate-derived)` (`deriveSustainedThroughput`) and spill consults
  remaining rate budget (`deriveRateCap`, cooldown ⇒ zero) so it fires BEFORE the 429 rather
  than after. What is still open is the sub-question that fix deliberately deferred: "finish
  within an hour" is a CONSTRAINT rather than a preference, so it belongs as something that
  drives λ from observed progress, **not as another operator knob** (a needed manual flag is a
  bug signal — λ, "how much will I pay to finish sooner", is already the right tradeoff).
  **Do not build it until a real wave under the shipped rate-aware routing shows the shape** —
  the whole reason it was held back is that the right control law is not derivable from a
  guess. Adjacent, same family: [[quota-before-cost-ordering]] (Gate-0 suggests cost order on
  $/Mtok alone, never demoting a quota-saturated pool).

- **`ci.yml`'s path filter makes DOC-gate violations dormant until an unrelated `src/` change
  (2026-07-19, medium, friction: tool-should-decide).** `ci.yml` triggers only on
  `src/** tests/** schemas/** dispatch/**`, but `verify:checks` includes `check:doc-manifest`, which
  guards `docs/`. So a docs-only push can introduce a doc-manifest violation that CI never runs — and
  it then detonates on the next unrelated `src/` commit, which gets blamed for it. Hit this lap: two
  review docs landed in a docs-only commit, stayed dormant, and turned `ci.yml` red on a quota commit
  that had nothing to do with them (plus two older strays that had been dormant longer). **Property to
  hold:** the trigger paths for a gate must cover every path that gate inspects. **FIXED same lap** —
  `docs/**` added to both the `push` and `pull_request` filters in `.github/workflows/ci.yml`, so a
  docs-only push now runs the gate that guards docs.
  Corollary already known and re-proved: local `build + check + vitest` does NOT include
  `verify:checks`, so a lap can be "green" while CI is red ([[lap-green-must-match-ci-evidence]]).

- **Durable trap — `codex exec "<prompt>"` HANGS when stdin is a non-TTY pipe (2026-07-19).** With a
  prompt passed as an argument, Codex still reads stdin to append as a `<stdin>` block; under any
  harness that leaves stdin open (background tasks, CI, most spawn wrappers) it blocks forever on
  "Reading additional input from stdin…" and is killed by the timeout with **exit 0 and empty output**.
  Silent: it looks exactly like a model that returned nothing, and it cost two dispatches here before
  being diagnosed. **Always `codex exec … </dev/null`** (or pass the prompt ON stdin instead of as an
  argument). Same class as the Windows `npx.cmd` shim trap — an offload lane that fails silently reads
  as a capability gap in the backend rather than a wiring bug on our side. If a dispatch worker ever
  spawns `codex`, its stdin must be explicitly closed at the spawn site.

- **The loop-core attestation gate cannot tell a human reviewer from the committing agent
  (2026-07-19, medium, friction: tool-should-decide).** `attest-loop-core-review.mjs` takes
  `--reviewed-by <id>` as a free string and the pre-commit gate checks only that a fresh,
  staged-tree-bound attestation EXISTS. On this lap the committing agent ran the attestation
  itself (naming its three independent reviewer subagents in the string) — which is honest,
  but the gate would equally have accepted `--reviewed-by me` with no review at all. CLAUDE.md
  describes the intent as "a logged, attributable **human** step"; the mechanism does not
  enforce the human part, so the doc currently overstates what is guaranteed. **Property to
  hold:** either the gate distinguishes agent-attested from human-attested (and the two carry
  different weight), or the docs stop claiming a human step and describe it as what it is — an
  attributable, tree-bound audit record. Per *enforce-in-tooling-never-host-discretion*, the
  first is preferable; the second is at minimum required for the claim to be true.

- **The loop-core gate conflates COMMITTING with LANDING, so preserving WIP forces an override
  (2026-07-19, medium, friction: tool-should-decide).** Committing review-blocked loop-core work to a
  do-not-merge branch — the correct way to preserve it across a branch switch — is gated identically to
  landing it on main. The honest verdict for un-reviewed work is `concerns`, and the pre-commit gate
  REFUSES `concerns` without `--override`. So the only paths are: claim `clear` (a false sign-off),
  override (what this lap did, on `e500672f`), or leave the work uncommitted and risk losing it. The
  override reason is recorded, so the audit trail survives — but a gate whose honest path requires an
  override will train the override into a habit, and then it stops signalling anything. **Property to
  hold:** the gate keys on the DESTINATION, not the act of committing — a commit that cannot reach main
  (branch not `main`, or the tree is marked do-not-merge) should accept a `concerns` attestation without
  an override, while a commit onto `main` keeps the current strictness. Same family as the
  agent-vs-human entry above: both are the gate measuring the wrong thing.

- **A large `Edit` into a `.test.mjs` can break brace balance and only surface as a vite parse
  error (2026-07-19, low, friction: inefficient-feeding).** Rewriting a `test()` body whose
  replacement spanned the closing `});` left the enclosing `test()` unclosed; `npm run check`
  is blind to it (tests are outside `tsconfig`, see the entry below) so the first signal was
  vitest failing to transform the whole FILE — which reports as one opaque "Failed Suites"
  entry naming no test, and masks every real assertion in the file until fixed. Same root as
  the untypechecked-tests entry below; noted separately because the SYMPTOM is what costs the
  time (a suite-level parse failure reads as a harness problem, not an editing slip).

- **The test tree is NOT typechecked, so a required-field contract change is not enforced
  there (2026-07-18, medium, friction: tool-should-decide).** `tsconfig.json` is
  `include: ["src"]` and vitest transpiles via esbuild without typechecking, so
  `npm run check` never sees `tests/**`. Hit while making
  `ScheduleWaveInput.capabilityRanks` required to close a fail-open: the compiler
  correctly caught the production call sites, but every test call site silently kept
  getting `undefined`. **Property to hold:** if a field is made required *because
  omission is a defect*, omission must be a compile error everywhere the field is
  passed — or the enforcement claim must be scoped in writing. A green suite currently
  reads as "every call site swept" when it cannot be. Options: a `tsconfig.test.json`
  wired into `verify:checks`, or `vitest --typecheck`.

- **`llm read` (the free NIM lane) is unusable for review-shaped prompts
  (2026-07-18, medium, friction: inefficient-feeding).** Two failures in one lap on
  `nvidia/nemotron-3-ultra-550b-a55b`: a ~13KB diff timed out past 120s, and a ~5KB
  function returned `Backend JSON did not match read schema` even after the built-in
  stricter-format retry. The lane works for summarization/extraction but not for
  "find defects in this diff, report file:line" — the schema is `{summary, findings[],
  open_questions[]}` and the backend drifts off it under an analytical prompt.
  **Property to hold:** the free lane either satisfies its own advertised schema or
  fails with a signal the caller can route on — a schema-mismatch die means the whole
  offload is wasted with nothing salvaged. Consider a size guard + a partial-parse
  salvage path. Until then: delegate review work to Haiku/Sonnet subagents, not `llm read`.

- **Capability-evidence obligation: implemented + green but REVIEW-BLOCKED, on branch
  `wip/capability-evidence` (2026-07-18, high, blocks the ▶ IMMEDIATE NEXT).** Two adversarial review
  rounds; round 2 REFUSED sign-off. Full record + the six open issues:
  [`docs/reviews/capability-evidence-implementation-review-2026-07-18.md`](reviews/capability-evidence-implementation-review-2026-07-18.md).
  Properties that must hold before this lands:
  (1) the capability floor must band on real evidence on BOTH draws — remediate's `scheduleWave` path
  (`marshal.ts`) currently still fails open, the exact defect the change exists to fix;
  (2) a promotion must never DESTROY a persisted operator decision — today the autonomous/headless
  branch wipes `host_model_cost_order` entirely, and a capability-only submission reverts the confirmed
  `cost_order`;
  (3) a host that writes the prompt's JSON verbatim must produce a file the parser ACCEPTS — the
  capability fragment omits `schema_version`, so following the prompt literally re-creates the
  infinite-re-prompt livelock one layer up, and the canonical shape block never lists `capability_order`;
  (4) explicit removal must stay representable — an empty `host_models` is currently indistinguishable
  from omission, so the carry-forward resurrects a roster the operator deleted.
  ⚠ The generalizable lesson (worth reading before the fix lap): every round-2 issue except the prompt
  one is a SIBLING of a round-1 defect on a branch the round-1 fix did not sweep. Fixing the named
  instance is not fixing the defect class — especially for a fail-open mechanism, where an unwired site
  is indistinguishable from a working one.

- **`resolveUnevidencedCapabilityPools` is untestable where it lives (2026-07-18, medium, friction:
  tool-should-decide).** It is module-private in `src/audit/cli/nextStepCommand.ts`, so the
  model-less-pool skip — the property that prevents an unpinnable pool from wedging `PRIORITY[0]`
  forever — has no test, and the one test that claims to cover convergence is tautological. Property:
  a delta-computation function whose failure mode is a livelock must be reachable by a test. Likely
  the function belongs in shared beside the other confirmation readers rather than in a CLI command.

- **Unranked + free compose badly: hard packets structurally prefer the least-known models
  (2026-07-18, medium-high, from the LiteLLM live-validation lap).** Retiring repair-proxy also retired
  the only source of automated capability data (it collected arena rankings + agentic/tool-use
  benchmarks). audit-tools has no automated capability signal today — only operator-declared
  `capability_rank` and the static provider-name tier switch (`providerConfirmation.ts:62-80`);
  models.dev supplies price + context only (`ModelStatics` has no quality field). Live-observed: the
  proxy-expanded `claude-worker:*` sources carry NO `capability_rank`. Unranked hits the fail-open branch
  (`admissionLoop.ts:307,324-333`) → eligible for EVERY floor incl. `deep`; `cost_per_mtok: 0` → ranked
  first under cost-first. **Property to hold:** a pool with no capability evidence must not be
  preferentially selected for the packets that most need capability. Each half is a deliberate decision
  (fail-open = 2026-07-17 owner call; the models really are free) — it's the COMPOSITION that regressed.
  NOT yet observed in a real wave — mechanism verified by reading, prediction unconfirmed; the
  re-dogfood is the test. **Note the seam already exists:** `proxyCatalog.ts:159` ingests
  `capability_rank` from `/model/info` and `:352` rides it to the floor, and LiteLLM permits arbitrary
  `model_info` keys — so a ranker can feed this today with zero audit-tools code change. That reduces
  Track 2 from "design the contract" to "decide what produces the numbers" (owner call).
  **Source survey DONE 2026-07-18** → [`docs/model-capability-ranking-sources.md`](model-capability-ranking-sources.md).
  Leading shape: OpenRouter `/api/v1/models` carries `benchmarks.artificial_analysis.agentic_index`
  (verified live: 9/9 of the NIM roster covered, joined by exact `id` else `hugging_face_id` — no fuzzy
  matching), fetched at RUNTIME by the ranker and written into LiteLLM `model_info`, which
  `proxyCatalog.ts:159` already ingests. **Nobody redistributes anything** — it becomes the operator's own
  local proxy config — which sidesteps the one hard blocker (the scores are Artificial Analysis data;
  AA's free tier forbids redistribution, so the models.dev vendoring pattern does NOT transfer).
  Two implementation traps: (1) **sign convention is inverted** — `proxyCatalog.ts:350` documents
  `capability_rank` as LOWER = better, `agentic_index` is HIGHER = better; getting this backwards
  silently inverts routing, so it needs a test; (2) `agentic_index` is undocumented in OpenRouter's
  schema and present on only 104/344 models → must degrade cleanly to the fail-open path on absence.
  Epoch AI (CC-BY, updated daily) is the vendorable fallback layer if a legally-clean local snapshot is
  wanted. Still an owner call: which layers to build, and whether to fix the unranked+free composition
  independently of any ranker ever landing.
  **PLAN WRITTEN + ADVERSARIALLY REVIEWED 2026-07-18** →
  [`docs/reviews/capability-evidence-obligation-plan-2026-07-18.md`](reviews/capability-evidence-obligation-plan-2026-07-18.md)
  (v2; the review refuted three v1 claims — read v2, not a summary). Owner decisions taken: fix the
  composition BEFORE re-dogfooding; no-capability-evidence must be PINNED DOWN (LLM judgment or operator
  ask), never silently routed around; ranker via OpenRouter. **UNBLOCKED 2026-07-18 — implement it.** The scope question is withdrawn: because the gate
  FORCES pinning, there is no unranked pool at dispatch time, and with all pools scored
  `FLOOR_MAX_BAND.standard = 1` excludes the bottom tercile from `standard` as well as `deep` — a weak
  pool drops to `small` work by ELIGIBILITY, no ordering change needed. **Deferred residue:** banding is
  RELATIVE (`band <= Math.max(FLOOR_MAX_BAND[tier], bestAvailableBand)`), so if every pool is weak,
  `deep` still routes to the least-weak one. Forcing rankings guarantees the ordering, not that anyone
  is good enough — whether an ABSOLUTE floor is wanted needs live data from a ranked run first.
  **RANKER PRODUCER NOW EXISTS (2026-07-19), zero audit-tools code change** — the predicted pattern was
  built and validated live: NIM `/v1/models` (119 models) joined to OpenRouter `agentic_index`
  (21 covered, exact `id` else `hugging_face_id`) → written into LiteLLM `model_info.capability_rank`
  → ingested at `proxyCatalog.ts:159`, sign inverted at `:564`. **The documented sign trap is already
  handled correctly in HEAD** — verified live, the populate now selects `glm-5.2` (rank 1) rather than
  the alphabetical head. Nothing is redistributed (scores land in the operator's own proxy config), so
  the AA licensing blocker is sidestepped. Still open: the ranker is a hand-run generation step, not a
  refreshed pipeline. Record:
  [`docs/reviews/nim-dispatch-single-pool-2026-07-19.md`](reviews/nim-dispatch-single-pool-2026-07-19.md).
  **The symptom had THREE mechanisms:** (1) unranked ⇒ fail-open ⇒ `deep`
  eligible [the plan]; (2) `cost_per_mtok: 0` sorts first among eligible [by design; largely obviated once every pool is ranked];
  (3) `top_k` truncates alphabetically [resolved by the ranker, nothing to sort by today].
- **Are `dropped[]` reasons actually SURFACED to the operator at Gate-0? (2026-07-18, medium,
  from the LiteLLM live-validation lap.)** The whole declared-reach design leans on "never silently
  discarded — every drop carries an operator-facing reason", and the reasons are good. But this lap
  hit the retired-`repair_proxy` rejection and an unset-key drop, and in both cases the *operator-visible*
  symptom was simply "the proxy lane isn't there" — the reason was only observable by calling
  `resolveAmbientSources()` directly. **Property to hold:** every `dropped[]` entry reaches the operator
  in the Gate-0 render, not just the return value. NOT yet traced — verify the Gate-0 rendering path
  before designing a fix; the reasons may already be displayed and this may be a non-issue.
  [[write-only-data-looks-authoritative]] (a reason nobody renders is write-only).

- **H2+H4 collapse residual pins (2026-07-18, low, from review h2c3).** (a) The attended same-agent
  SPLIT semantics (blessed in the plan record: engine partition + host-subagent remainder on one meter,
  replacing HEAD's whole-frontier monopoly) is pinned only at pool-composition level — add a
  decision-point-level test asserting where the frontier is actually driven; fold the DC-4
  settled-pool `poolsOverride` filter into the same harness. (b) The env-DETECTED same-agent path
  (`CODEX_THREAD_ID` → `resolveConversationHostProvider` → dedup) lost its end-to-end pin when
  `demote-same-agent-guard.test.mjs` died; the new D1 tests use explicit `host_provider` only.
- **The vitest false-green defect has recurred at least 6 times (2026-07-16 through 2026-07-18) — `vitest run` exits 0 while reporting N failed.** Caught only by reading the summary line, never the exit code. Both standing fixes remain unbuilt: (1) the local gate must fail-nonzero on ANY reported failure count; (2) the vitest timing ledger must record pass/fail outcome + failed file names, not just cost (`vitest-timing-reporter.mjs`).
- **A delegated implementer embedded a RAW 0x00 byte in source (H2+H4 lap 2026-07-18, tool-should-decide, low-medium).** A subagent writing `rollingDispatch.ts` used a literal NUL character as a template-literal dedup-key separator — tsc compiles it happily, but the file turns BINARY to grep/Grep/rg (silently zero search results — a wiring-pass grep returned "no matches" on code that existed, initially reading as unwired enforcement). Fixed by replacing with the `backslash-u0000` escape. Property to hold: a post-write guard (hook or check) rejects raw control bytes (< 0x20 except \t\n\r) in source files; same family as the CRLF-rewrite trap. Cheap mitigation until then: when a grep over a just-edited file returns nothing or "binary file matches", scan for control bytes before concluding anything.
- **Non-hermetic test: `tests/audit/quota-command.test.mjs` "nothing is written to disk" reads the box's real `.audit-tools/audit/session-config.json` (2026-07-18, low).** A leftover gitignored local artifact makes the test fail on a clean checkout of main; it presents as a regression from whatever diff is in flight. Property: the test must resolve repo-root state through the `AUDIT_CODE_STATE_DIR` hermeticity override like its neighbours, never the real repo path. Same box-dependence family as `INV-shared-core-14`.
- **Pre-existing back-compat fold survives, now against standing policy (2026-07-18, low).** `src/shared/quota/apiPool.ts` (~370-371, ~497-498) and `src/shared/types/sessionConfig.ts` (~700-701) fold in a "legacy `openai_compatible` block ... for back-compat". Deliberately kept OUT of the swap commit to preserve the atomic replace. Property: under the owner's no-legacy rule this fold should be deleted and the block treated as a plain source declaration.

> **Friction-walk entry template:** one line per friction — a bold title + the `[[memory-tag]]` for the
> durable lesson + only the still-OPEN tool sliver(s). No shipped-work narrative or changelog prose (that
> lives in git log / memory). Condense at write time, not in a later doc-review pass. The `[[memory-tag]]`
> appears only where a durable memory concept was actually captured for that item — by design, not every
> entry has one.
- **Friction walk (unified-routing lap, 2026-07-17):** (1) **ambiguous-direction (HIGH — nearly built on a dead premise):** HANDOFF's "▶ step 2 Agent-tool carrier test" and the same-day host-fanout design doc pointed at a build whose central claim the run's own artifacts refuted; two same-day records disagreed and only an in-process repro + artifact read resolved it. Durable lesson homed in [[unified-dispatch-routing-direction]]: a same-day, owner-attended diagnosis/design doc's premise is still a LEAD — reproduce the central claim before building. (2) **tool-should-decide (medium):** python text-mode file rewrites on Windows CRLF-ified LF sources, which silently flipped a source-grep guard (`cli-args-utils` "found 3" — comment-stripper regex vs CRLF) that HEAD passed; cost a stash/pop diagnosis. Durable trap: after any scripted rewrite, verify line endings (`open(..., newline='
')` on write) — same family as the release CRLF trap. (3) **inefficient-feeding (medium, recurrence):** a background full-area vitest run piped through `grep` clipped the failure NAMES (the ledger outcome gap's 4th billing, entry above) forcing a full re-run; and an adversarial reviewer observed the working tree MUTATING mid-review (parent kept editing while a tree-scoped review ran) — it stash/popped defensively and flagged a transient phantom type error. Process rule: freeze edits on files under active review, or hand the reviewer a pinned diff.
- **Friction walk (H2+H4 collapse lap, 2026-07-18):** (1) **ambiguous-direction (medium):** my own plan doc asserted "the host-vs-source dedup already exists" from a docblock's phrasing — the adversarial plan review refuted it against the writers (dedup was source-vs-source only, the new rule was new code); and the reviewer's own proposed fix for the display filter was itself a gate-that-never-fires (relative floor can't refuse every pool) — caught only by re-deriving at implementation time. Both are the standing lesson: every causal claim, including a REVIEWER's fix, gets verified against source before building. [[gate-must-be-traced-not-designed]] (2) **tool-should-decide (low):** the pre-commit loop-core gate evaluates a CHAINED `attest && commit` command before the inner attest has run, so the legitimate one-shot form is blocked — attest must be its own Bash call first; either the hook could ignore commits preceded by an attest in the same chain, or document the split as the required shape. (3) **inefficient-feeding (medium, recurrences):** NIM `llm read` lane 503-saturated ("Worker local total request limit 163/32") after ONE call in its session — recon fell back to targeted greps; and a delegated implementer died mid-task on the Claude session limit, with its partial recon unrecoverable (clean tree, redone in-context). Both argue for the standing pattern: main context implements from subagent recon it can verify, not the reverse.
- **Friction walk (proxy-swap lap, 2026-07-18):** (1) **ambiguous-direction (medium, 4 instances in one lap):** four delegated-agent claims with accurate file:line citations dissolved when the surrounding MECHANISM was traced — a "shipping-blocking" quota defect refuted by a `handlesProvider` gate two lines above the cited line; a "paradoxical asymmetry" in cost blend that was per-provider top-K truncation in the test fixture, not the blend; a "real regression" that was a leftover gitignored artifact; and an implementer self-reporting "zero repair_proxy references in src/" while 19 remained across 6 files. Property/lesson: cited line numbers make an interpretation look verified — the parent must trace the gate/caller around the citation, and must run its OWN completeness grep after any delegated sweep. [[gate-must-be-traced-not-designed]] [[grep-the-writers-before-believing-inheritance]] (2) **tool-should-decide (low, FIXED this lap):** the dev wrapper's `.audit-code-build.lock` in the repo root left the worktree dirty and tripped the release clean-tree guard; now gitignored (`bc6ca9cd`). (3) **inefficient-feeding (medium):** two delegated agents died mid-task on session/credit limits, losing partial work (one left no partial output at all); and heavy audit tests timed out en masse (22 across 9 files) purely from parallel-agent load on the box, costing an is-it-mine investigation that CI's green sharded run settled. Lesson: local full-suite results are unreliable while many agents run concurrently — CI is the arbiter.
- **Remediate hybrid frontier still sizes with a FLAT per-node estimate (step-G remediate half, medium).** `HYBRID_NODE_TOKEN_ESTIMATE` (`src/remediate/steps/nextStep.ts:1441`) makes the claim-time fit gate blind for implement nodes (audit's half fixed 2026-07-17 with real `token_estimate`s). Property: derive per-node estimates from the node's `affected_files` sizes (`estimateTokensFromBytes`) so a chronically-413ing (node,pool) pair is pre-skipped, not re-claimed each cycle.
- **A same-day design doc's premise, unverified against the run's artifacts, nearly drove a whole wrong build (unified-routing lap 2026-07-17, ambiguous-direction, HIGH).** `host-fanout-proxy-dispatch-design-2026-07-17.md` diagnosed "conversation-first resolves source pools but never folds them into the wave → build a `proxy_transport` trigger," and the owner + I scoped 4 build decisions on it. The run's OWN artifacts refuted it: `buildAuditSourcePools` returns 3 pools (in-process repro), `hybrid-settled-pools.json` = exactly those 3 (collectively settled), the fit gate was silently no-op'd by a `null` `contextCapTokens`. The design doc had even misidentified the gate (named the headless branch `nextStepHelpers.ts:1757`; conversation-first fires the hybrid `:1875`). Property: before building on a design/diagnosis doc — even a same-day, owner-attended one — reproduce its central claim against the run's artifacts / an in-process repro; a doc's causal story is a LEAD, its ✅/decisions decay. Cost avoided: an entire `proxy_transport` build that fixes nothing. Full record: `docs/reviews/host-fanout-premise-refuted-2026-07-17.md`; direction in `docs/reviews/unified-dispatch-routing-design-2026-07-17.md`. [[external-audit-catalogs-are-leads]] [[grep-the-writers-before-believing-inheritance]] [[gate-must-be-traced-not-designed]]
- **A recon agent's "should work / is missing" story about a live-run defect is a LEAD — the run's own artifacts are the writers-grep (gap-fix lap 2026-07-17, ambiguous-direction, medium).** The backlog framed gap (b) as "the agentic path has no classification equivalent"; two recon agents then produced a plausible "classifier exists and fires" trace. Both wrong: the classifier existed AND was wired but was short-circuited by the not-accepted early return — found only by reading the RUN'S artifacts (119 worker stdouts: all failure text on stdout, none on stderr; quota-state ledger: entries touched in-window with streak 0). Property: diagnosing a live-run defect starts from the run's evidence files, not from code-reading; a ledger showing "recorded but not as X" refutes a code-trace saying "X fires". [[grep-the-writers-before-believing-inheritance]] [[external-audit-catalogs-are-leads]]
- **Loop-core delegation needs a parent WIRING pass — two Haiku implementers shipped defined-but-unwired / wrong-layer mechanisms (gap-fix lap 2026-07-17, inefficient-feeding, low-medium).** (a) Engine hooks (`onModelUnavailable`/`onPacketTooLarge`) were declared + handled in the engine but wired at NEITHER draw site nor the two pass-through layers — friction capture would never fire (the gate-that-never-fires class; caught by grepping the hook names outside shared/). (b) The partition fit gate was implemented as post-claim relabeling — an assignment claimed to source pool X pushed into the host partition with `poolId` still X (claim/accounting on the wrong pool; caught by reading the claim walk). Property: after any delegated multi-layer change, the parent greps the NEW symbol names across src/ and traces one end-to-end call path before accepting; adversarial review alone caught only one of the two. Also self-inflicted: two implementers raced edits on `rollingDispatch.ts` — sequence same-file units. [[delegate-adversarial-phases-to-separate-agent]] [[gate-must-be-traced-not-designed]]
- **Every step prompt's trailing "Then run: … next-step" makes any DELEGATED step executor a second driver (claude-worker dogfood 2026-07-16, tool-should-decide, medium).** A Haiku subagent handed one bounded step (charter_extraction) with an explicit "do NOT run next-step" instruction obeyed the step prompt's own embedded advance command instead and drove the workflow forward — the parent lost the step boundary. This generalizes the existing "design-review worker prompts FOLLOW-UP" entry from one branch to EVERY step prompt: the advance command belongs to the DRIVER, not the step executor, and prompt text cannot enforce that split (host/worker discretion). Property to hold: a step prompt handed to a non-driving executor must not carry the advance command — e.g. emit it only in the step JSON (driver-facing), not in the worker-facing prompt md, or gate next-step on the driving agent-id. **Recurrence 2026-07-17 (design-review re-dogfood):** a `systemic_challenge` adversary subagent, handed its step-prompt path to follow, executed the prompt's embedded `next-step` and advanced the loop from round 7→8 — even convergence-loop worker prompts carry the advance command, so this is not branch-specific. Mitigation used the rest of the lap: the dispatch message explicitly overrides ("do NOT run next-step; the parent owns advancement"), which held — but that is host-discretion, exactly what the property says to remove. [[enforce-robustness-in-tooling-not-host-discretion]] [[delegate-adversarial-phases-to-separate-agent]]
- **The `charter_delta` step defaults its miner to the same host that merged `charter_extraction` — no mechanical author/critic split (2026-07-17 re-dogfood, tool-should-decide, medium).** `charter_extraction` instructs the host to author via blind subagents AND merge/trim their output into the submission; the very next `charter_delta` step then hands that same host the job of mining deltas over the charter set it just curated — the "independent delta-miner" is independent of the blind authors but NOT of the merger, so the host grades homework it helped assemble. Prompt text alone cannot enforce the split (host discretion; caught this lap only because the owner flagged it — I had started mining in-context before re-dispatching to a fresh agent reading `charter_register.json` cold). Property to hold: the delta-miner must be a mechanically distinct agent from whoever assembled the charters — e.g. the step dispatches the miner itself, or binds next-step acceptance to a delta submission authored under a different agent-id than the extraction merge. Same family as the executor-second-driver entry above. [[delegate-adversarial-phases-to-separate-agent]] [[enforce-robustness-in-tooling-not-host-discretion]]
- **Nested-delegation results deliver to the top driver, not the delegating agent (claude-worker dogfood 2026-07-16, inefficient-feeding, low).** A Haiku step-executor spawned three blind charter children and ended its turn "waiting for their completion notifications" — but the children's task-notifications delivered to the MAIN session, so the parent never saw its own children's results and the driver had to relay all three back via SendMessage (an extra round-trip + full result bodies through main context). When delegating a step whose executor will itself fan out, either forbid nested spawn ("do the work yourself" — used for all later steps this lap, works) or expect to relay. Harness behavior, not an audit-tools defect; noted so the delegation pattern defaults to flat fan-out driven by the session that owns the notifications.
- **Self-audit dogfood loop: fixing the tool mid-run invalidates the run (claude-worker dogfood 2026-07-16, ambiguous-direction, low-medium).** The dispatch-blocking defect was found BY the run, and committing its fix changed the audited tree → staleness cascade correctly marked the whole planning chain stale → the 313-packet run regressed to charter_extraction, so every LLM planning step re-runs before dispatch is reattempted. Semantics are right (DAG is truth); the cost is structural to dogfooding-by-self-audit. Two tool slivers worth considering: (a) the resume emitted ~30 identical `{"kind":"staleness",...}` lines in one invocation (recompute spin — dedupe the log line per drain); (b) an active run whose frontier goes stale could say so explicitly ("run X invalidated by upstream staleness: <artifacts>") instead of silently re-planning from charter_extraction with run_id null.
- **A stale prior-run shared confirmation suppresses the proxy populate trigger while Gate-0 still pends (claude-worker dogfood 2026-07-16, tool-should-decide, medium).** The 3c populate trigger (`nextStepCommand.ts:381`) keys on `readSharedProviderConfirmation(root) === null`, but the Gate-0 obligation keys on the per-tool seam — so a leftover `.audit-tools/provider-confirmation.json` from an ABANDONED prior run (yesterday's dogfood) silently skipped populate on a fresh run whose Gate-0 was still being emitted, and the lane dropped as "cache absent". Same split-artifact class as the reconciliation-gate entry below. Property to hold: the populate trigger and the Gate-0 obligation must key on the same confirmation artifact (or a fresh run must not inherit an abandoned run's confirmation). Diagnosis cost: the populate's `.catch(() => null)` is silent AND the skip-branch prints nothing, so "cache absent" pointed at the wrong half.
- **INV-shared-core-14 fails on a box with `agy`/`gemini` on PATH — `deps.createAgyProvider is not a function` on clean HEAD (2026-07-17, tool-should-decide, low).** The state-dir hermeticity override (AUDIT_CODE_STATE_DIR, shipped 2026-07-17) closed the `~/.audit-code` leak class, but this test's auto-resolution still reads the BOX's real PATH: with an agy/gemini binary installed, `createFreshSessionProvider` resolves the agy branch and the test's injected deps lack `createAgyProvider`. Same box-dependence class, different vector (PATH probe, not state dir). Property to hold: the test must pin `commandExists` (and any env the resolver reads) so its resolution path is box-independent.
- **claude-worker lane feedback-gap residuals (gaps (a)/(b)/(c) SHIPPED 2026-07-17 — plan `docs/reviews/claude-worker-feedback-gaps-plan-2026-07-17.md`; these are the accepted leftovers, each low).** (i) **CLI-internal retry hammering:** a worker retries 429s inside its own lifetime before dying (dogfood: 307 proxy-side vs 29 surfaced) — invisible to the parent; the terminal classification → cooldown now paces ACROSS workers, not within one. If the re-run still saturates free tiers, the follow-up is consuming declared `quota.max_concurrent` into a per-pool concurrency default for free tiers. (ii) **`AGENTIC_WORKER_HARNESS_OVERHEAD_TOKENS = 15_000` is an estimate** (single-sourced in `src/shared/quota/capacity.ts`) — measure against real `claude -p` request sizes when live data exists. (iii) **Registry context-window stamp coverage unknown:** populate stamps `quota.context_tokens` only when the proxy registry carries a context field — verify the live registry actually exposes one (else groq-class pools stay cap-less until declared by hand). ⬇ Live-run watch (resume `20260717T062404401Z_audit_tasks_completed_001`): 413s → `packet_too_large` re-queue (not raw error), 429s → `cooldown_until` set on the pool entry, kimi-k2.6 dropped at populate with a `dropped[]` reason, `hybrid_dispatch_node_never_fits` / `rolling_dispatch_stranded_no_fitting_pool` lines only when genuinely unplaceable. [[external-audit-catalogs-are-leads]]
- **claude-worker lane residuals from the 3c adversarial review (2026-07-16, each low-medium, deferred deliberately).** (a) **Account axis:** the populate cache stamps no `account` and the `repair_proxy` declaration has no hook to add one — an operator declaring `account` on a direct lane only splits `nim#X/m` vs `nim/m` into two pools to one backend, reopening the double-grant boundary for that model (declared-wins dedup covers the same-model case; the split needs a per-backend account map on the declaration). Also inconsistent: `buildSourcePool` probes the quota-source account with the TRANSPORT key while the pool keys on the backend — benign only while no quota source handles `claude-worker`. (b) **No TTL / no refresh command:** `catalog-cache.json` is accepted arbitrarily stale (audit re-populates only while a repo has no shared confirmation; `populateProxyCatalogIfMissing` is missing-only), and the "explicit refresh" the plan names does not exist. Cross-repo: the cache is machine-global but audit's trigger is per-repo-confirmation-keyed, so starting repo B rewrites the expansion repo A resolves mid-run (additions gate-caught; removals silent-by-design). (c) **Intra-declaration duplicates:** `collectDispatchableSources` never dedups within `sources[]`, so an operator hand-declaring two sources with one backend identity still produces two same-id pools with map-clobber transport arbitration (the ambient path now dedups declared-vs-expanded; the operator-error case remains). Property to hold: one pool identity ⇒ exactly one launchable source, everywhere.
- **Sharpened consequence of the model-keyed delta collapse (3c review F10, pre-existing class at new scale, low-medium).** `reachNow.set` last-wins per `model_id ?? provider` key, so a colliding direct+proxied pair yields ONE delta entry naming ONE lane's provider — autonomous fail-closed excludes that pattern and the OTHER lane routes unconfirmed. Registry expansion now manufactures colliding pairs at scale (bounded by declared-wins dedup + top-K). Fix requires `backendGateKey`/`confirmedBackendKeys`/exclusion-grammar to move together (provider-qualified keys) or PRIORITY[0] livelocks — the existing "delta collapses two providers" entry below is the same root.
- **The vitest timing ledger records no pass/fail outcome, so a clipped console capture is unrecoverable (2026-07-16, tool-should-decide, low).** `.audit-tools-profile/vitest-latest.json` carries timing only (`fileCount`/`slowest`/…); twice in one session a full-suite run's summary was lost to a `| tail` clip and the ledger could not answer "did it pass, which files failed" — forcing a 4-minute rerun. Property to hold: the standing profile of a test run must record its OUTCOME (pass/fail counts + failed file names), not just its cost. One field in `vitest-timing-reporter.mjs`.
- **A doc-lint hook rewrites prose between Read and Edit, so exact-match edits fail on text the agent never wrote (2026-07-16, inefficient-feeding, low).** Mid-lap an `Edit` on `docs/backlog.md` failed with "String to replace not found" on a paragraph I had authored minutes earlier — a hook had normalized `vs` → `vs.` in it. The Edit tool's own hint ("tried swapping \uXXXX escapes") points at encoding, not at a hook rewrite, so the natural next move is re-reading the whole file to hunt an invisible character. Cost a re-read + a retry. Property to hold: a hook that rewrites a file the agent is mid-edit on should announce the rewrite (or the tool should re-anchor), rather than presenting as a mysterious mismatch. Cheap mitigation until then: after a "not found" on text you just wrote, suspect a normalizer and `grep` the anchor before re-reading the file.
- **Release gate: add `check:doc-manifest` to the pre-commit hook (open remainder, medium).** The durable lesson — a lap cannot report green on evidence weaker than what CI runs; end a lap by checking CI on `main` (the per-workflow runs endpoint is the reliable one), and run `npm run verify:release` before any "this is shippable" claim — is homed in `docs/HANDOFF.md` → "Release gate — the durable lesson" + [[lap-green-must-match-ci-evidence]]. Sole open action: `.claude/hooks/pre-commit-gate.mjs` gates `npm run check` (always) plus `test:doc-contract` and loop-core attestation (each conditionally, when staged files touch the relevant paths) — but never `check:doc-manifest`, so consider adding it (~2s, and it is the check that fired on EVERY push). [[enforce-robustness-in-tooling-not-host-discretion]] **Billed once, 2026-07-18** (a new dated plan doc committed fine locally and blocked `verify:release` afterwards).
- **Neither new test guards the WIRING — only the mechanism and the loader (2026-07-16, low).** `tests/remediate/session-config-load.test.ts` red-greens `loadRemediateSessionConfig`, and every remediate site routes through it today, but a FUTURE call site that inlines `resolveSessionConfig(intent, null)` instead of using the loader fails no test (verified by experiment: reverting a call site to `null` left both files green). Same for audit's two ambient sites. The loader makes the right thing the easy thing; it does not make the wrong thing impossible. Property to hold: a production caller cannot resolve a session config without a descriptor — e.g. make the descriptor a required parameter and give the two legitimate "resolve no pool" callers an explicit `noPoolDescriptor()`, so `null` stops being the path of least resistance.
- **A post-worker LANDING stage is misfiled as dispatch — 3,470 of 5,326 lines under `src/remediate/steps/dispatch/` (owner question 2026-07-16, medium).** worktree / accept / writeScope / verifyCommands are not dispatch: `executeNodeInWorktree` (`acceptNode.ts:749`) is called by the **driver** (`nextStep.ts:1190`), NOT by `prepareImplementDispatch`, which ends at `marshal.ts:427` having written plan + quota and never touching a worktree. They live under `dispatch/` only because the barrel (`dispatch.ts:49-134`) aggregated them; `acceptNode.ts:332` even takes a base-branch lock — pure serialization, zero dispatch content. Symmetrically on the audit side, `prepareDispatchArtifacts` both *decides* and *renders the prompt* (anchor extraction reads source files, `packetPrompt.ts:123-161`; lens defs `dispatch.ts:231-232`; knip indices `dispatch.ts:443-458`). **Property to hold: dispatch is three stages — select/pack, size/admit, launch/land — and the name covers only the middle. Each stage is separately nameable and testable.** Re-home; do NOT bundle into the assembly-unification lap.
- **`withinRoot` — a root-containment SECURITY guard — is reimplemented 5× (owner question 2026-07-16, medium).** `dispatch/paths.ts:10`, `openAiCompatibleProvider.ts:763`, `extractors/graph.ts:520`, `analyzers/typescript.ts:122`, partially `worktreeLifecycle.ts:91`. Five copies of a containment check = five chances for one to be subtly wrong, and a security guard is exactly the class where that matters. Single-source it.
- **Two dispatch entry points disagree on fail-closed and on driver identity (owner question 2026-07-16, medium).** (a) `prepareDispatchCommand.ts:17-23` and `quotaCommand.ts:25` swallow an invalid session-config to `{}` ("using defaults") while `dispatch.ts:219-230` documents fail-closed as the invariant *precisely because* a permissive default builds dispatch against an attacker-influenced config. (b) `prepareDispatchCommand.ts:28` uses `resolveFreshSessionProviderName` where the host path (`semanticReviewStep.ts:117`) uses `resolveHostDispatchProviderName` — the exact founding-bug shape the latter exists to prevent (`provider: codex` would key the pool to codex, not the conversation host). Property to hold: every dispatch entry point carries the same guards, or there is only one entry point.
- **Dead code: `src/audit/quota/headerExtraction.ts` + `headerExtractors/` have zero production consumers (owner question 2026-07-16, low).** Only the `index.ts` re-export + `tests/audit/header-extraction.test.mjs` reference them — the tested-but-unwired class that default-mode knip cannot catch. Delete symbol + orphaned tests per the periodic manual-audit recipe. [[knip-deadcode-gate-default-mode]]
- **G4 reduces to ONE narrow bug: `block_quota.host_model` is auditor IDENTITY persisted in the repo, and it outranks the descriptor (found G4 premise-check 2026-07-16, corrected same-day during implementation, medium).** `resolveHostModel` (`limits.ts:56-71`) resolves `explicit ?? block_quota.host_model ?? env`; `hostPool.ts:156` then does `quotaModelKeySegment = hostModel ?? input.hostModelId` — so the repo's `block_quota.host_model` beats the descriptor's `self.model_id` and **auditor B keys its quota to auditor A's model**. Violates [[capability-is-per-auditor-not-per-audit]]. **⚠ The rest of the original claim is REFUTED: nothing writes `quota`/`block_quota`** — they are operator-authored, and `packetFilter.ts:259` documents `quota.models` as the operator's override mechanism. So `quota.models[<model>]` is keyed BY MODEL NAME (same window for every auditor) → inheriting it is CORRECT, and `limits.ts:115` beating discovery is the intended escape hatch, **not a bug — do not "fix" it** (it only misfires because `hostModel` was mis-resolved upstream; fix the identity and it's right). `quota.default_context_tokens`/`reserved_output_tokens` and `block_quota.context_tokens`/`reserved_output_tokens` (`plan.ts:47-51`) are policy → stay on intent. **Fix = move `block_quota.host_model` → `self.model_id` only**; narrow the `RepoSessionIntent` HALF-type note (`src/shared/types/sessionConfig.ts:772-779`) accordingly. Also stale: G4's "may fold into G2" — G2 shipped and did not fold it. Separately real (and still open): `resolveSessionConfig.ts:86-116` maps none of the `self.*` capability fields; they reach dispatch hand-threaded through three audit CLI commands (`nextStepCommand.ts:130-133`, `prepareDispatchCommand.ts:43-48`, `quotaCommand.ts:38`) — a parallel channel bypassing the one seam. **⚠ Correcting this entry's own earlier claim that the channel "MUST collapse in the same commit as any shared-assembly lift": that premise did NOT apply and the 2026-07-16 lift shipped without it.** The constraint assumed shared assembly would take the DESCRIPTOR and read the resolved config; `buildHostPoolPreamble` instead takes already-resolved scalars (`providerName` / `explicitHostModel` / `hostModelId` / `hostContextTokens` / …), so the channel now hand-threads into ONE function rather than two — strictly better, and not a correctness coupling. The collapse remains worth doing on its own merits (one seam, not two channels), but it does not gate the lift. **Also note the lift moved the `hostModel ?? hostModelId` precedence INTO shared (`hostPool.ts`), so if G4 IS a bug its blast radius is now both draws — which is an argument for settling the owner call, not for reverting.** Detail: `docs/reviews/g4-g5-g6-premise-check-2026-07-16.md`.
- **Durable: a recon agent's causal story is a LEAD; grep the WRITERS before believing an inheritance bug (2026-07-16, ambiguous-direction, medium).** Twice in one session a subagent's confident finding was half-wrong in a way only a writer-grep caught: (a) *"auditor A writes `quota.models`"* — nothing writes it; it's operator config, so the "inheritance" framing collapsed and the proposed `limits.ts:115` fix would have BROKEN the documented escape hatch; (b) the G6 remediate-pool loss was reported as a pre-existing gap when it is an un-released regression. Both survived a plausible-sounding evidence table with real file:line refs. **The precedence facts were right; the causal interpretation was wrong** — and file:line citations make an interpretation look verified. Property: before accepting "X is inherited/stale/authoritative", grep who WRITES X; a field nothing writes cannot carry a stale value between actors. Generalizes [[write-only-data-looks-authoritative]] to its mirror — read-only data can't be inherited either. [[external-audit-catalogs-are-leads]]
- **G5's premise is 2/3 DEAD — narrow the spec before laying it out (found G4 premise-check 2026-07-16, low).** (a) `declared ∩ ambient-verifiable` SHIPPED as G2.5 (`resolveAmbientSources`). (b) The **auditor-id stamp is dead as specced** — `auditor_id`/`resolved_at` are parsed (`args.ts:348-349`) and read at exactly ONE site (`prompts.ts:61-62`) purely as an is-non-empty test: a write-only field ([[write-only-data-looks-authoritative]]). G2.5 established each IDE spawns its own process → own env → nothing shared to contaminate, and the spec's own Honest-residuals says the `(provider, account)` ledger — not auditor identity — is the load-bearing double-grant boundary. Before building a stamp, name the transient cross-auditor-shared run-state and re-derive whether an id is the fix. (c) Only the **lies-reachably quarantine** survives (`auditorSources.ts:147-148`); it is the sole catcher for G2.5's inline-`api_key` refusal. **G5 ≈ clause (c) alone.**
- **A ROTATING set of heavy suite tests fails only under parallel load — hermeticity, not regression (re-measured G3 A′ lap 2026-07-16, tool-should-decide, low-medium).** `tests/audit/linux-cycle-regression.test.mjs` fails in a full `vitest run` but passes alone (35s), and a **third failure rotates** between runs — observed as `tests/remediate/wave-scheduler.test.ts`, `tests/audit/next-step.test.mjs`, `tests/shared/quota-state.test.mjs` (all heavy, all pass alone). **Measured baseline: clean `main` fails the SAME 2 + 1 rotating** (`linux-cycle-regression` + `INV-shared-core-14` + one mover), so a branch showing this is at parity, not regressing. Also timed `linux-cycle-regression` mine-vs-main: 35s both. Per the test-failure protocol these are test bugs (timeout under worker contention / shared quota-state dirs), not code regressions. **The real cost is the is-it-mine investigation** — every dispatch-touching lap pays a full-suite baseline run on stashed main (~2×260s) to prove parity. Property to hold: a green branch must be distinguishable from a flaky one WITHOUT re-running the suite on main. Fix the hermeticity/timeouts, or quarantine the known-flaky set into a separate serial shard. (Distinct from `INV-shared-core-14`, which fails deterministically on main too — noted in `docs/HANDOFF.md` as pre-existing + env-sensitive.)
- **`rtk` cannot resolve `npm` — every `rtk npm run <script>` dies "program not found" (G3 A′ lap 2026-07-16, inefficient-feeding, low).** `rtk npm run check` fails identically from the Bash tool AND PowerShell, so the token-saving wrapper is unusable for the single most-run command class in this repo (`build` / `check` / `test` / `check:deadcode`) — every verify falls back to raw `npm`, forfeiting the 70-90% filtering on exactly the noisiest output. Presumably `rtk` resolves `npm` as an exe rather than through the Windows shim (`npm.cmd`), i.e. the same class as `resolveWindowsShimSpawnCommand`. One-line note now: any lap doing verification pays full-noise output.
- **A test-name substring silently corrupted a flakiness measurement (G3 A′ lap 2026-07-16, ambiguous-direction, low).** Checking suite stability with `$out -match 'failed'` reported the file flaky on 2 of 3 runs — it was matching the string **"fail-closed" in my own test names**, not a result. Same for `(\d+) passed`, which caught "Test Files 1 passed" before "Tests 12 passed". Cost a detour re-investigating a non-existent flake. **Durable rule: read vitest's EXIT CODE, never grep its prose** — the prose contains arbitrary author-chosen test names by construction, so any keyword match over it is unsound. [[log-all-friction-categories-every-lap]]
- **A stale plan-doc ground-truth row nearly seeded a wrong design (G3 A″ lap 2026-07-16, ambiguous-direction, low).** The G3 plan's "Verified ground truth" table — the table that exists precisely to stop re-derivation — carried a ✅-marked claim that was FALSE at HEAD (*"`openai-compatible` has no `CLI_PROBES` entry, so `discoverProviders` never sees it"*; `providerConfirmation.ts` surfaces it explicitly when configured). Caught only because an independent reviewer re-verified against source instead of trusting the ✅. The row is load-bearing for the plan's REACH-NOW argument. Corrected in place with a retraction note. **Durable lesson: a ✅ in a dated plan doc is a claim about the tree AT AUTHORING TIME — it decays, and the ✅ makes it decay invisibly.** [[external-audit-catalogs-are-leads]] [[spec-degradation-and-doc-staleness]]
- **`git commit -F` needs a temp file; heredoc/PS here-strings still bite (G3 A″ lap 2026-07-16, inefficient-feeding, low).** Re-hit the known trap writing the A″ commit body (already logged for `git commit`); also hit it composing multi-line JSON test fixtures. Existing entry covers the fix (`-F` + temp file). Noting the recurrence only as evidence the trap is load-bearing, not to duplicate it.
- **No read-only surface shows the built dispatch pools — an exclusion rule is unverifiable until a live dispatch (G3 A″ lap 2026-07-16, tool-should-decide, medium).** Verifying "operator excludes one NIM model ⇒ siblings still route" end-to-end, I could observe the operator half at the real CLI (Gate-0 prompt → persisted `policy`) but **not the routing half**: `buildSourcePools` is reachable only from a live dispatch wave. Checked every read-only surface — `audit-code quota` reports only the host pool (`claude-code/*`) and reports the SAME with no exclusion at all, so it never builds source pools; `validate` surfaces none either. So an operator authors a rule and cannot see which pools resulted, and a typo'd rule (`openai-compatible:model-typo`) persists happily and matches nothing, silently. The grammar is OPEN by design so it can't be validated at parse time — but nothing reports "this rule matched zero backends". Property to hold: the operator can see the resolved dispatch pool set (and any zero-match rule) WITHOUT committing to a dispatch. Would also give the A″ routing filter a runtime surface to verify at, which it currently lacks.
- **Gate-0 display never reflects an exclusion for a SOURCE — no status column, and the endpoint tier can't mark a provider entry (G3 A″ lap 2026-07-16, tool-should-decide, low).** Two halves of one gap, both display-only (routing is correct — `buildSourcePools` honors every tier): (a) the Gate-0 **sources table** (`providerConfirmationStep.ts`, `| id | provider | model | $/Mtok |`) carries **no status column at all**, so NO exclusion tier is ever shown for a source — pre-existing for provider-name rules, but total for A″'s model/endpoint tiers, which can only ever match sources; (b) `provider_pool` is provider-granular and its entries carry no endpoint, so an **endpoint-host rule can never mark one** (`ruledOut` in `sharedProviderConfirmation.ts` evaluates `{provider, model}` only) — the Gate-0 table renders the backend "included" while dispatch correctly drops it. Property to hold: what the operator is shown as excluded is exactly what dispatch drops, at EVERY grammar tier. Direction is fail-safe (under-reports, never over-routes), which is why it is low. NOTE: `excluded` leaves the persisted shape in **B+D**, so fix the RENDER path, not the artifact field.
- **The per-tool seam artifact marks `excluded` at provider granularity only — inert today (G3 A″ lap 2026-07-16, low).** `confirmProviders` (`src/audit/orchestrator/providerConfirmation.ts`) still does `excludeSet.has(provider.name)` on what is now a **pattern** list, so a `provider:model` rule marks nothing in the per-tool `provider_confirmation.json`. Verified inert: the only reader of `.excluded` anywhere is the Gate-0 renderer, which reads the SHARED artifact. Cleanup, not a defect — but it is a latent trap the moment anything reads the seam's `excluded`.
- **The gate's delta collapses two providers that share a model id (G3 A″ lap 2026-07-16, low).** `computeNewlyReachableBackends`' `reachNow` map keys on `backendGateKey` = `model_id ?? provider`, i.e. the **bare model** when known — so two backends of DIFFERENT providers advertising the same model string collapse to one delta entry, and only one gets an `exclusion_pattern`. Pre-existing at A′ (which read `provider` off the same surviving entry); A″ neither introduces nor worsens it. Needs a cross-provider identical model string to bite. Property to hold: the delta enumerates BACKENDS, so its key must be provider-qualified. **3c update (2026-07-16): the repair-proxy expansion makes this likelier** — two `claude-worker` sources with different `backend_provider`s can serve the same model string and still collapse (pinned in `tests/shared/gate0-proxy-fold.test.mjs`). Deliberately NOT fixed in 3c: it is not a local key change — `backendGateKey`, `confirmedBackendKeys` (which reads `SourcePoolCostEntry`, which carries no `backend_provider`), and the exclusion grammar (`provider:model` matches on `source.provider`+`model` only) must move together, or a provider-qualified delta key that the confirmed side cannot reproduce livelocks the `PRIORITY[0]` obligation.
- **Gate-0 exclusion — SOURCE pools wired (`c99bcb9c`); HOST/primary pools still unwired, and the artifact's reach half is still write-only.** Open residue only: (a) an operator excluding the **host or primary provider** is still not honored — `buildConfirmedPools` returns unfiltered `primaryPools` + filtered `sourcePools`, and audit's `buildHostModelPools` (`quotaPool.ts:200`) is unfiltered. This is NOT a simple extension: `resolveExcludedProviders` always contains the conversation host in-session, so passing that set to the host-pool builder would zero out dispatch — excluding your own driver needs a decision about what it should even mean. (b) an absent/unparseable confirmation still fails OPEN (no policy ⇒ no operator exclusions); irreducible without a decision elsewhere. (c) the artifact's remaining reach half (`capability_tier` / `self_spawn_blocked` / derived `excluded` / `reason`) is still persisted and still write-only for dispatch → G3 commit B+D (`roster` is gone as of A′). (d) `opencode` asymmetry: `providerFactory` reads `env.OPENCODE` but `isSelfSpawnBlocked` has no opencode signal, so an opencode source inside an opencode session is not self-spawn-excluded.
- **The reconciliation gate is silently disabled if the two confirmation artifacts split (G3 A′ review 2026-07-16, tool-should-decide, low).** The obligation gates on the per-tool SEAM (`has(bundle.provider_confirmation)`, `state.ts:98`) while the gate's delta early-outs on the SHARED artifact (`readSharedProviderConfirmation(root)`, `nextStepCommand.ts`). They are written together only under `if (root)`, so seam-present + shared-absent (a root-less promotion, or an operator deleting the shared file) ⇒ obligation satisfied AND delta `[]` ⇒ the gate never fires for the run, and `resolveExcludedProviders` also finds no policy ⇒ a newly-reachable backend routes unconfirmed. Narrow (needs the pair to split) but silent. Property to hold: the gate's CONFIRMED operand and the obligation's presence check must key on the same artifact, or a split must be loud. [[dispatch-policy-vs-reach-cut]]
- **Answering an ambiguity question from memory instead of source cost a full re-decision cycle (G2.5 lap 2026-07-16, inefficient-feeding, medium).** Two owner-facing options were recommended on premises the source refutes: "two IDEs on one box get different host providers" (`resolveConversationHostProvider` discriminates only codex/claude-code/agy and DEFAULTS to claude-code — `providerPathGuard.ts:143`) and "emitted sources can't fail the parse boundary" (the validator checked 2 fields). Both survived plan-authoring and only died at independent review, after the owner had already answered. Endpoint: verify the *premise of an option* against source BEFORE putting it in an `AskUserQuestion` — an option built on an unverified claim spends the owner's decision twice. [[front-load-broad-search-before-contract-authoring]]
- **A "fully reconned, don't re-run the recon" plan doc was materially under-scoped (G1 lap 2026-07-15, inefficient-feeding, low).** [`docs/reviews/g1-auditor-descriptor-plan-2026-07-16.md`](reviews/g1-auditor-descriptor-plan-2026-07-16.md) billed its handshake-surface map as "exhaustive … the next agent should NOT re-run this recon", but a source check (not a full re-recon — just verifying edit sites) found it MISSED two live consumers (`prepareDispatchCommand.ts`, `quotaCommand.ts` both parse the handshake directly) and wrongly declared `--host-model` dead (two callers). Cheap to absorb, but the "don't re-verify" framing is the trap — a pre-written plan's replace-set is a LEAD, not a verdict; always cross-check the exact edit sites against source before trusting an "exhaustive" claim. [[external-audit-catalogs-are-leads]]
- **Offloaded (Haiku) test rewrites can silently WEAKEN assertions (G1 lap 2026-07-15, tool-should-decide, low-medium).** A Haiku subagent converting `quota-command.test.mjs` kept the test green but rewrote a malformed-roster assertion into one matching an incidental `is not a function` TypeError (asserting a downstream crash, not the intended CLI-boundary validation error). Green-but-weaker slips through a pass/fail gate. Endpoint: when offloading test rewrites, the parent MUST review the assertion semantics of each changed test (the independent-review step is the mechanical backstop — it caught this one), never trust "it passes." Generalizes [[delegate-adversarial-phases-to-separate-agent]] to offloaded test authoring.
- **Host cold-start admission wall — still open (item C from the 2026-07-15 repair-proxy dogfood).** A host
  at ~56% session-remaining (percent-only claude-oauth, no learned tokens-per-percent slope) granted 0
  packets with `admission.explains` EMPTY and the misleading message "the provider session limit is
  exhausted" ([`hostDispatchWall.ts`](src/shared/dispatch/hostDispatchWall.ts);
  [`semanticReviewStep.ts`](src/audit/cli/semanticReviewStep.ts)). Cold start must admit ≥1 (probe), never
  label ~56%-remaining "exhausted", and never emit a 0-grant with empty `explains`. B1 (repair-proxy
  loopback source had no key) and B2 (single-shot worker couldn't inline large audit packets) DISSOLVED by
  retiring the repair-proxy source-pool wiring (`repairProxyRegistry.ts` deleted, no
  `SessionConfig.repair_proxy` field) per
  [`spec/unified-dispatch-worker-model.md`](../spec/unified-dispatch-worker-model.md),
  [[unified-dispatch-worker-model]] — only item C remains, tracked as "commit 4" in that spec's
  Decomposition + `docs/HANDOFF.md`.
- **Free NIM `llm` lane — `read` BACK, `write`/NIM-completion UNVERIFIED (updated G1 session 2026-07-15, external).** `llm read` responded correctly on real inputs during the G1 recon (the earlier "completions time out / return EMPTY" note was stale — the read side is usable again). `llm write` and the raw NIM completion endpoint + `ANTHROPIC_BASE_URL` subagent-fronting were NOT retested this session. Re-probe `llm write` before relying on it. When the free write-lane is uncertain, the working offload pattern is **Haiku subagents** (parent Opus orchestrates + verifies green + independent-reviews) — used successfully for G1's bulk. Compounds the standing NIM-reliability friction (JSON-contract failures on reasoning prompts). [[free-nim-pool-first-default-worker]]
- **Loop-core gate covers `src/audit/orchestrator/` but NOT the audit cli dispatch step-emitters (2a-ii lap, tool-should-decide, low-medium) [[loop-core-enforcement-layer]].** `LOOP_CORE_PATTERNS` includes `src/audit/orchestrator/` (so 2a-ii's Finding-A fix in `advanceTypes.ts`/`executorRunners.ts`/`intakeExecutors.ts` correctly demanded attestation) but NOT `src/audit/cli/nextStepCommand.ts` / `semanticReviewStep.ts` / `prompts.ts` — where the CORE 2a-ii dispatch-inventory READ switch lives. A dispatch-substrate edit confined to those cli emitters (plausible for 2a-iii's loader wiring) would ship WITHOUT the attestation backstop. Endpoint (owner call): either add the audit cli dispatch-emitters to `src/shared/loopCorePaths.ts` (+ the `.mjs` hook parity list), or accept them as cli-glue and rely on the reviewer catching it. Not auto-expanded — widening the set makes every edit to the big `nextStepCommand.ts` require attestation, a real friction tax to weigh. **G1 (`e7b593ac`) is a concrete SECOND instance:** a breaking dispatch-handshake transport change spanning `args.ts`/`prompts.ts`/`nextStepCommand.ts`/`semanticReviewStep.ts`/`prepareDispatchCommand.ts`/`quotaCommand.ts` shipped attestation-free (none are loop-core by path). An independent review WAS done by discipline (and caught a real roster-validation-drop regression) — so the reviewer-catches-it fallback held, but only because the author chose to run it. Reinforces the owner-call endpoint above.
- **Friction walk (G3 re-plan lap, 2026-07-16):** (1) **ambiguous-direction (HIGH — cost a full review round and nearly a bad spec edit):** the doc set contradicted itself on where `DispatchPolicy` lives. `spec/unified-dispatch-worker-model.md:283` said "persists on the intent"; the memory [[dispatch-policy-vs-reach-cut]] said intent-collapse was "refuted"; the plan doc said the artifact is the only cross-tool channel. All three were *true* — of different phases (intent is the G6 endpoint; artifact is the pre-G6 reality) — but **nothing recorded that they were phases of one design**, so each doc read as a flat contradiction of the others. Draft 4 concluded the spec was stale and proposed striking an owner-approved decision. Fixed this lap by phase-qualifying the spec + memory, but the general defect stands: **a spec that states an endpoint without marking what gates it invites a later agent to "fix" the endpoint to match the implementation.** Endpoint-vs-phase should be a doc-lint rule ([[spec-degradation-and-doc-staleness]]). (2) **inefficient-feeding (HIGH):** the dated plan doc (`docs/reviews/g3-*.md`) reads as self-sufficient — verified ground-truth table, owner decisions, scope — so an agent starting from HANDOFF's "▶ Next" pointer plans from IT and never opens the design of record. That is exactly what happened here (and, per the owner, in prior laps: *"agents keep forgetting the actual goals"*). The dated plan carries mechanism; the spec carries the GOAL. Fix direction: dated plan docs should open with a mandatory "Goal (from spec §X)" restatement, or HANDOFF should point at the spec FIRST and the plan second. Cf. [[front-load-broad-search-before-contract-authoring]]. (3) **tool-should-decide (medium):** three of four drafts specced a gate that would never fire, and each was caught only by an adversarial agent tracing the call path — nothing mechanical flags "this predicate is satisfied-once-written so its executor is unreachable", "this artifact input is never invalidated", or "this obligation has no clearing path". A lint over the obligation table (every obligation's satisfy-predicate must have a reachable transition to unsatisfied, and every consume-an-input executor must invalidate it) would have caught all three deterministically. [[gate-must-be-traced-not-designed]]
- **Friction walk (repair-proxy dogfood lap, 2026-07-15):** (1) **tool-should-decide (medium), overlaps [[quota-before-cost-ordering]]:** the cost ordering shows models.dev **LIST price** ($1.92 for nim/glm-5.2), but the operator pays **$0** for it (NVIDIA NIM free tier). Free-to-operator vs metered is a per-`(operator,backend)` fact the catalog can't know; discovered pools default to list price, so a genuinely-free backend sorts as if expensive and a paid one (openrouter) can hide mid-list. Today's only lever is hand-declaring `cost_per_mtok:0` / `enabled:false` per backend in `repair_proxy.providers` (done for this run) — the tool should let the operator classify a backend's cost-relationship once, not re-price every model. (2) **tool-should-decide (low):** no way to mark a whole discovered transport's sub-provider as paid→excluded at Gate-0 itself; had to edit session config + re-run next-step. (3) **tool-should-decide (medium), = [[per-model-tiering]]:** owner reinforced that capability/tier is assigned per PROVIDER, not per (provider, model, effort). Concrete: Codex (`~/.codex/config.toml` model=`gpt-5.6-sol`, effort `high`, but `-m/--model` + `-c model=` take any model per-call) renders at Gate-0 as ONE `capable`/`resolved at dispatch` row because the legacy `codex` block has a single `model` field — its multiple models at different capability tiers collapse to one. The tool's own workaround (pin `sources[]` `{provider:codex, model, parameters:{extra_args}}` per model/effort) puts the burden on the operator; the tiering should be per-(provider,model,effort) natively, sourced from models.dev / declared config. (4) **env-var trap (low):** repair-proxy `mistral` provider hardcodes `authEnv: "MISTRAL_API_KEY"`, but the operator's Mistral La Plateforme key lived in `CODESTRAL_API_KEY` (Codestral and La Plateforme share one key but the env-var name differs) → pool silently `has_key=false`/excluded until the authEnv was repointed. A reachability probe that reports "keyed but wrong-env-var" vs "no key" would cut the diagnosis.
- **Friction walk (force-synthesize→remediate dogfood lap, 2026-07-12):** (1) **inefficient-feeding (medium):** the contract pipeline requires ~15 sequential HOST-authoring turns (goal→context→decomp→16 shards→seam→critique→testplan→assessment→counterexample→judge→DAG) BEFORE any dispatch, so with host fan-out off (to save Claude quota) the quota is spent up-front on planning regardless of routing fixes to $0 NIM/Codex; and each failed next-step CONSUMES the `*.input.json` (full regen, no in-place field fix). (2) **tool-should-decide (low):** the implementation_dag citation-grounding gate grounds on lowercased path/symbol *tokens* from title+description, so a node whose scope is dotfiles with no code symbols (`.gemini/*.toml`) or whose prose cites real paths non-token-shaped is rejected — 2 grounding re-loops until a real camelCase symbol / clean lowercase path was embedded.
- **Friction walk (quota-cluster batch-ship lap, 2026-07-11):** (1) **NIM `llm read`/`write` unusable for reasoning-heavy review** — the selected `nvidia/nemotron-3-ultra-550b` won't emit valid JSON for a `read` review prompt (returned prose "Let me ana…" twice → the strict JSON contract errors out), and a ~500-line diff times out at the default 120s. The "delegate heavy loop-core review to the free NIM pool" workflow ([[three-tier-quota-error-classification]], [[free-nim-pool-first-default-worker]]) silently degrades to doing it in-Claude. Endpoint: either pin a JSON-reliable model for `llm read`/`write`, add a longer default timeout for large stdin, or teach the worker to salvage prose→structured. (inefficient-feeding, medium). (2) **`pre-commit-gate.mjs` false-positives on `git commit -C <sha>`** — the bypass-flag scan flags `-C` as `-n`/`--no-verify`, blocking a legitimate reuse-message commit; had to fall back to `-F <file>`. Tighten the flag regex to word-boundaries. (tool-should-decide, low). (3) **`rtk npm run …` → "program not found"** on this box — the rtk npm wrapper can't resolve the npm shim, so `rtk npm run build`/`check` fail; use PowerShell `npm` directly (CLAUDE.md's "always prefix rtk" doesn't hold for npm here). (durable trap, low).
- **Friction walk (repair-proxy capability-feed ship lap, 2026-07-15):** (1) **tool-should-decide (medium):** the local `verify:release` gate returned **exit 0 while reporting "3 failed"** — a false green that let a deterministic bug (the Gate-0 fold double-ranked the legacy `openai_compatible` pool → `provider-confirmation-gate` `expected 2 to be 1`) reach the release CI, which correctly caught it in shard 3/4. The local full-suite gate must fail-nonzero on ANY deterministic test failure (suspect a `--retry` masking the count, or the profiling reporter swallowing vitest's exit code); until fixed, treat "N failed" in the summary as a hard stop regardless of exit code.
- **CI coverage gap: a docs-only commit skips the vitest suite, so a doc-lint / staleness-parity regression lands on main UNCAUGHT (2026-07-15, tool-should-decide, medium).** `audit-code-test-suite.yml`'s release-bump/docs skip guard skipped the vitest suite for commit `016d5945` (an owner-approved doc-review resolution touching `spec/audit-workflow-design.md` + `spec/audit/dependency-map.md`), so its two deterministic failures (design-docs-declarative banned-status-language at :85; staleness F1 inv-6 dep-map parity, where a producer-table row bled into the naive `.md` edge parser) sat red on main until the next CODE push re-ran the suite. Both were cheap, deterministic, doc-derived checks. Endpoint: run the doc-lint + dep-map-parity tests (design-docs-declarative, the staleness literal-parity guards) in the cheap `ci.yml` chain which does NOT skip on docs commits — a doc commit that breaks a doc-derived invariant should fail its own push, not the next unrelated code push. (Both failures fixed in `5c9edcb2`; the skip guard itself is the open item.)
- **Friction walk (openai-compatible content-inlining ship lap, 2026-07-15):** (1) **process/self (medium):** an adversarial-review HIGH-fix ADDED a field to a widely-asserted contract (`DispatchPlanEntry.file_paths`) AFTER the full-suite run; only targeted tests were re-run, so `review-packets.test.mjs`'s exact `Object.keys(plan[0]).sort()` key-set assertion (shard 1/4) was missed → caught by release CI, one forward-bump. Lesson: any post-review change to a CONTRACT SHAPE (a new field on a persisted/asserted type) forces a full-suite rerun, not a targeted one — the blast radius is every exact-shape assertion, not just the changed module. (2) **tool-should-decide (low):** exact `Object.keys().sort()` shape assertions are additive-hostile by design (leak-guard) but give a cryptic `expected 6 to deeply equal 5` with no field name; a helper that diffs and names the unexpected/missing key would cut the diagnosis loop.
- **A stale-artifact re-extraction `next-step` runs >2min with no progress signal, silently blowing a caller timeout (live dogfood 2026-07-17, inefficient-feeding, low).** After the design-review passes, the drain re-extracting 11 stale artifacts (repo_manifest/graph over 1250 components / 8466 edges, invalidated by a docs commit) exceeded a 2-minute command timeout with only a flood of identical `{"kind":"staleness",...}` lines and no heartbeat — forcing a blind retry at a longer timeout to see if it was wedged or working. Property to hold: a long deterministic drain should emit a progress/phase heartbeat (or the staleness spam should collapse to one line) so a caller can distinguish "working" from "wedged" without a retry. Minor; the retry succeeded.
- **RESOLVED 2026-07-17 (with a corrected root cause): "Conversation-first dispatches HOST-ONLY".** The premise "resolved pools never fan into the wave" was REFUTED by the run's own artifacts — the pools WERE folded in and driven; the real chain was null `contextCapTokens` (fit gates silently no-op) → 413/429 → ANY-non-complete-drive settles ALL pools → frontier collapses onto the walled host → false "exhausted" wall. Fixed as unified-routing steps A–G (never-null windows, one fit predicate, per-pool reason-aware settle, honest wall, capability floor, packer/fit consistency) — 6 attested loop-core commits, records `docs/reviews/host-fanout-premise-refuted-2026-07-17.md` + `unified-dispatch-routing-design-2026-07-17.md`. ⬇ Live-run watch (fresh conversation-first self-audit): small pools take fitting packets; an oversized packet SKIPS (no 413); a 429 on pool A leaves pool B dispatchable; a zero-grant renders its honest cause. [[grep-the-writers-before-believing-inheritance]] [[repair-proxy-dispatch-unblocked-probe-fix]]
- **Provider auto-detection misses NIM (openai-compatible) when `openai_compatible` config absent — needs session config to appear (2026-07-13 audit-gate review).** NIM does not auto-detect via PATH probe like CLI providers; it requires explicit `openai_compatible` or `sources[]` session config to appear in the pool. User expectation: NIM should appear even without config. [[nim-not-auto-detected]]
- **Provider cost ordering's quota-demotion primitive is unwired — quota-blocked providers still appear first in practice (2026-07-13 audit-gate review, updated).** `suggestCostOrdering()` (`src/shared/dispatch/costRank.ts:216-256`) now has a stable quota-saturation demotion (`CostCandidate.saturated` + partition) — but no caller anywhere in `src/` ever sets `saturated: true`; `resolveFinalCostOrder` (`src/shared/providers/providerConfirmation.ts:289`) builds candidates with no quota query. Fix: wire a real quota-headroom check into the candidate-building call site. [[quota-before-cost-ordering]]
- **Provider tiering is per-provider, not per-model/effort — wrong granularity for multi-model backends (2026-07-13 audit-gate review).** The `capabilityTier` is pegged to the provider type (e.g., all claude-code → frontier, all codex → capable). A provider offering both frontier and fast models (e.g., openai-compatible with multiple models) assigns all its models the same tier. Fix: tier per `(provider, model, effort)` tuple, sourced from models.dev or declared config. [[per-model-tiering]]
- **agy quota may reuse the wrong credential store (unverified, live-check).** agy is aliased into AntigravityQuotaSource (`src/shared/quota/antigravityQuotaSource.ts`, `ANTIGRAVITY_PROVIDER_NAMES`) which reads the IDE's `state.vscdb`/`ANTIGRAVITY_ACCESS_TOKEN`. Unverified whether the agy CLI shares that IDE credential store; if not, agy quota reads silently return null (degrade). ⬇ Live-run watch (agy install): confirm agy quota reads are non-null off its real endpoint.
- **Design (orchestrator-dispatch coupling): pool-agnostic claims + JIT quota reservation — spec'd, unbuilt (2026-07-13; promoted to concept spec 2026-07-16, forward-track).** Design of record: [`spec/dispatch-jit-claims.md`](../spec/dispatch-jit-claims.md) (claim = exclusivity not routing; planner = live capability feed; quota reserved at launch moment). Build remainder: the ClaimRegistry lock-split (drop `poolId` from claims), JIT reservation on the launch path, host-path convergence with the rolling engine. [[relax-dispatch-source-forcing]]
- **Never-dispatched anti-cascade retry (deferred, needs clean repro) [[synth-scopeless-nodes-doomed-run]].**
  A planned-but-not-driven node (no `task.json` written before launch) still terminal-blocks its whole
  downstream subtree (INV-RS-01) instead of retrying bounded-PENDING. Diagnosability (distinguishing
  never-dispatched from dispatched-but-silent) shipped in `mergeImplementResults`; the termination-safe
  retry did not — livelock risk needs a repro to validate before building it. Also still open: a
  dispatch-boundary "no scope-less dispatch" guard (refuse to dispatch a node whose synth-derived scope
  is empty, rather than relying solely on the synth-side fix that derives scope from module `file_scope`).
- **`tests/shared/rollingDispatch.test.mjs` is a genuine timing flake (2026-07-12, tool-should-decide, medium).**
  "second dispatch should start after first completes: expected 1 to be 2" — a wall-clock/ordering assertion
  that flakes under full parallel load; passes in isolation. It flaked the v0.32.62 publish CI (shard 2/4;
  the CI test suite has no `--retry`, unlike the now-hardened remediate gate) → re-run cleared it. De-flake the
  test itself (deterministic scheduling/fake timers), per test-failure-protocol "passes alone = hermeticity/
  timing bug → fix the test." Until then, a publish may need one CI re-run.
- **"Delegate the rolling loop" dispatcher pattern breaks on notification routing (2026-07-11 live run, tool-should-decide, medium).**
  The step prompt tells the host to hand the rolling loop to one dedicated dispatcher subagent, but worker
  completion notifications deliver to the MAIN session (the dispatcher idles between events), so the host
  must manually relay every completion to the dispatcher — the exact per-node tracking the delegation was
  meant to remove. Either the prompt's model is wrong for hosts with this notification topology, or the
  worker prompts should instruct workers to message the dispatcher directly.
- **NIM in-process worker: one packet failed with "empty completion (no choices[0].message.content)" (2026-07-11 live run, watch).**
  Hybrid partition (3 packets): 2 returned results inline, 1 errored empty. If it recurs on a specific
  model (ultra vs nano), demote that source or add a bounded same-packet retry on a sibling $0 pool.
- **Abandoned-wave leases saturate the cold-start cap → phantom "quota wall" (2026-07-11 live run, low — NOT a release bug; the reconcile already exists).**
  A host grant came back `granted 0`, all 14 packets `cap_reached`, `headroom_before: null` (ledger never
  consulted): `admitBatch` seeds `countByPool` from the ledger's live leases (admissionLoop.ts:307-319), the
  ledger held 4 leaked leases (2/pool, agent `24556`) with the 20-min TTL still live, and with cold-start
  effectiveCap = 2/pool the phantoms fully saturated the cap. BUT the release machinery is present and
  correct — `mergeAndIngestCommand.ts:595` reconciles a grant's leases at the top of every merge and
  `dispatch.ts:679` reconciles on the pause path. The leak's true cause was OPERATIONAL: waves I KILLED
  mid-flight this session (stopped drain, dead dispatchers, session-limit fleet deaths) never reached merge
  or pause-reconcile, so their leases freed only via the 20-min TTL. Working-as-designed backstop; cleared 4
  by hand. Only residual worth considering (deferred, low): a `next-step` startup sweep that reconciles
  leases whose owning run is demonstrably dead, so an abandoned wave doesn't false-wall a fresh one for up
  to 20 min. Not a defect in the release path itself.
- **openai-compatible content-inlining — residuals (each low, documented at the code site) ([[openai-compatible-content-inlining]]).**
  (a) **large-packet hard-refuse** — a review packet whose `file_paths` exceed the default caps
  (64KiB/file, 256KiB total, 24 files) REFUSES on a single-shot worker rather than silently
  half-reviewing (intended: loud > fabricated coverage; operator raises `openai_compatible.referenced_*`
  caps or routes to a file-reading provider). (b) The stat-error branch refuses on a non-ENOENT error
  (EACCES/ELOOP) for an existing granted file — correct, but untested (hard to simulate portably).
- **A2b unmatched-quota fallback — two residuals (each low, documented at the code site).**
  - (a) **`pausedPoolResetAt` + `quotaUnclassifiedPoolIds` are not injected across sub-waves** the way
    `costDemotedPoolIds` is (`rollingDispatch.ts` state ctor + `unifiedRolling.ts`), so within a multi-sub-wave
    drive the reversible pause + the harvest-once gate reset at each sub-wave boundary — a chronically
    quota_unclassified pool is re-attempted once per sub-wave (bounded; friction dedup collapses the repeat
    harvest). Fix = thread both through the dispatcher options like `costDemotedPoolIds`. Efficiency-only.
  - (b) **The A-8 hybrid `executeInProcessPartition` (direct `Promise.all`) never invokes the rolling engine's
    hooks**, so the VERBATIM harvest (`captureQuotaUnclassifiedFriction` / `captureCreditExhaustionFriction`)
    does not fire there — a settled node surfaces only as a `quota_escalation` friction (no verbatim text).
    Affects `credit_exhausted` identically (pre-existing, not new to A2b). Fix = thread verbatim capture into
    `executeInProcessPartition`. The pool IS now settled there (no unbounded re-offer), so this is harvest-signal
    completeness, not a safety gap.
- **Design (remove-waves track): dispatch should be gated ONLY by token-budget, rate, and true task-unlocks — the host merge/re-grant barrier is artificial for independent review packets (2026-07-11 live run, owner design statement, forward-track).**
  Owner's spec: when dispatching up to quota with tokens estimated a-priori, the ONLY legitimate reasons to
  hold a packet for a later dispatch are (1) a non-parallelizable predecessor finishes and UNLOCKS the task,
  (2) the quota window refreshes, (3) the pool is RATE-limited (RPM/TPM) — not budget-limited. Any other
  hold is pure latency. Mapping onto audit-code:
  - Base review packets are embarrassingly parallel (read-only, no write conflict, no ordering) → they
    should ALL dispatch the instant they fit budget+rate; the `next-step → dispatch → merge-and-ingest →
    next-step` barrier on the host path is an artificial wave, NOT one of (1)/(2)/(3).
  - The IN-PROCESS rolling engine (codex/NIM via `driveRollingAuditDispatch`) ALREADY implements the correct
    model — continuous slot-pull, dispatch-to-capacity, refill-on-completion, pace-on-rate. The host path is
    the deviation.
  - Legitimate (1) DOES apply to ONE layer: selective-deepening tasks are derived from completed packets'
    findings (`+N deepening` per merge), so a merge must precede them — the barrier is correct for the
    deepening layer, artificial for the base frontier.
  - The calibration cap (below) is a FOURTH, illegitimate hold: it throttles on not-knowing-quota-in-tokens,
    which is neither budget, rate, nor unlock — and never resolves. Endpoint: host admission should grant the
    full budget-and-rate-fitting independent set at once (like the in-process engine), reserving merge-gated
    re-grants for the deepening layer only. Realizes [[self-scaling-pipeline-not-forked-paths]] on the host path.
- **Host fan-out quota gate — residual (still open) ([[host-fanout-quota-gate]]).** **ad-hoc** Agent
  fan-out (recon/review the host spawns outside the prescribed design-review/systemic-challenge steps)
  still has no per-agent ledger — see the "ledger-writer / acceptNode-inert-clean lap" sliver below.
- **Design-review worker prompts — FOLLOW-UP (low, latent):** the solo `design_review_contract` branch
  still embeds the next-step advance command directly in its worker-facing prompt (`nextStepCommand.ts:391`)
  — same second-driver hazard already fixed for `design_review_parallel` (`e6b580d0`), and it has the host
  mark its own homework (vs [[delegate-adversarial-phases-to-separate-agent]]). Consider dispatching the
  contract review to an independent subagent there too.
- **Doc-review auto-apply must reconcile against HEAD, not a stale branch snapshot (2026-07-10, tool-should-decide).**
  **Tool fix (open):** the doc-review auto-apply must not re-propose/re-apply an item whose decision is already
  recorded resolved (or already committed to the tracked tree) — it should reconcile against HEAD, not a stale
  branch snapshot. Relates [[enforce-robustness-in-tooling-not-host-discretion]]. (The durable "git diff your
  instruction files after a restart" trap this friction produced now lives under *Durable traps*.)
- **Friction-walk lesson (lease-TTL / untracked-scope laps, recurring):** the SessionStart doc-review hook's
  clear-on-apply ledger (`doc-review-resolved.json`) is local-only — a worktree branched before a resolution
  commit lands on main re-surfaces already-resolved items from stale state (hit twice). Open tool fix: the
  hook should reconcile against the fetched remote's resolved-state (or flag "worktree behind main — list may
  be stale") before surfacing.

- **Untracked-exclusion scope rule — residuals (shipped 2026-07-10; each low-severity, documented at the
  code site).** The scratch-pollution bug is FIXED in tooling: `buildFileDisposition` now runs an `untracked`
  scope rule (one batched `git ls-files -z`; still-included files absent from the index → `excluded/untracked`,
  guards mirror the gitignore rule) so untracked litter can never enter the auditable scope, plus a
  single-sourced `renderHostScratchNote`/`hostScratchDir` prompt line directing host scratch into
  `.audit-tools/<area>/scratch/<run-id>/`. The unsound bounded/aggregate exclusion representation was deleted
  outright (a missing disposition record reads as *included* downstream, so aggregation silently un-excluded
  exactly the matched files — per-file records are now mandatory, validator-enforced). Residuals:
  - (a) **Submodule / nested-repo contents are now excluded as `untracked`** (parent `ls-files` lists only the
    gitlink). Consistent with citation grounding (which also can't ground them), but a silent scope change for
    repos with first-party submodules. Ideal fix = `--recurse-submodules` in BOTH the disposition rule and the
    grounding corpora (`findingGrounding.enumerateTrackedFilePaths`, M-B3 `enumerateRepoTreePaths`) as one
    atomic change — never one side alone (re-opens the asymmetry).
  - (b) **`file_disposition` now depends on git index state, which the dependency DAG doesn't track**
    (`dependencyMap.ts` keys it to `repo_manifest.json` only). An index-only change (committing a
    previously-untracked file) won't re-stale a persisted disposition until repo_manifest churns.
    ⬇ Live-run watch: after committing files mid-run-continuity, confirm they enter scope on the next audit.
  - (c) **Scope-rule guard decisions are invisible at the intent checkpoint** — `computeScopePreDigest` reads
    only per-file entries; a skipped rule (`root_untracked`/`share_exceeded`/git-absent fallback) never
    surfaces to the operator despite the summary existing for exactly that purpose.
  - (d) **Grounding corpora still use `ls-files` without `-z`** (`findingGrounding.ts:108`,
    `contractPipelineGates.ts` ~1034): non-ASCII tracked paths arrive C-quoted (`core.quotePath`), so citations
    to such paths fail grounding while the disposition (which uses `-z`) keeps them in scope.
  - (e) The audit `renderEdgeReasoningStepPrompt` single-agent dispatch carries no scratch-dir note (params
    lack run context; one bounded agent writing one results file — lowest-risk path, add if it ever litters).
- **Friction-walk lesson (ledger-writer / acceptNode-inert-clean lap):** `[[spec-degradation-and-doc-staleness]]`
  (verify premises before building; a pause/interrupt is not a content-veto) — see memory. Open tool slivers:
  (a) NIM `llm read` going down silently degrades the "route review to free NIM" plan to paid subagents with no
  signal — a health-probe-then-route would remove the guesswork; (b) ad-hoc Agent fan-out (recon/review)
  still has no per-agent ledger for a session-limit mid-edit death, unlike remediate-code's per-node
  worktrees + claims.

- **External shared-logic audit V1–V7 residuals** (each deliberate, low-severity, documented at the code
  site):
  - **(from V3) postinstall agent-scope legacy-wildcard migration gap.** Both postinstall scripts preserve
    an EXISTING legacy agent-scope bash `'*':'allow'` in an already-deployed
    `~/.config/opencode/opencode.json` on upgrade (the wrapper/install path DOES migrate it → `'ask'`;
    pinned deliberate by remediate's COR-fc1f12a6 tests). Full closure: mirror the wrapper's
    `withoutManagedBroadBashWildcard` migration into `scripts/{audit,remediate}/postinstall.mjs`.
  - **(from V5) path-guard blind spots.** `tests/shared/audit-tools-path-guard.test.mjs` cannot see
    template-literal construction (no live occurrence today) and its allowlist honesty check is
    substring-only. Tighten if a violation ever sneaks past. Also low: `validateArtifacts`'s unused
    `root="."` default now yields an absolute (not relative) report path — no live call site hits it.
  - **(from V2) conversation-first mid-run dirt is indistinguishable.** A declared-but-unedited file the
    USER dirties during the run window can still be staged in the `merge-implement-results` flow —
    `run_start_dirty` fences only pre-run dirt; full closure needs per-edit git ground truth that flow
    lacks. Documented at `collectStagingFiles`. ⬇ Live-run watch (conversation-first run on a dirty repo):
    `leftover_files` in the report must list untouched dirt; nothing outside the run's surface committed.

- **Friction-walk lesson (D-66/67 slice-1 ownership-gate lap):** design-level adversarial review pays for
  itself before a line is written, and review depth should scale with delicacy
  (`[[delegate-adversarial-phases-to-separate-agent]]`) — see memory. Open tool sliver (low value): the
  PreToolUse commit-gate fires on the whole Bash call before a chained `attest && git commit` runs, so the
  attestation half hasn't executed when the gate checks (workaround = attest as its own call); a gate that
  recognized the attest step in the same chain would remove the trap.

- **Friction-walk lesson (shared-logic-audit validation lap):** an external audit catalog is leads, not
  verdicts — validate its rows against current code + design-of-record before remediation intake
  (`[[external-audit-catalogs-are-leads]]` / `[[spec-degradation-and-doc-staleness]]`) — see memory. Open
  tool gap: remediate's grounding phase catches phantom PATHS but not stale CLAIMS ("X is duplicated" when X
  was single-sourced) — no tool support for claim-staleness (inherently judgment; handled by subagent
  verification today).

- **Friction-walk lesson (backlog-clearance lap):** a backlog item / chosen option / design memory is a
  point-in-time proposal — verify its premises against current code AND a real measurement before building
  (`[[spec-degradation-and-doc-staleness]]`) — see memory. Open tool sliver: the pre-commit gate that
  silently failed-open in linked worktrees is FIXED (scratch index → `os.tmpdir()`), but the durable
  improvement — make a fail-open on infra fault OBSERVABLE (a one-line stderr when the staged-snapshot path
  bails) rather than silent — is not yet done.

- **Top gate optimization lead (measured 2026-07-06, was the "vitest collect" item).** First profiled
  numbers (win32, Node 26 local; CI Linux will differ but the shape holds):
  - **`verify:checks` gate = 95.8s, of which `smoke:packaged-audit-code` alone is 70.2s (73%).**
    `smoke:packaged-remediate-code` is 13.2s; everything else is ~12s combined. **→ The highest-leverage gate
    win is the packaged-audit-code smoke.** Internal breakdown (measured): `next-step ×~7 to dispatch_review`
    = 35.9s (53% — the real audit-flow round-trips, inherent coverage), `npm install from tarball` 9.3s,
    `next-step to present_report` 10.1s, `npm pack` 7.2s (incl. a prepack rebuild). The next-step round-trips
    are fresh-process pipeline runs — cutting them cuts coverage, so this needs a real design (e.g. an
    in-process multi-step driver for the smoke, or packing once and sharing the tarball across both smokes
    since they build the identical `audit-tools` package), not a quick trim.
  - **Full vitest suite = 307s wall (452 files), `collect≈211s`** (confirms the old ~186s estimate), run
    time dominated by audit integration tests that spawn real subprocesses: `audit-code-completion` 285s,
    `audit-code-wrapper` 237s, `next-step` 165s, `cli-remediation` 111s. area:audit ≈ 1905s summed across
    workers vs remediate 451s / shared 62s. `pool: 'threads'` / `isolate: false` won't help the run-time
    tail (it's subprocess wall, not isolation overhead); the real lever is the sharding already shipped +
    possibly splitting the few 100s+ integration files across more shards. Only pursue collect/pool changes
    with per-file verification (many tests mutate fs / spawn subprocesses → isolation-off risks bleed).

- **Dispatch admission-control rework — residual (env-bound / deeper, not blocking).** Shipped; see
  `docs/HANDOFF.md` → "T5 forward tracks" for what landed. Design of record
  [`spec/audit/dispatch-admission-control.md`](../spec/audit/dispatch-admission-control.md);
  [[capability-is-per-auditor-not-per-audit]] / [[dispatch-admission-control-design]].
  - (a) **live validation** of the real host+codex+NIM concurrent run — a metered multi-pool run confirming
    the demoted backend actually fans out alongside the host (folds into the quota-aware-dispatch live-run
    watch below). (b) **Deeper simultaneity:** the audit hybrid path drives the in-process (codex/NIM)
    partition to completion within a `next-step` turn, THEN hands the complement to the host — so host and
    backend alternate ACROSS turns, not simultaneously WITHIN one. True within-turn simultaneity would need
    a detached background driver spanning host turns (architectural; only pursue if wall-clock on a real
    run shows the alternation is the bottleneck).

- **Quota-aware dispatch — live validation env-bound.** Still open: live validation of the token-budget
  dispatch gate (per-`(pool,window-label)` learned tokens-per-percent slope, budget = MIN across a
  pool's windows, quota-death = retryable pause preserving worktrees) on a real rate-limited
  multi-worker run — cold-start calibration slope + the resume path especially want a live check.
  Relates to [[claude-usage-endpoint-body-shape]] / [[claude-quota-credential-resolution]] /
  [[cross-provider-quota-matrix]] / [[quota-dispatch-vision]].
  - **⬇ Live-run watch** (a metered provider + large target is the exerciser — the run itself hits the
    wall; `AUDIT_TOOLS_LIVE_QUOTA=1` only enables the live-credential test probe, it does not force a
    production wall): at the
    rate wall the run must **pause gracefully, not crash**, and leave every in-flight worktree intact; on
    resume it continues from the pause with no lost/redone work. Early on, the tokens-per-percent slope
    should *learn* (dispatch pacing adjusts after the first window reading) rather than stay at the
    cold-start default. FAIL = crash/stall at the wall, discarded worktrees, or a resume that re-does or
    drops packets.

- **Rolling-engine ledger-blocked retry spins at 50ms during a crash-orphan lease wedge (2026-07-10,
  efficiency follow-up from the lease-TTL fix; adversarial-review finding).** With `DISPATCH_LEASE_TTL_MS`
  (20 min, `src/shared/quota/reservationLedger.ts`), a crashed sibling's orphan lease can block an
  in-process run's packet for up to the TTL — correct (waits, never double-grants), but the run loop's
  pending retry tick (`rollingDispatch.ts` ~1348, 50ms) then hammers `admitAgainstLedger` →
  `withFileLock` read-modify-write per pending packet (~24k lock cycles worst case). Fix direction:
  backoff on ledger-blocked retries, or heartbeat-renewed short leases (the ClaimRegistry pattern,
  `auditStep.ts:96`) restoring ~30s crash recovery. Efficiency-only; folds naturally into D-66/67 slice-3
  (heartbeat-on-long-claims) if that opens.

- **Critical-flow LLM fallback — residual (accepted, low) (`critical_flow_fallback_current` obligation).**
  The host submission (`critical-flow-fallback.json`) is a durable leaf input that never re-stales, and
  the obligation is satisfied by its PRESENCE alone — so once the host answers (even `{flows:[]}`), the pass is
  permanently suppressed even if the repo later grows and deterministic inference stays below the bar. Matches
  `intent_checkpoint` persistence semantics (a host input that persists). A future enhancement could re-prompt
  when the repo materially changes (add `repo_manifest.json` as a marker dep, or gate satisfaction on
  merged-flow freshness rather than marker presence) — deferred until a real run shows stale enrichment biting.

- **Friction detection — M-QUOTA escalation chain: live validation env-bound.** The
  `recordLimit → escalate → strand → quota_escalation friction` chain is unit-tested end-to-end on both
  drivers (`tests/shared/rollingDispatch.test.mjs`; `tests/audit/rolling-audit-dispatch.test.mjs` §5).
  **Still open:** live validation on a real rate-limited run. [[meta-audit-friction-must-be-tool-enforced]]
  - **⬇ Live-run watch** (same wall run as quota-aware dispatch): when a packet escalates across pools at
    the wall, a **`quota_escalation` friction event** must be captured at the step boundary — check the
    run's friction log / meta-audit surface after the run and confirm the event is present with the
    escalated packet id. FAIL = wall hit but no friction event recorded (the chain didn't fire live).

- **Selective-deepening convergence — live validation env-bound.** Both known convergence loops
  (packet-result `task_id` mismatch; idempotency_key collision across rounds) have shipped fixes and need
  a real deepening-capable run to confirm. Recovery until validated: quarantine orphan pending
  `deepening:*` tasks.
  - **⬇ Live-run watch** (any audit whose findings trigger deepening — i.e. low-confidence/high-risk areas
    that spawn `deepening:*` tasks): every `deepening:*` task must **converge and complete** within a bounded
    number of rounds; the run reaches synthesis on its own. FAIL = orphaned pending `deepening:*` tasks, the
    same finding re-deepened every round (idempotency collision), or the run only finishing via
    `force-synthesis`. If you hit it, quarantine the orphan `deepening:*` tasks and note the round count here.

- **`llm read` very large review-framed payloads still fail post-fix.** A ~700-line review-framed diff
  still fails after the upstream JSON-contract fix (clean error, no result) — workaround: split the
  payload; if it recurs, add a chunked-review mode in llm-worker-tools rather than host-side splitting.

## Forward tracks

- **One repo intent, three filenames — the audit/remediate intent split is a `one core, two draws` smell (surfaced by G3 recon 2026-07-16).** Audit's intent is `<root>/.audit-tools/audit/session-config.json` (`src/audit/supervisor/sessionConfig.ts:16` + `auditArtifactsDir`); remediate's is `<root>/.remediation-artifacts/session-config.json ?? <root>/session-config.json` (`src/remediate/steps/sessionConfigLoad.ts:63-67`, called from `nextStep.ts:1779-1783`); a stale guard-message in `claudeCodeProvider.ts:15`/`agyProvider.ts:9` still points operators at a third path, `.audit-tools/remediation/session-config.json`, that nothing reads — the wrapper itself no longer seeds it (`wrapper/remediate-code-wrapper-install-hosts.mjs:665-667` deliberately creates the config empty on demand). They are DISJOINT — audit never writes a file remediate reads as intent — which is precisely why the root-scoped `provider-confirmation.json` exists as the only cross-tool decision channel (`sharedProviderConfirmation.ts:4-9`). Two draws of one concept with three homes and no shared store. Unifying the path is a prerequisite for ever collapsing the Gate-0 artifact into the intent (a G3 draft proposed exactly that and was refuted on this). Too large to ride G3.
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
- **Free/cheap multi-account "quota-arbitrage" dispatch tier (9router-inspired) — exploration → build.**
  Fan dispatch across genuinely-free backends + (later) N captured subscription-OAuth accounts, rotating on
  429/cooldown to exceed any single subscription's limit. Key finding: this is **extra SOURCE POOLS on our
  existing machinery, not a new provider engine** — pool identity is already `(provider, account[, model])`,
  the admission loop (`admitBatch` cost-first + spill) already IS the rotation engine, the `ReservationLedger`
  already does per-key backoff, and Claude/Codex/Copilot arbitrage accounts get live per-account quota for free
  via `BaseHttpQuotaSource`. Worker shape ≈ `OpenAiCompatibleProvider` (thin `buildHeaders`/`buildUrl` subclass)
  except Kiro (AWS EventStream) + Cursor (protobuf). **Reuse (vendor+sync, MIT):** 9router's provider OAuth
  catalogue (`PROVIDER_OAUTH` + token-refresh endpoints/client_ids) — the someone-else-maintained table the
  corrected sourcing rule prefers; `ERROR_RULES` text classes. **Novel build:** a multi-account credential store
  + refresh-under-lock (encrypted, rotation-loss-safe) generalizing `ClaudeOAuthQuotaSource`. **Risks:**
  ToS/paid-account-ban (impersonating official CLIs — Claude/Codex/Cursor highest; opt-in, never default-on);
  token-security surface (multi-account refresh tokens; encrypted/never-logged/atomic — recall the Antigravity
  leak). **Phase 0 first slice (recommended, ~zero ban/security risk):** `opencode-free` (`Bearer public`) +
  `vertex-trial` (operator's own GCP $300 SA) as free source pools reusing `OpenAiCompatibleProvider` → priced
  ~0 by `deriveCostRank`, routed first, spill already handled. Then Phase 1 multi-account OAuth store
  (Claude/Codex/Copilot). Design of record + full phased plan in memory [[arbitrage-dispatch-tier-design]];
  a coverage diff (2026-07-07) confirmed 9router's price table adds nothing over models.dev, so skip it.
  Relates [[quota-dispatch-vision]] / [[dispatch-admission-control-design]] / [[cross-provider-quota-matrix]] /
  [[openai-compatible-provider]] / [[model-provider-ide-agnostic]].
  - **Phase-0 opencode-free — env-bound live validation remaining.** opencode-free ships as a pure-config
    source entry (`cost_per_mtok:0`; see `examples/catalog/sources-declared.json`). Since G2.5 it is declared
    machine-level in `~/.audit-code/sources-declared.json`, NOT the repo session-config (G2 removed
    `sources`/`provider` from the persisted type), and its key must be an `api_key_env`
    (`OPENCODE_ZEN_API_KEY=public`) — an inline `api_key` is refused as not ambient-verifiable.
    **vertex-trial → deferred** (needs operator's GCP $300-trial SA JSON). **Remaining = live validation only**
    (no more code): a real opencode-free run confirming declared-free routing + a live lapsed-free demotion +
    the `declared_cost_drift` friction event end-to-end.
- **Cost↔speed dispatch dial + free-pool maximization.** Generalizes the cost-first router — the
  minimum-cost corner of a cost-vs-throughput Pareto frontier — into a tunable operating point ON TOP of
  the kept router (does not replace it). Shipped: 1D dial (λ ∈ [0,1], capability a hard floor),
  pool-class-aware throughput derivation (`deriveThroughputConcurrency`), and the shared
  `admissionPoolsFromSummaries` builder. Design of record
  [`spec/dispatch-cost-speed-dial.md`](../spec/dispatch-cost-speed-dial.md); extends
  [[cost-first-routing-design]].
  - **Free-pool maximization (dial-independent).** Price-0 pools are first-fill at every operating point → free
    is saturated before any paid pool automatically (`costRank` already delivers it once a source is registered).
    "Maxed" = saturated to the pool's declared sustainable ceiling (`declaredCap` + rate limits + reactive 429
    floor), NOT flooded. **Correction:** the old note said this "depends on C3-AIMD" — C3-AIMD is CLOSED; the
    ceiling is now `declaredCap` + reactive backoff, no learned ceiling. Real work = **register every free source
    as a pool** = the arbitrage-tier track [[arbitrage-dispatch-tier-design]] (Phase 0 zero-ban-risk first).
  - **OPEN (owner call):** whether QUALITY also becomes tradeable vs cost (a true 2D dial, needs a per-task
    quality-worth weighting) — default recorded = 1D cost↔speed + capability floor.

- **models.dev static window can over-state a specific deployment (carried from W1).** The snapshot lists e.g.
  `claude-opus-4-7` at 1M context; a real headless run serving a 200k variant with discovery absent would over-size
  work blocks off the static rung. Mitigated by `BLOCK_SAFETY_MARGIN` 0.7 + discovered-capability always overriding —
  watch on a real headless metered run.
- **Minor provider/dispatch cleanups (low-pri, bundle opportunistically).**
  ~~providerFactory Rule 6 (`hasClaudeCodeConfig && claudeAvailable`) is a provable strict subset of Rule 9
  (`claudeAvailable`) — delete the redundant rung~~ — **FALSIFIED 2026-07-05 (verify-before-implementing).**
  Not a no-op: the opencode/codex *config-gated* rungs sit BETWEEN Rule 6 (claude config-gated) and Rule 9
  (claude bare-availability tie-break) and resolve to *different* providers. For a dual-configured operator
  (`hasClaudeCodeConfig && claudeAvailable && hasOpenCodeConfig && opencodeAvailable`), Rule 6 makes explicit
  claude config win; deleting it lets the opencode config-gated rung fire first → resolution flips
  claude-code→opencode. Rule 6 is a predicate-subset of Rule 9 but NOT redundant in the ordered table. Leave it.
  Remaining (still valid): inline `makeProviderKeyedFactory` (19 LOC, 2 sites — but it's a cross-area generic
  with its own dedicated test `tests/shared/provider-keyed-factory.test.mjs`; inlining loses cohesion,
  marginal — low value).
  Do NOT delete working proactive quota sources (`BaseHttpQuotaSource` + one-array register is already clean);
  `copilot` is correctly broker-only.

- **Schema-enforced generation — CE-004 residual (provider-blocked only).** The openai-compatible / NIM
  guided-decoding path is **SHIPPED** — the AuditResult `outputSchema` is plumbed through and the dispatch site
  sets it, so those endpoints get emit-time constraint (`guided_json` / `response_format: json_schema`). The
  sole residual is the always-on conversation host (`claude-code`), which advertises no API-level constraint
  mechanism → on that path CE-004 reduces to the repair floor (no emit-time prevention). Genuinely
  host-blocked, not a defect; unblocks only if that host gains a constraint endpoint.
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

- **D-66/67 SLICE-1 — merge-time ownership-gate on the long-lived claims (OD3 layer 2).** Shipped;
  design-of-record + residuals below.
  - **Accepted residual:** the probe window is staleMs-wide, not instantaneous — worst case is a stale
    LAND a beat before an imminent reclaim, never a double-land (base mutations stay serialized by the
    per-node + base-branch locks). Slice-3 heartbeat machinery shrinks it if a real cooperative run
    shows it matters.
  - **Discovered asymmetry:** remediate's `phase:main` mutex has OD3 layer-1 only (`withClaimHeartbeat`
    wraps `advance()`, `nextStep.ts` ~5088), NO layer-2 re-check before persist — unlike audit's
    `auditStep.ts:216-239` template. Not mechanically mirrorable (remediate's persists are distributed
    inside `advance()`); tracked as a still-open correctness gap for slice-3 to fold in.

- **Unify the full rolling-dispatch lifecycle shell across audit + remediate (doc-review D-66/D-67/C-7).
  Slice-1 SHIPPED (entry above); slice-2 VERIFIED not worth building as a shared reducer — Layer A
  (`PartialCompletionTerminal`) is already the correct shared surface; Layer B
  (`advancePausedState`/`LIVELOCK_PAUSE_LIMIT`) is audit-only by nature and correctly forked
  ([[rolling-lifecycle-unify-full-unification-wrong]]); open = slice-3 heartbeat only.**
  Today the genuinely-shared surface is the *admission decision* only
  (`computeDispatchAdmission`, single-sourced in `audit-tools/shared`). Two lifecycle shells around it are
  NOT shared: (a) the pause lifecycle — audit owns `waiting_for_provider`/`pausedState.ts`/`filterNewProviders`;
  remediate has its own separately-implemented `quota_paused` analogue; (b) OD3's heartbeat + merge-time
  ownership-gate revocation protocol — wired only to the short-lived coordination mutexes
  (`withClaimHeartbeat` on bundle-mutation / `phase:main`), NOT the long-lived per-task/per-node execution
  claims (`task-claims.json`, remediate node-claims), which hold a long lease with no live heartbeat and
  rest on dedup-by-id at ingest as the correctness backstop alongside the now-shipped slice-1 merge-time
  gate. The full lifecycle-shell sharing + OD3-heartbeat-on-long-claims is still-intended future work
  (slice-3), not abandoned. Design-of-record specs
  ([`spec/multi-ide-concurrent-runs-design.md`](../spec/multi-ide-concurrent-runs-design.md) OD3;
  [`spec/audit-workflow-design.md`](../spec/audit-workflow-design.md);
  [`spec/remediation-workflow-design.md`](../spec/remediation-workflow-design.md)) now scope the shared
  claim to admission-math and point here for the unification. [[multi-ide-concurrent-runs-design]] /
  [[dispatch-admission-control-design]]
  - **Design-of-record (READ before building slice-3 — it changes the target).**
    The driver + packet engine are ALREADY unified (both orchestrators run `driveRolling` over
    `createRollingDispatcher`); only the pause/resume TERMINAL adapter + OD3-on-long-claims are forked.
    Precise map: audit pause = `RollingEngineLifecycleState` (`src/shared/rolling/pausedState.ts`:
    `running|waiting_for_provider|terminal`; `advancePausedState` reducer; `LIVELOCK_PAUSE_LIMIT=3`; wired in
    `rollingAuditDispatch.ts advanceRollingPause`) — INTERNAL, self-advancing, livelock-bounded, partial-coverage-OK.
    Remediate pause = a `PartialCompletionTerminal{reason:"quota_paused", earliest_reset_at}` variant
    (`src/shared/quota/capacity.ts`; `nextStep.ts` ~4636; stranded nodes stay pending) — EXTERNAL, unbounded,
    host-retries-at-reset. **CRITICAL FINDING: full unification is the WRONG endpoint.** The resume SEMANTICS
    genuinely diverge — audit may bound-and-give-up to partial-coverage synthesis (read-only, safe); remediate must
    NOT abandon half-applied edit-nodes to "partial coverage" (a correctness hazard). So the livelock-terminal-vs-
    wait-forever branch MUST stay a per-orchestrator policy injection; `earliest_reset_at`-driven external resume has
    no audit counterpart. **Shareable core for slice-3 (the actual work, bounded):** a shared
    `withExecutionClaim` = `withClaimHeartbeat` + the merge-time `registry.heartbeat(token)` ownership-gate
    (which today exists ONLY inline on the short bundle-mutation mutex, `auditStep.ts`:219), applied to the
    LONG-lived claims (`task-claims.json` 20-min lease, remediate node-claims 30s) that currently hold a
    lease with NO heartbeat. **Architectural gotcha:** the long claims are held across OUT-OF-PROCESS worker
    runs where the parent isn't looping, so there is no natural beater — adding a heartbeat needs a beating
    owner during the out-of-process span (non-trivial). This is a FOCUSED-LAP track — the most delicate
    machinery in the repo (pause/claim/quota), a genuine divergence to respect, and the owner's own
    "redesign before scheduled autonomy" caution applies; do NOT rush it as a tail-end change.

- **Per-lap cadence rules tool-enforcement (doc-review D-68/D-69) — genuine residue (accepted, not
  built):** (a) the LAP-level decision to route an item through the orchestrator vs hand-fix it is still
  host judgment — its tool-enforced end-state is "route substantive work through the self-scaling
  orchestrator" (the [[self-scaling-pipeline-not-forked-paths]] north star), not a new gate; (b) a
  hand-fix lap that never invokes an orchestrator produces no friction artifact, so it is covered only by
  the Stop-hook backstop (and only if a recent run artifact exists in its 12h window). Closing (b)
  mechanically (e.g. block session end on any commit-bearing lap lacking a friction walk) would be fragile
  and over-fire; deferred with `CLAUDE.md`'s "Redesign before scheduled autonomy" rather than force it.
  [[enforce-robustness-in-tooling-not-host-discretion]] / [[self-scaling-pipeline-not-forked-paths]]

- **Context-efficiency access-memory track (items 1-3) shipped; non-blocking follow-up open:** packet `task_ids`/`lens` attribution missing from the token-usage ledger (`DispatchPlanEntry` carries neither).

## Deferred / waiting

- **A2 finding-quality oracle** — the `score-audit` scorer is built; needs operator-authored
  `corpus/<run-id>.labels.json` (hand-labeled real audit runs) before it can score precision/recall.
  - **⬇ To close (after any live audit):** take that run's findings, hand-label each true-positive /
    false-positive into `corpus/<run-id>.labels.json`, then run `score-audit` → precision/recall. The
    labeling is ground-truth human judgment (can't be automated); one solid labeled run unblocks the oracle.
- **A7 multi-host validation** — `npm run verify:hosts` (automated, in `verify:release`) is built and
  green; the provider-matrix e2e is gated behind `RUN_PROVIDER_MATRIX_E2E=1`. **Remaining:** the
  release-time manual GUI checklist ([`host-validation.md`](../spec/host-validation.md)) for GUI-only
  hosts (Antigravity/OpenCode).
- **Manual real-OpenCode validation** that agent-scoped permission allowances propagate to spawned
  subtasks. Folds into the A7 checklist.
- **`/remediate-code` GUI-host manual checklist (parity with `/audit-code`).** `spec/host-validation.md` is
  a manual GUI-host live-dispatch checklist for `/audit-code` only; `/remediate-code` has the automated
  no-drift gate (`verify:remediate-hosts`) but no equivalent manual GUI-host checklist, which the
  "keep orchestrators in parity" convention says it should have. Add a sibling `/remediate-code` checklist
  (or extend `host-validation.md`). Folds into the A7 release-time GUI checklist work.
- **Gated live e2es** skip without creds: `RUN_PROVIDER_MATRIX_E2E=1`, `RUN_NIM_E2E=1`,
  `AUDIT_TOOLS_LIVE_QUOTA=1`, `RUN_AUTONOMY_E2E=1`.
- **Provider `queryLimits`** deferred — revisit if a provider gains a real proactive rate-limit endpoint.
- **Narrow staleness on prose-heavy artifacts via bounded semantic judgment.** Prose-heavy fields feed
  downstream LLM prompts; a cosmetic edit forces wasteful re-emit. The narrowing = bounded judgment on
  meaning change, fail-safe to re-derive. Efficiency-only; defer until re-emit churn is measured.

## Doc-set hygiene (enforced)

- **Canonical doc set is mechanically reconciled.** `scripts/check-doc-manifest.mjs`
  (in `verify:release`) fails the build if any tracked `docs/**/*.md` is absent from the
  routing table in [`doc-review-guidelines.md`](doc-review-guidelines.md), or a row points
  at a deleted file. A stray/dated doc can no longer accumulate silently — it must be
  registered (type + reason) or deleted. The doc-review routine adds the soft layer:
  existence-review every run + version/date/status strings are escalate-not-auto-bump
  (a doc whose only diffs are version bumps is a status doc → propose generate-or-retire).
  Durable design captures go to a canonical design doc or backlog/HANDOFF, **never** a
  dated `*-plan-of-record.md` in the tracked tree (the gate now rejects the latter).

## Durable traps (environment / tooling reference)

- **`git checkout -- <file>` silently destroys unstaged work when a review round is staged.** Common
  during review-driven rework: you `git add -A` to give reviewers a stable diff, keep editing in the
  working tree, then use `git checkout -- <file>` to undo a temporary mutation-test edit. That
  restores from the INDEX, i.e. the pre-rework staged version — so every unstaged fix to that file is
  gone, with no warning and a clean-looking tree. Bit once during account-metering step 2 (lost an
  `assertWindowScopes` call + its import; caught only because a red-green mutation then behaved
  impossibly). **Use instead:** copy the file to the scratchpad before mutating and `cp` it back, or
  `git stash` the mutation. Never `git checkout --` a file that has unstaged work you want.

Standing gotchas worth keeping for any agent (strong or weak):

- **`$?` after a pipe reports the FILTER's status, not the command's — masked a red gate (2026-07-18).**
  Ran `npm run verify:checks 2>&1 | grep -iE "fail|error"; echo "exit=$?"` and read `exit=0` as "gate
  green" — it was grep's exit code. Combined with the tracked-files trap below, that produced a confident
  false-green that CI then caught. **Capture the exit code before filtering** (`cmd > log 2>&1; echo $?;
  tail log`) or use `PIPESTATUS`. Generalizes [[lap-green-must-match-ci-evidence]] to the agent's own
  verification technique: a green *reading* is not a green *run*.
- **`check:doc-manifest` only sees TRACKED files — a new doc passes locally pre-commit, then fails CI
  (2026-07-18).** Wrote a new `docs/reviews/*.md`, ran `npm run verify:checks` green, committed, and the
  release run's `gate` job failed on exactly that file ("stray doc not in the canonical manifest"). The
  checker enumerates git-tracked docs, so an untracked new doc is invisible to it — the local gate is
  green *because* the file isn't staged yet. **`git add` the doc BEFORE running `verify:checks`**, or the
  gate is testing a different tree than CI will. Cost one burned release tag (v0.33.8 → forward-bump).
  Generalizes [[lap-green-must-match-ci-evidence]]: same command, different tree ⇒ different answer.
- **LiteLLM on Windows dies at startup without `PYTHONIOENCODING=utf-8` (2026-07-18).** The proxy's
  startup banner contains non-cp1252 characters, so `show_banner()` raises
  `UnicodeEncodeError: 'charmap' codec can't encode…` and FastAPI reports only
  `Application startup failed. Exiting.` — the encoding cause is buried far up the traceback. Launch with
  `PYTHONIOENCODING=utf-8 PYTHONUTF8=1 litellm --config … --port 4000`. Two adjacent install traps hit the
  same lap: a bare `pip install litellm` lacks the proxy deps (`ImportError: No module named 'backoff'` →
  needs `pip install 'litellm[proxy]'`), and a mismatched `pydantic-core` (2.47.0 vs the required 2.46.4)
  fails the import with a `SystemError` before any of that. Working config:
  `~/.audit-code/litellm-config.yaml`.
- **A retired declaration key fails as a MISSING lane, not a loud error (2026-07-18).** `~/.audit-code/sources-declared.json`
  still carried the retired `repair_proxy` key after the v0.33.7 swap; `auditorSources.ts` rejects it
  correctly and with a good reason, but the reason lands in `dropped[]` and the lived symptom is just
  "the proxy lane is gone". There is deliberately **no back-compat alias**. After any transport-contract
  change, check the machine declaration file — the repo's tests will not catch a stale operator config.

- **`mktemp -d` in the Bash tool returns an msys path (`/tmp/tmp.XXXX`) that `node` cannot resolve — cost two failed repro attempts (2026-07-16).** The Bash tool is Git Bash: `mktemp -d` yields `/tmp/…`, but `node -e "require('/tmp/…/x.json')"` resolves it against the Windows CWD → `Cannot find module 'C:\…\Temp\tmp.XXXX\…'`. Any temp path handed to a **native** tool (node, the packaged CLI, `--root`) must be a Windows-shaped path. Use the session scratchpad dir (an absolute `C:/…` path) instead of `mktemp`. Instance of the OS-agnostic rule biting the agent's own tooling rather than the product's.
- **`llm read` / `llm write` are NIM-backed — `--model` must name a NIM catalog id, NOT `haiku`/a Claude id.**
  `Get-Content x | llm read --model haiku` 404s (`404 page not found`); the backend is an OpenAI-compatible
  NIM endpoint (`llm models` → default `nvidia/nemotron-3-ultra-550b-a55b`). Omit `--model` (auto-select
  works fine) or pass a listed NIM id. Offloading to *Claude Haiku* is a separate lane (Agent tool
  `model: haiku`), unrelated to the `llm` worker CLI. (Hit 2026-07-15.)
- **The Bash tool is POSIX sh, NOT PowerShell — for any multi-line commit/PR body, use a temp file
  (`git commit -F <file>`), never a PowerShell here-string `@'…'@`.** `git commit -m @'…'@` in the Bash
  tool is parsed as literal `@` characters + a bash syntax error at the first `)`, and the commit lands
  with a mangled/truncated message or literal `@` top-and-bottom of the body (recover via
  `git commit --amend -F <file>`). PowerShell here-strings only work in the PowerShell tool. Write the
  message to the scratchpad and `-F` it (single-line messages via `-m "…"` are fine). Applies to every
  native exe called from the Bash tool, not just git. (Hit 2026-07-15, twice in one lap.)

- **After a process restart, `git diff` your instruction files before committing.** A background
  doc-review/hook can silently re-assert a pre-decision version of an instruction doc (e.g. CLAUDE.md,
  `project-philosophy.md`), and `git reflog` won't show it (it's a direct file edit, not a git op). Caught
  once (2026-07-10) by noticing an unexpected `M` in `git status`; restored the committed owner-decided
  version. (The still-open tool fix — reconcile auto-apply against HEAD — lives under *Open bugs*.)

- **npm 12.0.0 (local, since ~2026-07-09) blocks dependency install scripts by default (`allowScripts`).**
  Any child `npm install` of a package with a postinstall (e.g. the audit-tools tarball) silently skips the
  script and warns `install scripts blocked because they are not covered by allowScripts`. The allowlist is
  SPEC-keyed per-project (`npm install-scripts approve <pkg>` writes `allowScripts` into the consumer's
  package.json); the global `.npmrc` `allow-scripts=["audit-tools"]` does NOT cover fresh temp-dir installs,
  and `--allow-scripts=<name>` on the CLI doesn't either. Working escape hatches: env
  `npm_config_dangerously_allow_all_scripts=true` (older npm silently ignores it — used by the packaged
  smokes' hermetic installs) or `npm install-scripts approve <pkg>` post-declare. Also new in npm 12:
  `npm pack --json` can emit an OBJECT keyed by tarball name instead of an array (smokes now tolerate both).
  Global `-g` reinstall of audit-tools bins: postinstall may be blocked → run `npm install-scripts approve
  audit-tools` / re-run postinstall manually and verify `~/.claude/commands/*.md` landed
  (extends [[audit-code-global-bin-traps]]).

- **Before starting ANY lap in a worktree, sync with remote main — landed work may be missing.** A worktree
  can be branched from a *stale* local main and miss commits that already landed on `audit-tools/main`. This
  session branched 4 commits behind and **re-implemented a full commit (admission-control 2a) already on
  main**, plus built 2b blind to a pinned design section it lacked — then had to `git reset --hard
  audit-tools/main` + cherry-pick + reconcile. First action of every lap:
  `rtk git fetch audit-tools main && git log --oneline HEAD..audit-tools/main` — if that lists commits,
  rebase/reset onto main BEFORE writing code. (Strengthens [[audit-tools-worktree-traps]].) **Mitigation
  (not a hard gate):** `.claude/skills/start-lap/SKILL.md` operationalizes this sync-first step as an
  agent instruction — it is agent-instruction-driven, so it reduces the risk but does not mechanically
  enforce the fast-forward the way a git gate would.

- **Background long-running command piped through `tail` hides interim progress.** Running a long command
  in the background as `cmd 2>&1 | tail -N` (e.g. `npm run release:patch:publish 2>&1 | tail -40`) makes the
  output file stay EMPTY until the command exits — `tail` buffers and only flushes its last N lines at EOF.
  To watch progress on a background job, do NOT pipe through `tail`; let the harness capture full output (it
  tails the file for you) or redirect to a file and `tail -f` that file separately. Observed 2026-07-08 during
  a release ship — polled an empty file for minutes before realizing the pipe was the cause.

- **`git push audit-tools HEAD:main` prints a "Changes must be made through a pull request" advisory that is
  NOT a rejection.** On a fast-forward push straight to `main` the remote emits that branch-protection
  message, but the ref still updates (`04a7338c..8279d0de  HEAD -> main`, no `! [remote rejected]`). Confirm
  by `git fetch audit-tools main && git rev-parse audit-tools/main` == local HEAD — don't assume the push
  failed on seeing the advisory. Observed 2026-07-08.

- **New remediate test files must import `makeState` from `tests/remediate/test-helpers.ts`, never re-declare it.**
  `INV-remediate-tests-03` (`tests/remediate/remediate-tests-invariants.test.ts`) fails loudly if any test file
  declares a standalone `makeState`. Wrap the shared helper (`makeState({ plan: {...}, items: {...} })`) instead.
  Observed 2026-07-08 (a new `access-memory.test.ts` tripped it).

- **`tests/audit/audit-code-completion.test.mjs` is the heaviest audit integration test.** It drives the
  full multi-phase audit flow in-process (not subprocess-spawned) with an explicit 300s timeout
  (`HEAVY_AUDIT_TEST_TIMEOUT_MS`) for CPU-contended runs. Confirmed: production does not redundantly
  re-extract on an unchanged repo (extractors are presence-gated, not staleness-checked) — the wall is
  legitimate one-time-per-phase extraction, not a caching bug. Remaining lever (test-side only): pre-seed
  artifacts to cut pump iterations.

- **Codex CLI is a poor executor for large read-heavy audit packets under a wall-clock budget.** Observed
  2026-07-04: 2 concurrent codex executors ran 5+ min with zero results and 8k+ lines of echoed reasoning.
  Route only small / low-line packets to the codex pool, or drop it from the audit executor pool for
  read-heavy work. (Durable routing lesson from the admission-control rework.)

- **Remediate-code worktree branches strand commits off main.** Remediate runs on isolated git worktree branches; landed work accumulates on `remediation/<runId>` and the host is left checked out there. By DEFAULT those branches are never auto-merged — the base branch is left untouched for review. Any doc or code fix applied inside a remediate run never reaches main unless explicitly merged. Effect: the doc-review nightly routine (which reviews main) keeps re-surfacing the same findings indefinitely. **Opt-in fix (B5, shipped):** select the `merge-to-base` closing action at the confirm step — the tool then `--no-ff` merges `remediation/<runId>` into your launch branch at close (aborts safely on conflict). Otherwise, after a run that touches docs/code you want on main, merge `remediation/<runId>` manually before the next nightly run.

- **`.gitignore` artifact-tree re-include structure (don't flatten it).** The managed block ignores the
  `.audit-tools/` runtime tree at the CONTENTS level (`.audit-tools/*`, `.audit-tools/*/*`) and re-includes the
  tracked deliverables + `*/agent-feedback.jsonl` — never as a blanket `.audit-tools/` dir-ignore, because git
  cannot re-include a file under an excluded directory. Private ⇒ deliverables tracked; public ⇒ blanket-ignore.
  Single-sourced in `src/shared/io/gitignoreArtifacts.ts` (`renderGitignoreBlock`), idempotent against the
  committed block. If you ever see deliverables un-trackable, it's a stray blanket `.audit-tools/` line OUTSIDE
  the managed markers — delete it, the managed block owns the tree.
- **Tool-managed ignore patterns for runtime artifact dirs MUST be anchored to `.audit-tools/`**, never a
  bare `**/<name>/` — an unanchored glob (e.g. `**/friction/`) regenerates on every `ensure`/postinstall and
  can shadow a same-named SOURCE dir (`src/shared/friction/`), which a file-level edit can't fix. (`.audit-code/`
  is fine — distinct name, no source collision.)
- **Wall-clock peak-concurrency tests are latency-fragile.** The rolling-driver integration tests assert
  `peak == N` by dispatching N nodes with a short `setTimeout` and reading the max simultaneous in-flight
  count. Any change that adds per-dispatch latency on the dispatch path (e.g. the reservation-ledger's
  reserve-before-dispatch file-lock) can push admission past the delay window so peak reads `< N` on a slow
  FS (Windows), a green-on-Linux / red-on-Windows or intermittent failure. When you touch the dispatch path,
  expect these and either keep the added latency off the hot path (the finite-budget gate that keeps the
  ledger unwired on the claude-code path) or widen the test's delay well past worst-case admission latency.
  (`tests/remediate/rolling-dispatch-file-ownership-ordering.test.ts` §INV-SOO-03/05.)
- **Fresh git worktree lacks `node_modules`** → `audit-tools/shared` resolves a stale `dist/` (spurious
  "no exported member") → run `npm install` in the worktree first.
- **One test runner: vitest** (all three areas — `tests/audit`, `tests/shared`, `tests/remediate`).
  Run a single file with `npx vitest run <path>`. `node:assert/strict`
  is still permitted as an assertion lib (runs under vitest) for the control-flow assertions
  (`assert.throws`/`rejects`/`doesNotThrow`/`doesNotReject`) that have no clean `expect` equivalent; value
  assertions are `expect`. Vitest `testTimeout` is raised to 120s in `vitest.config.ts`
  because audit integration tests spawn real subprocesses.
- **Don't mask the test exit code.** `npm test > out; echo done` reports the *trailing* command's exit, not the
  suite's — and piping through `grep`/`rm` in the same Bash call races the output file, so a real failure reads
  as "green." Capture the suite's own status: `npm test > out 2>&1 && echo PASS || echo "FAIL=$?"`.
- **Global `-g` install defers `postinstall`** (npm allow-scripts) → the host-integration deploy silently
  skips; finish with `npm i -g --allow-scripts=audit-tools` or `node "$(npm root -g)/audit-tools/scripts/postinstall.mjs"`.
- **A global junction to a LIVE working tree silently shadows a registry install.** If the global
  `audit-tools` is a `Junction` → the working tree (from a prior `npm link`), `npm i -g audit-tools`
  does NOT replace it, and bins run your working-tree dist; invoking a bin *through* the junction path
  can also produce odd artifacts. Fix: `npm rm -g audit-tools` FIRST, then reinstall, and verify
  `(Get-Item <globaldir>).LinkType` is empty before trusting the smoke. (See [[audit-code-global-bin-traps]].)
- **A NEW `.claude/hooks/*.mjs` needs an explicit `!.claude/hooks/<name>` re-include in `.gitignore`.**
  `.gitignore` ignores `.claude/hooks/*` then allowlists each tracked hook by name (deliberate — never ship
  arbitrary `.claude` files). Adding a hook and committing WITHOUT the `!` exception silently drops the file
  from the commit; if `.claude/settings.json` (committed) references it, main now points at an untracked hook
  = broken state. Add the `!.claude/hooks/<name>` line in the same commit as the hook + its settings.json
  registration. (Bit once 2026-07-05: `friction-stop-gate.mjs`.)

- **A `\0` in a Write-tool template literal lands as a RAW NUL byte → binary-flags the source file.** Writing
  `` `${a}\0${b}` `` (a NUL pair-key separator) via the Write tool put a literal 0x00 in the `.ts` source, so git
  treated it as **binary** (`git diff` shows `Bin`/`- -`, grep-hostile) even though tsc/vitest read it fine. Same
  for an in-comment control char. Detect with `python -c "print(open(p,'rb').read().count(0))"`; fix by using a
  text-safe escape that stays a source escape (`U+001F` unit separator) or a printable delimiter. Never embed a
  raw control byte in source — prefer a `\uXXXX` escape the compiler resolves at runtime. (Bit once 2026-07-05:
  `src/shared/decompose/consensus.ts` pairKey.)
- **The Bash tool mangles Windows backslash paths** (`C:\a\b` → `C:ab`) → use forward slashes or the
  PowerShell tool for absolute-path commands.
- **PowerShell**: assign `foreach` output to a var before piping to `ConvertTo-Json`; `-Filter` is not regex
  (use `Where-Object -match`); single-element arrays unwrap in `ConvertTo-Json` (bracket-wrap the payload).
- **Packaged/global-install drift is caught ONLY by `smoke:packaged-*` (`verify:release`), never by dev or
  vitest — so it fails the release gate loudly, not silently.** Two ways to break the tarball that pass every
  local check: (1) a production runtime `import` declared as a `devDependency` — devDeps are present in dev +
  the vitest suite, so only the packaged smoke hits `ERR_MODULE_NOT_FOUND` (when you add an `import` to any
  `src/` module that lands in `dist/` on a production path, confirm the package is under `dependencies`; bit
  once 2026-07-04 by `zod-to-json-schema` in `src/audit/contracts/workerSchemas.ts`); (2) deleting a *shipped*
  file that the smoke's `requiredPackagedPaths` list asserts (`scripts/audit/smoke-packaged-audit-code.mjs`,
  `verify-hosts.mjs`) → the gate fails on the missing tarball path. Diagnostic, not a silent trap: if
  `smoke:packaged` errors on a missing/absent module or path, this is why.
- **Async typecheck hook = stale-dist false alarm** after a shared-source edit (it runs `tsc` before the
  central rebuild); the authoritative gate is `npm run check` after `npm run build`.
- **Prefer a dependency-injection seam over module mocking** in tests. Under vitest, `vi.spyOn`/`vi.mock`
  and fake timers (`vi.useFakeTimers({ toFake: [...] })`) are available, but the codebase's established
  pattern is injectable deps (`WorkerRunDeps`, `createWriteStream`/`spawn` seams) — keep using those.
- **Front-load a broad "does this already exist" sweep BEFORE authoring goal_spec/context_bundle/
  module_decomposition, not just a targeted one.** A narrow Explore before contract authoring is the top
  repair-round-churn driver — search the WHOLE repo for equivalent logic AND independently re-verify the
  target symbol's own type/shape against source at least once per contract. The cost of one broader Explore
  call or one grep is far lower than a full adversarial repair round or an implement-time revert.
  [[front-load-broad-search-before-contract-authoring]]
- **Don't fan out a large mechanical edit across parallel subagents that spawn their OWN grandchildren.**
  For a broad mechanical sweep over a shared file set, run it as ONE serial agent (or partition by
  NON-overlapping files), never an uncoordinated fan-out; and never hand-edit the same files while a
  background agent is live on them.
- **`rtk` compresses files you need verbatim.** When reading the `audit-code` skill body or `docs/backlog.md`
  through `rtk read`, content gets partially summarized with retrieval hashes → not exact. For any file you must
  act on verbatim, use raw `Get-Content -Raw` (or the Read tool), not `rtk read`.
- **`rtk proxy` runs executables, not PowerShell cmdlets.** `rtk proxy Get-Content` / `rtk proxy Get-ChildItem`
  fail (cmdlets aren't standalone exes). Working form: `rtk proxy powershell -NoProfile -Command "..."`.
- **`rtk proxy rg` fails with `Access is denied`** (Codex/win32). Fallback: PowerShell `Select-String` (or the
  Grep tool).
- **Never pass `isolation: "worktree"` to the Agent tool when dispatching a remediate-code/audit-code implement
  node.** The tool's own dispatch plan already creates and names the node's worktree; adding the Agent tool's
  OWN `isolation: "worktree"` spawns a second, unrelated git worktree and the subagent edits source files there
  instead of the tool-designated one — `accept-node`'s cherry-pick then sees no diff.
  [[no-agent-isolation-worktree-for-dispatch-nodes]]
- **No host-side unblock for a wedged audit run — use `audit-code force-synthesis`.** Host-side attempts to
  unblock a stuck audit (pending tasks that won't clear) do NOT work and actively corrupt gitignored
  run-state: marking `status:complete` in `audit_tasks.json` is ignored; writing
  `partial_completion_terminal.stranded_ids` is overwritten; appending results with unique idempotency keys
  clears the obligation but cascades stale `planning_artifacts`. The only clean recovery is the tool-owned
  affordance — `audit-code force-synthesis` stamps an `operator_forced` partial-completion terminal over the
  pending task ids (durable direct write to `active-dispatch.json`, the special-loaded artifact
  `writeCoreArtifacts` doesn't own) and drives the synthesis executor from the intact ledger on partial
  coverage, with no hand-editing of gitignored run-state. (`src/audit/cli/forceSynthesisCommand.ts`;
  `buildOperatorForcedTerminal` in shared; e2e in `tests/audit/audit-code-completion.test.mjs`.)
