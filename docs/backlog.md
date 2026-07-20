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

## Open bugs / frictions — fix in tooling (never "host remembers")

- **⚠ THE LOOP-CORE ATTESTATION GATE IS BYPASSED BY THE COMMIT PATTERN `CLAUDE.md` ITSELF RECOMMENDS (2026-07-19, HIGH, verified by execution).** `.claude/hooks/pre-commit-gate.mjs:213` reads the staged set with `git diff --cached --name-only`, and the loop-core branch keys off it (`:256` `staged.some(pinsLoopCore)`). But the hook is **PreToolUse** — it runs *before* the Bash command does. So a single chained call `git add -A && git commit -m …` is inspected when **nothing is staged yet**: `staged` is empty, `staged.some(pinsLoopCore)` is false, and the attestation gate silently no-ops. **`CLAUDE.md`'s own RTK section documents exactly this chained form** (`rtk git add . && rtk git commit -m "msg" && rtk git push`), so the project's recommended workflow disables its highest-blast-radius gate. **Verified by execution, not by reading:** commit `refactor(identity): rename DispatchableSource.provider -> transport` staged `src/shared/quota/{apiPool,accountId,compositeQuotaSource}.ts` — all three under the loop-core prefix `src/shared/quota/` — and committed with no attestation demanded and none on disk. This is the *enforce-in-tooling-never-host-discretion* invariant failing on its own terms: the gate works only if the host happens to `git add` in a separate call, which is precisely the "works because the host remembered" shape the rule forbids. **Candidate fixes:** parse the tool's command string for a `git add`/`git commit` chain and stage-simulate; or move the loop-core check to a real `.git/hooks/pre-commit` (runs after staging, no PreToolUse race); or have the gate fail-closed when it sees a commit chained after a stage in one command. The doc-contract subset check (`:209-248`) keys off the same `staged` list and is bypassed identically.
  **Second, independent defect in the same hook — the bypass-flag detector false-positives on unrelated commands.** It scans the whole Bash command string for `-n`, so an ordinary `grep -n pattern file` is rejected with "commit rejected — hook-bypass flag detected (`--no-verify`/`-n`)". Hit while reading the hook itself. The detector must scope to the `git commit` argv, not the entire command line.
- **`tests/audit/linux-cycle-regression.test.mjs` fails under full-suite load but passes alone (2026-07-19, low, hermeticity).** ~30s alone; exceeds the 120s `testTimeout` when the whole suite runs in parallel. Per the test-failure protocol this is a hermeticity/load bug in the test, not a regression — it needs an explicit longer timeout or isolation from the parallel pool, not a code fix. Noted because a full-suite run currently reports "1 failed" and that failure is this, every time.

- **The nightly doc-review's green gate referenced a dead workspace, so it may have been escalating instead of applying (2026-07-19, low, CHECK THE CONSEQUENCE).** The routine's gate was `npm run build -w @audit-tools/shared && npm run build && npm run check`. That workspace has not existed since the single-package collapse, and the clauses are `&&`-chained, so the gate failed before ever reaching `npm run check` — and the routine's own step says a failed gate means escalate rather than push. Fixed in [`doc-review-routine-prompt.md`](doc-review-routine-prompt.md) (the prompt is now versioned there rather than living only in the scheduler). **Residue to check:** `doc-review-findings.md` on the `doc-review` branch may hold a backlog of stale-factual fixes that were escalated but never applied — worth one look before assuming the doc set is current. Same pass also fixed a hardcoded `git fetch origin`: this checkout's remote is `audit-tools` (no `origin`), a fresh clone's is `origin`, so the line was correct for exactly one environment and a failed fetch would silently review a stale tree.
- **A proxied lane is PRICED by its transport, so cost-first routing ranks it on the wrong vendor's price (2026-07-19, VERIFIED by mechanism, medium).** `annotateConfirmedPool` prices a source with `resolveModelPrice(source.model, source.provider)` (`src/shared/providers/providerConfirmation.ts`, the `source_pool_cost_order` build) — the TRANSPORT — while `source.backend_provider` sits on the same object. `resolveModelStatics` looks the second arg up as `snapshot.byProvider[provider]`, a models.dev **vendor**-keyed table (`src/shared/quota/modelStatics.ts:142-149`); `claude-worker` is not a vendor, so the lookup misses and falls through to `lookupInTable(snapshot.default, modelId)` — the cheapest-collision default. A proxied lane is therefore priced as whichever vendor sells that model id cheapest, not as the vendor actually serving it. **It fails QUIET** — no missing-price signal, just a wrong number — and it feeds rung 2 of `costRank`, i.e. the DEFAULT cost-first operating point (λ=0), so it can mis-order which pool routes first.
  **AXIS FIXED 2026-07-19** — both sites (`providerConfirmation.ts` `CostCandidate` build + the `source_pool_cost_order` price) now pass `sourceService(source)`. **⚠ Correcting this entry's own "VERIFIED" claim: the defect is INERT at HEAD and always has been.** The vendored snapshot `src/shared/data/model-statics.generated.json` carries **no `__by_provider` key at all** (2630 models, zero provider tables), and the generator emits that index only when a cross-provider collision populates it (`scripts/shared/update-models.mjs:160-162`). With no provider tables, `resolveModelStatics` returns the same default entry for *every* provider string — so transport-vs-service could not change any price. The fix is correct-axis and becomes load-bearing the moment the snapshot gains an index; it is **not** red-green testable until then (no snapshot-injection seam), and was landed without a test deliberately rather than with a decorative one. Record: [`identity-migration-stage1-plan-2026-07-19.md`](reviews/identity-migration-stage1-plan-2026-07-19.md) §3.
- **LEAD (not a verdict): the price snapshot reports ZERO cross-provider collisions, which is surprising (2026-07-19, low).** `model-statics.generated.json` has 2630 model entries and no `__by_provider` index, meaning the last generation run found no model id served by two vendors. Upstream models.dev carries `claude-*`/`gpt-*`-class ids on multiple vendors (native + bedrock + vertex, etc.), so zero collisions suggests either the collision detection in `flatten()` is not firing or models.dev's response shape changed under it. **Consequence if real:** the entire provider-scoped price path (`snapshot.byProvider`) is dead code, every price is the flat default, and the service-vs-transport axis fix above stays inert forever. Settle by re-running `scripts/shared/update-models.mjs` against live models.dev and inspecting the reported collision count before assuming either way.
  **The tell that this is the axis-confusion class, not a one-off:** ten lines apart in one file, `resolveSourceContextWindowTokens` calls the SAME helper correctly — `resolveModelStatics(source.model, source.backend_provider ?? source.provider)` (`src/shared/quota/apiPool.ts:96-98`). Same subsystem, same helper, two different answers to "which axis is this?". Found by the classification pass behind [`spec/backend-identity-axes.md`](../spec/backend-identity-axes.md).
  **Fix:** pass `backend_provider ?? provider` at the pricing site. **Still to audit (same class, not yet confirmed):** `costRank.ts` rungs at the `resolveModelPrice(input.model, input.provider)` / `(c.model, c.provider)` sites are generic — correctness depends on what each CALLER puts in `CostCandidate.provider` / `CostRankInput.provider`. Host candidates deliberately omit it (correct — the cheapest-collision default is intended). Audit the source-candidate construction before changing those two.
  ⚠ Do NOT sweep `deriveLocalAccountId`'s `source.provider !== "openai-compatible"` check (`src/shared/quota/accountId.ts`) into this fix: it was flagged as the same class and does NOT survive mechanism review. It is really asking "is this a direct API source carrying its OWN credential?", which is transport-shaped — a proxied lane's `api_key_env` is the proxy master key, shared across every backend behind it, so declining to derive a per-vendor account there is correct.
- **CLAUDE.md overstates the `admitSpawn` consent gate (2026-07-19).** *Own-vs-acquire analyzer
  engine* states every acquired-tool spawn "routes through the single `admitSpawn` chokepoint and
  requires the per-run `ExternalAcquisitionConfig.consent_token`." Verified against HEAD:
  `defaultRun` **bypasses** the token requirement — only non-default tools require it
  (`src/audit/extractors/analyzers/acquisitionEngine.ts:216-224`); `admitSpawn` is at `:304,:478`.
  SPEC: decide which is the intended invariant, then make doc and code agree — either the curated
  default set is legitimately exempt (say so explicitly in CLAUDE.md, since "every spawn requires the
  token" is currently false) or `defaultRun` must also pass through the token check. Surfaced by the
  memory-consolidation verification pass, `docs/reviews/memory-consolidation-2026-07-19.md`.

- **Memory/doc claims of "open item" decay exactly like backlog prose (2026-07-19).** The memory
  consolidation found a memory listing 4 open items of which 3 were long done (audit's symmetric
  `runRollingDispatch` wiring, INV-QD-14 spill, `rate_limited` handling). Same class as
  [[backlog-prose-decays-verify-against-head]] but in the memory store, where nothing ever forces a
  re-read. SPEC: treat any "open"/"remaining"/"TODO" claim in a memory or spec as a LEAD requiring a
  HEAD check before it becomes work — never as a work order. No tooling fix proposed yet; if this
  recurs, the mechanical form is a lint that greps memory/spec for open-item phrasing and reports
  the ones whose named symbols now exist.

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
  Two more symptoms of the same root, worth knowing because each costs time on its own: (a) making a
  field required *because omission is a defect* enforces nothing in tests — the compiler correctly
  sweeps production call sites while every test call site silently keeps getting `undefined`, so a
  green suite reads as "every call site swept" when it cannot be; (b) a large `Edit` that breaks brace
  balance in a `.test.mjs` is invisible to the typecheck and surfaces only as vitest failing to
  transform the whole FILE — one opaque "Failed Suites" entry naming no test, masking every real
  assertion in it. Candidate mechanisms: a `tsconfig.test.json` wired into `verify:checks`, or
  `vitest --typecheck`.

- **SPEC — delete inline `api_key` support; a credential must be named, never pasted.** Account identity
  compares `(endpoint, credential REFERENCE)`, so a source naming its key through an env var and a
  sibling pasting that same key inline resolve to two accounts and each meters a full allowance — a 2×
  over-admission of the main metering defect's class. Hashing the credential VALUE to unify them is
  refused on purpose: identity would then change on every key rotation, orphaning ledger state and
  learned slopes for what is still one account. An explicit operator-declared `account` on both siblings
  already overrides the derivation and unifies them, but that is a workaround the operator must know to
  apply — the wrong thing stays possible.
  **The resolution is to remove the second way of expressing a credential.** Inline `api_key` is already
  documented as discouraged, there are no external consumers, and under the no-legacy rule a discouraged
  duplicate path is simply deleted rather than defended. With one representation, two references to one
  credential cannot disagree — the defect becomes unrepresentable rather than detected.
  **Property to hold:** a credential is identified by reference only, and there is exactly one way to
  declare one. Secrets also stop landing in declaration files as a side effect.

- **Review rounds re-derive the same file map every time (inefficient-feeding, 2026-07-19).** Step 2
  ran 4 adversarial rounds; each spawned FRESH agents that re-grepped the same `tokens_per_pct` /
  `admit` / `reconcile` call-site map from scratch (~135k subagent tokens per round, much of it
  identical recon). Continuing a prior reviewer preserves its context but forfeits independence,
  which is the whole point of the round — so the two goals are in tension and the fix is not "reuse
  the agent". **Property to hold:** a review round receives the verified call-site map as INPUT
  (cheap, mechanical, produced once) and spends its budget on judgment, not rediscovery — while still
  reaching its own verdict.
  **SPEC — the tension is false: it conflates independence of VERDICT with independence of INPUT.** What
  a review round must not do is judge work it authored. Being handed a factual call-site map it did not
  produce does not compromise that — the agent is still fresh and the verdict is still its own. Re-deriving
  the map from scratch was never carrying independence; it was carrying redundant derivation, and paying
  ~135k tokens per round for it.
  **Resolution:** the verified map is a read-only, provenanced input artifact. Each round receives it
  labelled as prior verified recon it did not author, and cannot write back to it — updates go through a
  separate recon step, so the map cannot silently absorb a reviewer's assumptions and then be handed to
  the next reviewer as fact. Rounds spend their budget on judgment.
  **Property to hold:** no review round re-derives a mechanical fact another round already established,
  and no round judges anything it authored. ⚠ Sharing an agent SESSION across rounds is the wrong version
  of this and forfeits exactly what the round is for.

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
  **SPEC — a contract violation needs its own ERROR CLASS, not another assert at another site.** The
  revert was correct and its lesson is that WHERE the check runs is not the problem: every production
  caller wraps the probe in a catch that converts any throw into a degraded status, so an assert
  anywhere inside that boundary is swallowed into a quiet degraded pool — the loudest possible bug
  becomes the quietest possible symptom. Adding a third assert site repeats it.
  The distinction the code cannot currently express is **"the remote is unreachable" versus "the
  producer emitted something structurally invalid."** The first is expected and degrades; the second is
  a bug and must surface.
  **Return the violation IN-BAND as a typed failure result rather than throwing.** A distinct error class
  that every degrade-catch agrees to re-throw would also work, but it stays vulnerable to the same defect
  one refactor later — it relies on each catch site continuing to make an exception for it, which is the
  remember-to-be-careful shape this project rejects. A typed result cannot be swallowed by a catch at all,
  because it never travels as an exception: a caller must handle the variant to compile, and a scope
  violation stops being confusable with a network degrade by construction rather than by convention.
  Producer validation can then live wherever is most natural, including on paths that bypass the probe
  entirely — which is why "safe by construction at one boundary" was never achievable here.
  **Property to hold:** a structurally invalid producer emission is always loud and never presents as a
  network degrade. ⚠ The persisted read path must still skip-and-warn rather than throw — old artifacts
  predate the field, and refusing to load them would turn a historical gap into an outage.

- **`AdmissionGrant.resource_key` becomes partial under multi-constraint (2026-07-19).** Now that
  `reconcile(leaseId)` sweeps every key, this field has no reader — it is diagnostic provenance. Once
  steps 3–4 supply N constraints it will record one of N while looking authoritative. **Property to
  hold:** the artifact either records every key the lease was taken against, or does not record one
  at all. Documented in place at `admissionLoop.ts`.

- **An uncalibrated pool must reach the cold-start probe path, not be waved through (unpinned).** The
  ledger treats a non-finite budget as unbounded by design — an optimistic start that the reactive 429
  floor corrects. So whether a pool that cannot price a constraint reaches dispatch at all is decided in
  budget derivation and admission wiring, not in the ledger. The standing constraint is stated in the
  design of record but is pinned nowhere except a test comment. **Property to hold:** a pool with no
  calibration is probed, not admitted at full width.

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

- **A per-site pinning gate would make "red-green validated" mechanically checkable — UNBUILT on main.**
  The idea: revert each site of a change individually and require each reversion to turn the suite red,
  so "every changed site is pinned by a test" stops being a claim the author makes about their own work.
  A prototype existed on an unmerged branch and an independent review found the shape that makes a naive
  version worthless: measuring *"the suite went red"* rather than *"a test asserting THIS behavior went
  red"* passes trivially — renaming an export so importers crash turns 71 tests red and reads as PINNED.
  That is the same fail-open the tool exists to catch, relocated one level up. A hand-written site list
  has the mirror problem: it is silently a subset, so "all N sites pinned" is literally true and
  materially misleading whenever the omitted hunks are the ones carrying the fix's core claim.
  **Properties to hold:** each spec site binds to the NAME(s) of the test(s) expected to fail, and the
  site list is DERIVED from the diff so an omitted hunk is impossible. Until both hold, no such gate's
  output is admissible as attestation evidence.

- **⚠ Two concurrent `vitest run` invocations corrupt each other's results (2026-07-19, medium,
  friction: inefficient-feeding).** Running a targeted suite while a full-suite run was still going in
  the background produced 61 failures across 6 files in areas the diff never touched
  (`inferRepairTarget`, `archiveContractArtifact`); both areas passed cleanly on a serial re-run, twice.
  The tests share on-disk fixture dirs under `tests/remediate/.test-*`, so concurrent runs race. This
  cost a full stash-and-baseline cycle to attribute, and would read as a damning regression to anyone
  who did not re-run serially. **Property to hold:** either test fixture dirs are per-invocation
  (`AUDIT_CODE_STATE_DIR`-style, per [[state-dir-env-override-hermeticity]]) or a second concurrent
  vitest refuses to start. Same family as the other three known full-suite-only failures.

- **The COOLDOWN axis of account metering was never migrated — budget and cooldown now derive account
  identity two different ways (HIGH, loop-core).** The budget axis is closed: account identity is
  resolved once at pool construction and carried on the wire as a required field every consumer reads,
  so pools sharing one credential share one budget. The cooldown fold did NOT move with it. Both fold
  sites still gate on the older local derivation, which returns null unless the source is
  `openai-compatible` **and** names its credential through an env var **and** carries no explicit
  account override. So a 429 learned on one model still fails to throttle its siblings for exactly the
  cases that motivated the original fix: a source pasting its credential inline, and any proxy-fronted
  source (those are `claude-worker`, not `openai-compatible`). Verified by reading both fold sites and
  the derivation, not inferred.
  **Property to hold:** budget and cooldown partition an account the SAME way — one derivation, one
  answer. Two mechanisms answering "which account is this?" differently is the defect, independent of
  which answer is right.
  ⚠ The in-flight-cap axis is deliberately NOT part of this: the concurrency cap is documented as a
  per-ENDPOINT limit, and an earlier attempt to make it per-account was correctly reverted.
  ⚠ Do not "fix" this by deleting the `openai-compatible` guard — an independent review caught that
  doing so keys identity on the TRANSPORT, collapsing every backend behind one proxy into a single
  cooldown account so a free-lane 429 stalls a paid lane. That is an over-merge worse than the bug, and
  against the standing rule that the transport never enters the quota identity.
  **The durable lesson from the five refused rounds:** every partition — window scope, account identity
  — is decided by the PRODUCER that knows it and carried on the wire. Each refused round re-derived one
  of them at the CONSUMER from pool identity, which is why each was a guess.
  [[account-metering-closed-producer-decides-partition]] [[fix-the-defect-class-not-the-named-instance]]

- **Nothing derives "collapse a shared-budget roster to its best member" (low).** The selection rule
  itself is settled and already falls out of the cost-first comparator: a free pool's costs all tie so
  capability decides, and a metered pool sorts on price with the capability floor gating eligibility.
  What is missing is that the operator still expresses the collapse by hand as a `top_k: 1` on the
  proxy declaration. **Property to hold:** when several models share one budget, restricting the roster
  to the member that best serves the work is derived, not hand-declared.

- **SPEC — the proxy catalog's freshness rule gates the WRITE but not the READ, and the lane has no
  operator-runnable refresh.** A day-old cache whose roster no longer matched the running proxy was
  served silently, and deleting the cache dropped the whole proxy lane with a reason naming an internal
  FUNCTION rather than any command the operator could run. ⚠ Correcting this entry's earlier claim that
  there is "no TTL": a 10-minute TTL DOES exist, but it only decides whether the populate step re-fetches.
  The read path deliberately accepts cached data of any age. So the freshness concept is present and
  applied on exactly the wrong side.
  **Two properties to hold:** (a) the age rule applies where staleness does damage — the read path either
  revalidates against the live roster or surfaces the cache's age rather than presenting stale data as
  current; (b) every drop reason names an action the operator can actually take, which requires that such
  an action EXIST — today no populate/refresh command is reachable from the CLI at all, so the reason has
  nothing true to name. Fix the missing command first; the reason text is downstream of it.
  Same family as the `dropped[]`-not-surfaced entry below.

- **`top_k` truncates ALPHABETICALLY when nothing is ranked, silently dropping the frontier tier
  (2026-07-19, medium, now mitigable).** With all `score` undefined, `expandSources`
  (`proxyCatalog.ts:327-335`) falls through to `a.alias.localeCompare(b.alias)` — so `top_k: 3` over
  the NIM roster kept a *flash* model and dropped every frontier one. Mechanism (3) of the
  unranked+free composition entry, now observed directly. **Mitigated** now that
  `model_info.capability_rank` is populated (see below), but the fallback remains
  silently-wrong-by-default for any unranked proxy. **Property to hold:** truncating a roster with no
  ranking signal must be loud, not alphabetical.

- **A DEADLINE should drive λ, not become another dial (needs live data first).** "Finish within an
  hour" is a CONSTRAINT rather than a preference, so it belongs as something that drives λ from observed
  progress, **not as another operator knob** (a needed manual flag is a bug signal — λ, "how much will I
  pay to finish sooner", is already the right tradeoff). **Do not build it until a real wave shows the
  shape** — the right control law is not derivable from a guess. ⚠ An earlier version of this entry
  claimed the measurement half had shipped, naming two functions that do not exist; throughput is
  derived from concurrency alone today, so what "observed progress" would even read from is itself
  undecided.
  **SPEC — instrument now, derive the control law later, never guess it.** Three states are possible and
  only one is acceptable. A manual deadline knob is a bug signal. A guessed controller wired into the dial
  is WORSE than the knob — it hunts and overshoots under live pressure with no dataset to debug against.
  The right intermediate is neither: ship a passive observer recording elapsed time, measured throughput,
  and progress-to-completion per run, and let a deadline act only as a hard stop with a persisted trace.
  The dial stays open-loop. Once real traces exist, fit the law offline, validate it against held-out
  runs, and only then close the loop.
  **Property to hold:** no control law reaches the dial before it has been fitted to measured runs and
  validated — and the absence of a law is never filled by an operator knob in the meantime.
  Adjacent, same family: [[quota-before-cost-ordering]] (Gate-0 suggests cost order on
  $/Mtok alone, never demoting a quota-saturated pool).

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
  **SPEC — record the attester's CLASS and stop claiming a human.** A gate running on the same machine as
  the agent cannot establish humanity: any credential it could check is a credential the agent can reach,
  so a cryptographic scheme would prove key possession, not a human. Chasing enforcement here buys
  ceremony, not assurance. The honest and useful artifact is an **attributable, tree-bound audit record**,
  and the fix is to make the record carry what actually happened — the attester's class (agent or human)
  and the reviewing identities — so it is greppable after the fact and a later policy can require human
  sign-off for a named subset if that ever earns its cost. Then correct the documentation to describe the
  record rather than a guarantee it does not provide. ⚠ The doc overstating the mechanism is the live
  defect: it makes a weaker control read as a strong one, which is worse than the control being weak.

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
  **SPEC — key on DESTINATION.** The gate's job is protecting what lands, not policing what is written
  down. Preserving review-blocked work on a branch that cannot reach main is exactly the behavior the
  project wants and it should be the frictionless path; only a commit that can reach main earns the
  strictness. Concretely: a `concerns` verdict is accepted without an override when the commit cannot
  land (not on the main branch, or the tree is explicitly marked do-not-merge), and the current bar
  applies unchanged on main. **The override must stay rare to stay meaningful** — a gate whose honest
  path requires an override trains the override into a reflex, and then it signals nothing, which costs
  more than the gate was ever worth.

- **Capability-evidence obligation — REVIEW-BLOCKED across four rounds, all of it on the unmerged
  branch `wip/capability-evidence`; NONE of it is on main (high).** A pool with no capability evidence
  must be pinned down — by LLM judgment or by asking the operator — never silently routed around.
  Implemented and green, but three independent adversarial lenses refused sign-off. Full record:
  [`docs/reviews/capability-evidence-implementation-review-2026-07-18.md`](reviews/capability-evidence-implementation-review-2026-07-18.md).
  ⚠ Because the branch is not an ancestor of main, every symbol it introduces is absent from HEAD —
  entries describing them as defects in shipped code are describing branch code.
  **SPEC — the open defects are ONE defect, and must be fixed as one.** Every blocking issue is a
  HAND-MAINTAINED ENUMERATION that drifted from its source of truth. The parser reconstructs the
  confirmation field-by-field, so a field nobody listed is silently dropped — its own comment states
  the hazard as if it were the mitigation ("any future field needs a line here"), which is precisely the
  host-must-remember pattern this project forbids. The prompt's JSON example is authored separately from
  the shape the parser accepts, so the two drift. A capability-rank parameter is optional, so the
  compiler never enumerates its call sites and one draw silently fails open. Fixing the current CONTENTS
  of these lists is what rounds 1–4 each did; each fix closed the named instance and its siblings
  reappeared elsewhere.
  **Fix by DERIVING each enumeration, so omission becomes impossible:**
  (1) drive the parser from a single field-descriptor table (name + validator) rather than field-by-field
  reconstruction, so adding a field to the type forces a table entry instead of relying on a comment;
  (2) INVERT the write path — merge the submission into the persisted confirmation instead of rebuilding
  the artifact from the submission. Then a field nobody enumerated is carried by construction, and
  answering one question can no longer destroy the answer to a different one;
  (3) GENERATE the prompt's JSON example from that same descriptor table, so it cannot omit a required
  field or lack a field the operator is being asked to fill;
  (4) make the capability-rank parameter REQUIRED at every wave-scheduling entry point, so the compiler
  enumerates the sites. ⚠ Required-ness only sweeps production callers while the test tree is
  untypechecked, so pair it with a runtime guard or the enforcement is half-real;
  (5) an operator must be able to REPOSITION an already-ranked model without restating the entire roster.
  Anchored insertion treats every previously-ranked id as a fixed anchor, so models can be added anywhere
  but one already ranked can never be demoted — the likeliest follow-up action, since the point of
  operator ranking is that judgment improves with use. Distinguish a TOOL-OFFERED anchor (a genuine fixed
  reference point) from any other previously-ranked model the operator chose to mention; the latter gets
  the same interpolation new models get. Needs no new field;
  (6) the delta computation whose failure mode is a LIVELOCK must be reachable by a test. The
  model-less-pool skip — the property preventing an unpinnable pool from wedging the first obligation
  forever — is module-private in a CLI command and untested, and the one test claiming to cover
  convergence is tautological. It belongs in shared beside the other confirmation readers.
  ⚠ Verify the defect list against the branch before budgeting: the explicit-empty-roster case appears
  already fixed there (an explicit empty roster survives the parser), so the record may overstate what
  is open.
  ⚠ The generalizable lesson: fixing the named instance is not fixing the defect class — especially for a
  fail-open mechanism, where an unwired site is indistinguishable from a working one.

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
- **The vitest false-green defect has recurred at least 6 times — `vitest run` exits 0 while reporting N failed.** Caught only by reading the summary line, never the exit code; it has let a deterministic bug reach release CI, which then caught it in a shard. Both standing fixes remain unbuilt: (1) the local gate must fail-nonzero on ANY reported failure count; (2) the vitest timing ledger must record pass/fail outcome + failed file names, not just cost (`vitest-timing-reporter.mjs`) — without it, a run whose console output gets clipped is unrecoverable and costs a full re-run. ⚠ **And do not work around it by grepping vitest's prose**: matching `/failed/` over the output hit the string "fail-closed" *in test names* and reported a non-existent flake, and `/(\d+) passed/` catches "Test Files 1 passed" before "Tests 12 passed". The prose contains arbitrary author-chosen test names by construction, so any keyword match over it is unsound — which is exactly why the outcome belongs in the ledger as data.
- **A delegated implementer embedded a RAW 0x00 byte in source (H2+H4 lap 2026-07-18, tool-should-decide, low-medium).** A subagent writing `rollingDispatch.ts` used a literal NUL character as a template-literal dedup-key separator — tsc compiles it happily, but the file turns BINARY to grep/Grep/rg (silently zero search results — a wiring-pass grep returned "no matches" on code that existed, initially reading as unwired enforcement). Fixed by replacing with the `backslash-u0000` escape. Property to hold: a post-write guard (hook or check) rejects raw control bytes (< 0x20 except \t\n\r) in source files; same family as the CRLF-rewrite trap. Cheap mitigation until then: when a grep over a just-edited file returns nothing or "binary file matches", scan for control bytes before concluding anything.
- **Non-hermetic test: `tests/audit/quota-command.test.mjs` "nothing is written to disk" reads the box's real `.audit-tools/audit/session-config.json` (2026-07-18, low).** A leftover gitignored local artifact makes the test fail on a clean checkout of main; it presents as a regression from whatever diff is in flight. Property: the test must resolve repo-root state through the `AUDIT_CODE_STATE_DIR` hermeticity override like its neighbours, never the real repo path. Same box-dependence family as `INV-shared-core-14`.
- **Pre-existing back-compat fold survives, now against standing policy (2026-07-18, low).** `src/shared/quota/apiPool.ts` (~370-371, ~497-498) and `src/shared/types/sessionConfig.ts` (~700-701) fold in a "legacy `openai_compatible` block ... for back-compat". Deliberately kept OUT of the swap commit to preserve the atomic replace. Property: under the owner's no-legacy rule this fold should be deleted and the block treated as a plain source declaration.

- **"The free model can't handle reasoning work" is a MYTH built from unset request parameters — check
  `finish_reason` before diagnosing a model (friction: tool-should-decide, medium-high).** Two apparent
  capability failures in one session, both traced to the caller:
  (a) asked to enumerate defects in a 94-line review record under `strict: true` with a generic
  `{summary, findings[], open_questions[]}` shape, the lane returned schema-VALID output whose every
  finding was the literal string `FAILED_TO_EXTRACT`. Cause: constrained decoding into a container that
  cannot hold the answer. The same model, same document, given a schema shaped to the task (an array of
  typed defect records) with `strict` off, produced a correct classification matching an independent hand
  analysis. The tell was present in the bad run — the summary was accurate and every defect id was named,
  so comprehension was never in question, only the container;
  (b) a 12-item batch returned 5 items with the last one degenerating into nonsense tokens, which read as
  the model falling apart under load. Measured cause: `finish_reason=length`, `completion_tokens=1024` —
  **no `max_tokens` was ever set**, so a default cap truncated the array mid-flight and the "gibberish"
  was the model closing valid JSON against the wall.
  **Properties to hold:** (i) an offload caller sets `max_tokens` deliberately and treats
  `finish_reason !== "stop"` as a failure, not a result — neither of these misdiagnoses survives one line
  of response inspection; (ii) the output schema is part of the prompt, not packaging, and `strict: true`
  is a quality risk to justify rather than a safe default; (iii) a structurally-conformant response with
  placeholder or missing content is a failure wearing a success shape and must be detectable as such.
  ⚠ **Re-examine the inherited belief before acting on it.** Earlier records of this lane "timing out past
  120s" and "not matching its own read schema" came from a retired wrapper with a hardcoded timeout and a
  single fixed schema — the same two failure classes. The standing assumption that reasoning-heavy work
  cannot be offloaded here shaped routing decisions and is not currently supported by evidence.

- **`docs/backlog.md` exceeds a single-read budget, so every pass navigates it blind (friction:
  inefficient-feeding, medium).** At ~1,100–1,450 lines it cannot be read in one call (>25k tokens), so
  working on it means paged reads plus grep-by-anchor, and line numbers shift under every edit. Two
  concrete costs this session: a scripted delete keyed on line numbers orphaned a fragment (see the trap
  below), and several edits needed a re-grep purely because earlier edits had moved everything. The file
  is also the one document most likely to be scanned by an agent with no prior context.
  **Property to hold:** the open-work record is navigable in bounded reads — most plausibly by splitting
  along the section boundaries that already exist (open bugs / forward tracks / deferred / durable traps),
  since those are already how it is read. ⚠ Do not solve it by pruning aggressively: the entries earn
  their length, and the 2026-07-19 classification showed the risk runs the other way — stale entries
  survive because nobody can hold the whole file at once.

- **Durable trap — never delete from `docs/backlog.md` by LINE NUMBER.** Entries can span two physical
  lines while being one logical bullet, because a hook may embed a literal newline inside a code span. A
  line-keyed delete then removes half an entry and leaves an orphaned fragment that reads as corruption.
  Bit this file during the 2026-07-19 classification pass. Delete by matching the entry's text, and after
  any scripted edit scan for orphans — lines not starting with `-`, `>`, `#`, a space, `|`, or a backtick.

> **Friction-walk entry template:** one line per friction — a bold title + the `[[memory-tag]]` for the
> durable lesson + only the still-OPEN tool sliver(s). No shipped-work narrative or changelog prose (that
> lives in git log / memory). Condense at write time, not in a later doc-review pass. The `[[memory-tag]]`
> appears only where a durable memory concept was actually captured for that item — by design, not every
> entry has one.
- **Friction walk (H2+H4 collapse lap, 2026-07-18):** (1) **ambiguous-direction (medium):** my own plan doc asserted "the host-vs-source dedup already exists" from a docblock's phrasing — the adversarial plan review refuted it against the writers (dedup was source-vs-source only, the new rule was new code); and the reviewer's own proposed fix for the display filter was itself a gate-that-never-fires (relative floor can't refuse every pool) — caught only by re-deriving at implementation time. Both are the standing lesson: every causal claim, including a REVIEWER's fix, gets verified against source before building. [[gate-must-be-traced-not-designed]] (2) **tool-should-decide (low):** the pre-commit loop-core gate evaluates a CHAINED `attest && commit` command before the inner attest has run, so the legitimate one-shot form is blocked — attest must be its own Bash call first; either the hook could ignore commits preceded by an attest in the same chain, or document the split as the required shape. (3) **inefficient-feeding (medium, recurrences):** NIM `llm read` lane 503-saturated ("Worker local total request limit 163/32") after ONE call in its session — recon fell back to targeted greps; and a delegated implementer died mid-task on the Claude session limit, with its partial recon unrecoverable (clean tree, redone in-context). Both argue for the standing pattern: main context implements from subagent recon it can verify, not the reverse.
- **Friction walk (proxy-swap lap, 2026-07-18):** (1) **ambiguous-direction (medium, 4 instances in one lap):** four delegated-agent claims with accurate file:line citations dissolved when the surrounding MECHANISM was traced — a "shipping-blocking" quota defect refuted by a `handlesProvider` gate two lines above the cited line; a "paradoxical asymmetry" in cost blend that was per-provider top-K truncation in the test fixture, not the blend; a "real regression" that was a leftover gitignored artifact; and an implementer self-reporting "zero repair_proxy references in src/" while 19 remained across 6 files. Property/lesson: cited line numbers make an interpretation look verified — the parent must trace the gate/caller around the citation, and must run its OWN completeness grep after any delegated sweep. [[gate-must-be-traced-not-designed]] [[grep-the-writers-before-believing-inheritance]] (2) **tool-should-decide (low, FIXED this lap):** the dev wrapper's `.audit-code-build.lock` in the repo root left the worktree dirty and tripped the release clean-tree guard; now gitignored (`bc6ca9cd`). (3) **inefficient-feeding (medium):** two delegated agents died mid-task on session/credit limits, losing partial work (one left no partial output at all); and heavy audit tests timed out en masse (22 across 9 files) purely from parallel-agent load on the box, costing an is-it-mine investigation that CI's green sharded run settled. Lesson: local full-suite results are unreliable while many agents run concurrently — CI is the arbiter.
- **Remediate hybrid frontier still sizes with a FLAT per-node estimate (step-G remediate half, medium).** `HYBRID_NODE_TOKEN_ESTIMATE` (`src/remediate/steps/nextStep.ts:1441`) makes the claim-time fit gate blind for implement nodes (audit's half fixed 2026-07-17 with real `token_estimate`s). Property: derive per-node estimates from the node's `affected_files` sizes (`estimateTokensFromBytes`) so a chronically-413ing (node,pool) pair is pre-skipped, not re-claimed each cycle.
- **Every step prompt's trailing "Then run: … next-step" makes any DELEGATED step executor a second driver (claude-worker dogfood 2026-07-16, tool-should-decide, medium).** A Haiku subagent handed one bounded step (charter_extraction) with an explicit "do NOT run next-step" instruction obeyed the step prompt's own embedded advance command instead and drove the workflow forward — the parent lost the step boundary. This generalizes the existing "design-review worker prompts FOLLOW-UP" entry from one branch to EVERY step prompt: the advance command belongs to the DRIVER, not the step executor, and prompt text cannot enforce that split (host/worker discretion). Property to hold: a step prompt handed to a non-driving executor must not carry the advance command — e.g. emit it only in the step JSON (driver-facing), not in the worker-facing prompt md, or gate next-step on the driving agent-id. **Recurrence 2026-07-17 (design-review re-dogfood):** a `systemic_challenge` adversary subagent, handed its step-prompt path to follow, executed the prompt's embedded `next-step` and advanced the loop from round 7→8 — even convergence-loop worker prompts carry the advance command, so this is not branch-specific. Mitigation used the rest of the lap: the dispatch message explicitly overrides ("do NOT run next-step; the parent owns advancement"), which held — but that is host-discretion, exactly what the property says to remove. [[enforce-robustness-in-tooling-not-host-discretion]] [[delegate-adversarial-phases-to-separate-agent]]
  **SPEC — the advance command goes in the DRIVER-facing artifact only, never in the worker-facing prompt.**
  Each step already emits two things: a machine step contract the driver consumes, and a prompt document
  the executor reads. The advance command belongs exclusively to the first. An executor handed a prompt
  with no advance command in it has nothing to obey — the failure stops being a matter of whether the
  worker follows instructions, which is the only way to fix it, since every attempted prompt-text
  mitigation has worked only for as long as someone remembered to write it. **Property to hold:** loop
  advancement is not expressible from the material a delegated executor is given. ⚠ Do not reach for an
  out-of-band control channel or an agent-identity check on the advance command — both are real designs,
  but they add a mechanism to defend a boundary that simply removing the text from one document already
  makes unreachable. Prefer the change that makes the process simpler.
- **The `charter_delta` step defaults its miner to the same host that merged `charter_extraction` — no mechanical author/critic split (2026-07-17 re-dogfood, tool-should-decide, medium).** `charter_extraction` instructs the host to author via blind subagents AND merge/trim their output into the submission; the very next `charter_delta` step then hands that same host the job of mining deltas over the charter set it just curated — the "independent delta-miner" is independent of the blind authors but NOT of the merger, so the host grades homework it helped assemble. Prompt text alone cannot enforce the split (host discretion; caught this lap only because the owner flagged it — I had started mining in-context before re-dispatching to a fresh agent reading `charter_register.json` cold). Property to hold: the delta-miner must be a mechanically distinct agent from whoever assembled the charters — e.g. the step dispatches the miner itself, or binds next-step acceptance to a delta submission authored under a different agent-id than the extraction merge. Same family as the executor-second-driver entry above. [[delegate-adversarial-phases-to-separate-agent]] [[enforce-robustness-in-tooling-not-host-discretion]]
  **SPEC — bind acceptance to AUTHORSHIP: record who submitted, and refuse a critique from that identity.**
  The tool records the agent identity that submits each artifact set, and the step that accepts a
  critique refuses one carrying the same identity. Independence then holds regardless of how careful the
  host is, which is the requirement — prompt text asking an agent to be independent of itself has never
  been enforceable, and this was caught only because a human noticed.
  ⚠ Worth knowing before building: an auditor-identity field already exists and is currently WRITE-ONLY —
  parsed, persisted, and read at one site purely as a non-empty check. It was previously assessed as dead
  because nothing needed it. This is the reader that justifies it, so settle the two together rather than
  adding a parallel identity channel beside a dormant one.
- **Self-audit dogfood loop: fixing the tool mid-run invalidates the run (claude-worker dogfood 2026-07-16, ambiguous-direction, low-medium).** The dispatch-blocking defect was found BY the run, and committing its fix changed the audited tree → staleness cascade correctly marked the whole planning chain stale → the 313-packet run regressed to charter_extraction, so every LLM planning step re-runs before dispatch is reattempted. Semantics are right (DAG is truth); the cost is structural to dogfooding-by-self-audit. Two tool slivers worth considering: (a) the resume emitted ~30 identical `{"kind":"staleness",...}` lines in one invocation (recompute spin — dedupe the log line per drain); (b) an active run whose frontier goes stale could say so explicitly ("run X invalidated by upstream staleness: <artifacts>") instead of silently re-planning from charter_extraction with run_id null.
  **SPEC — keep the cascade, ANNOUNCE it. Do not narrow staleness to make dogfooding cheaper.** The
  regression to first-planning-step is correct: the audited tree changed, so the planning derived from it
  is genuinely invalid, and the dependency graph is the source of truth. Any mechanism that spares a
  self-audit run from its own cascade would be special-casing the tool's convenience against the
  correctness rule the whole design rests on.
  What is actually wrong is that a large, expensive, correct action happens SILENTLY and looks like
  malfunction. The run should state that it was invalidated, by which upstream artifacts, and what it is
  therefore re-deriving — one message, at the moment it happens. The duplicated staleness log lines are
  the same defect in miniature: repeated identical output in place of one clear statement.
  **Property to hold:** an expensive automatic recovery explains itself at the moment it triggers. A user
  who cannot tell a correct cascade from a wedge will eventually defeat the cascade.
- **A stale prior-run shared confirmation suppresses the proxy populate trigger while Gate-0 still pends (claude-worker dogfood 2026-07-16, tool-should-decide, medium).** The 3c populate trigger (`nextStepCommand.ts:381`) keys on `readSharedProviderConfirmation(root) === null`, but the Gate-0 obligation keys on the per-tool seam — so a leftover `.audit-tools/provider-confirmation.json` from an ABANDONED prior run (yesterday's dogfood) silently skipped populate on a fresh run whose Gate-0 was still being emitted, and the lane dropped as "cache absent". Same split-artifact class as the reconciliation-gate entry below. Property to hold: the populate trigger and the Gate-0 obligation must key on the same confirmation artifact (or a fresh run must not inherit an abandoned run's confirmation). Diagnosis cost: the populate's `.catch(() => null)` is silent AND the skip-branch prints nothing, so "cache absent" pointed at the wrong half.
- **claude-worker lane feedback-gap residuals (gaps (a)/(b)/(c) SHIPPED 2026-07-17 — plan `docs/reviews/claude-worker-feedback-gaps-plan-2026-07-17.md`; these are the accepted leftovers, each low).** (i) **CLI-internal retry hammering:** a worker retries 429s inside its own lifetime before dying (dogfood: 307 proxy-side vs 29 surfaced) — invisible to the parent; the terminal classification → cooldown now paces ACROSS workers, not within one. If the re-run still saturates free tiers, the follow-up is consuming declared `quota.max_concurrent` into a per-pool concurrency default for free tiers. (ii) **`AGENTIC_WORKER_HARNESS_OVERHEAD_TOKENS = 15_000` is an estimate** (single-sourced in `src/shared/quota/capacity.ts`) — measure against real `claude -p` request sizes when live data exists. (iii) **Registry context-window stamp coverage unknown:** populate stamps `quota.context_tokens` only when the proxy registry carries a context field — verify the live registry actually exposes one (else groq-class pools stay cap-less until declared by hand). ⬇ Live-run watch (resume `20260717T062404401Z_audit_tasks_completed_001`): 413s → `packet_too_large` re-queue (not raw error), 429s → `cooldown_until` set on the pool entry, kimi-k2.6 dropped at populate with a `dropped[]` reason, `hybrid_dispatch_node_never_fits` / `rolling_dispatch_stranded_no_fitting_pool` lines only when genuinely unplaceable. [[external-audit-catalogs-are-leads]]
- **claude-worker lane residuals from the 3c adversarial review (2026-07-16, each low-medium, deferred deliberately).** (a) **Account axis:** the populate cache stamps no `account` and the `repair_proxy` declaration has no hook to add one — an operator declaring `account` on a direct lane only splits `nim#X/m` vs `nim/m` into two pools to one backend, reopening the double-grant boundary for that model (declared-wins dedup covers the same-model case; the split needs a per-backend account map on the declaration). Also inconsistent: `buildSourcePool` probes the quota-source account with the TRANSPORT key while the pool keys on the backend — benign only while no quota source handles `claude-worker`. (b) **No TTL / no refresh command:** `catalog-cache.json` is accepted arbitrarily stale (audit re-populates only while a repo has no shared confirmation; `populateProxyCatalogIfMissing` is missing-only), and the "explicit refresh" the plan names does not exist. Cross-repo: the cache is machine-global but audit's trigger is per-repo-confirmation-keyed, so starting repo B rewrites the expansion repo A resolves mid-run (additions gate-caught; removals silent-by-design). (c) **Intra-declaration duplicates:** `collectDispatchableSources` never dedups within `sources[]`, so an operator hand-declaring two sources with one backend identity still produces two same-id pools with map-clobber transport arbitration (the ambient path now dedups declared-vs-expanded; the operator-error case remains). Property to hold: one pool identity ⇒ exactly one launchable source, everywhere.
  **SPEC — all three are one defect: identity is being decided somewhere other than where it is known.**
  (a) the cache stamps no account and the declaration cannot supply one, so a backend that IS one account
  splits into two pools; (b) the cache is machine-global while the trigger that rewrites it is keyed
  per-repository, so a run in one repo can rewrite the roster another repo is resolving mid-run; (c)
  sources are deduplicated across declared-vs-expanded but never WITHIN one declaration, so two entries
  naming one backend produce two pools with the same identity and whichever writes last silently wins.
  **Resolution:** the producer that knows an identity stamps it and it travels on the wire — the same rule
  the account-metering work arrived at after five refused rounds. Concretely: the expansion stamps account
  identity rather than leaving a hole for a later stage to guess; deduplication happens once, over the
  full source set, keyed on resolved identity rather than on declaration origin; and a machine-global
  cache is never rewritten out from under a run that is reading it — either the read is snapshotted for
  the run's lifetime, or the rewrite is scoped so it cannot affect an in-flight resolve.
  **Property to hold:** one pool identity ⇒ exactly one launchable source, everywhere, and no in-flight
  run observes its own source set changing underneath it.
- **RESIDUE ONLY — one backend behind SEVERAL transports still yields one exclusion pattern (was: the model-keyed delta collapse, 3c review F10; low-medium).** The collapse itself is FIXED: the gate identity is now `(backend_provider ?? provider):model` (`backendIdentity`), so two backends sharing a model string no longer merge and confirming one no longer confirms the other. `backend_provider` is persisted on `SourcePoolCostEntry` and the host provider on `HostModelCostEntry`, which is what lets the CONFIRMED side reproduce the identity the DELTA computes — the reproduction gap was the livelock that deferred this.
  **What remains** is the narrower half, and it survives the fix by construction: when ONE backend is reachable over SEVERAL transports, the delta correctly reports ONE entry, but that entry carries ONE transport's `exclusion_pattern` — so an autonomous fail-closed exclusion drops that route and the other transport still routes unconfirmed. Identity is per-backend; a rule is per-transport; a single rule therefore cannot fail-closed every route.
  **Property to hold:** a fail-closed exclusion of a backend closes EVERY transport reaching it. Two candidate mechanisms, neither chosen: carry all transport patterns on the delta entry (touches `intakeExecutors.ts` — loop-core, needs attestation), or make `ruleMatches` backend-aware (widens the open grammar, and `ExcludableBackend` carries no backend field today). ⚠ Do NOT "fix" this by keying the rule on the backend — the rule is matched against the transport provider, so a backend-named rule matches nothing at dispatch, which is fail-OPEN and silent.
- **The vitest timing ledger records no pass/fail outcome, so a clipped console capture is unrecoverable (2026-07-16, tool-should-decide, low).** `.audit-tools-profile/vitest-latest.json` carries timing only (`fileCount`/`slowest`/…); twice in one session a full-suite run's summary was lost to a `| tail` clip and the ledger could not answer "did it pass, which files failed" — forcing a 4-minute rerun. Property to hold: the standing profile of a test run must record its OUTCOME (pass/fail counts + failed file names), not just its cost. One field in `vitest-timing-reporter.mjs`.
- **A doc-lint hook rewrites prose between Read and Edit, so exact-match edits fail on text the agent never wrote (2026-07-16, inefficient-feeding, low).** Mid-lap an `Edit` on `docs/backlog.md` failed with "String to replace not found" on a paragraph I had authored minutes earlier — a hook had normalized `vs` → `vs.` in it. The Edit tool's own hint ("tried swapping \uXXXX escapes") points at encoding, not at a hook rewrite, so the natural next move is re-reading the whole file to hunt an invisible character. Cost a re-read + a retry. Property to hold: a hook that rewrites a file the agent is mid-edit on should announce the rewrite (or the tool should re-anchor), rather than presenting as a mysterious mismatch. Cheap mitigation until then: after a "not found" on text you just wrote, suspect a normalizer and `grep` the anchor before re-reading the file.
  **SPEC — a hook that rewrites a file must announce the rewrite; the editing tool is not ours to change.**
  Recurred again this session, on this very entry: an exact-match edit failed while a full re-read showed
  byte-identical text, so the mismatch was invisible and the only escape was shrinking the anchor until it
  matched. The cost is never the retry — it is that the failure impersonates an encoding problem, and the
  tool's own hint points at character escapes, sending the agent hunting for something that is not there.
  The fix belongs in the hook, which we own: when it rewrites a file, it says so, so the next mismatch is
  self-explaining. ⚠ Do not pursue lint-aware patch semantics inside the editor — that is someone else's
  tool and a large mechanism to avoid a one-line announcement. ⚠ And do not "fix" it by disabling the hook
  during agent edits: suppressing enforcement to make editing convenient is the wrong direction and
  teaches the same workaround on every other surface.
  **Property to hold:** a file mutated underneath an agent mid-edit is announced, never silent.
- **Release gate: add `check:doc-manifest` to the pre-commit hook (open remainder, medium).** The durable lesson — a lap cannot report green on evidence weaker than what CI runs; end a lap by checking CI on `main` (the per-workflow runs endpoint is the reliable one), and run `npm run verify:release` before any "this is shippable" claim — is homed in `docs/HANDOFF.md` → "Release gate — the durable lesson" + [[lap-green-must-match-ci-evidence]]. Sole open action: `.claude/hooks/pre-commit-gate.mjs` gates `npm run check` (always) plus `test:doc-contract` and loop-core attestation (each conditionally, when staged files touch the relevant paths) — but never `check:doc-manifest`, so consider adding it (~2s, and it is the check that fired on EVERY push). [[enforce-robustness-in-tooling-not-host-discretion]] **Billed once, 2026-07-18** (a new dated plan doc committed fine locally and blocked `verify:release` afterwards).
- **Neither new test guards the WIRING — only the mechanism and the loader (2026-07-16, low).** `tests/remediate/session-config-load.test.ts` red-greens `loadRemediateSessionConfig`, and every remediate site routes through it today, but a FUTURE call site that inlines `resolveSessionConfig(intent, null)` instead of using the loader fails no test (verified by experiment: reverting a call site to `null` left both files green). Same for audit's two ambient sites. The loader makes the right thing the easy thing; it does not make the wrong thing impossible. Property to hold: a production caller cannot resolve a session config without a descriptor — e.g. make the descriptor a required parameter and give the two legitimate "resolve no pool" callers an explicit `noPoolDescriptor()`, so `null` stops being the path of least resistance.
- **A post-worker LANDING stage is misfiled as dispatch — 3,470 of 5,326 lines under `src/remediate/steps/dispatch/` (owner question 2026-07-16, medium).** worktree / accept / writeScope / verifyCommands are not dispatch: `executeNodeInWorktree` (`acceptNode.ts:749`) is called by the **driver** (`nextStep.ts:1190`), NOT by `prepareImplementDispatch`, which ends at `marshal.ts:427` having written plan + quota and never touching a worktree. They live under `dispatch/` only because the barrel (`dispatch.ts:49-134`) aggregated them; `acceptNode.ts:332` even takes a base-branch lock — pure serialization, zero dispatch content. Symmetrically on the audit side, `prepareDispatchArtifacts` both *decides* and *renders the prompt* (anchor extraction reads source files, `packetPrompt.ts:123-161`; lens defs `dispatch.ts:231-232`; knip indices `dispatch.ts:443-458`). **Property to hold: dispatch is three stages — select/pack, size/admit, launch/land — and the name covers only the middle. Each stage is separately nameable and testable.** Re-home; do NOT bundle into the assembly-unification lap.
- **`withinRoot` — a root-containment SECURITY guard — is reimplemented 5× (owner question 2026-07-16, medium).** `dispatch/paths.ts:10`, `openAiCompatibleProvider.ts:763`, `extractors/graph.ts:520`, `analyzers/typescript.ts:122`, partially `worktreeLifecycle.ts:91`. Five copies of a containment check = five chances for one to be subtly wrong, and a security guard is exactly the class where that matters. Single-source it.
- **Two dispatch entry points disagree on fail-closed and on driver identity (owner question 2026-07-16, medium).** (a) `prepareDispatchCommand.ts:17-23` and `quotaCommand.ts:25` swallow an invalid session-config to `{}` ("using defaults") while `dispatch.ts:219-230` documents fail-closed as the invariant *precisely because* a permissive default builds dispatch against an attacker-influenced config. (b) `prepareDispatchCommand.ts:28` uses `resolveFreshSessionProviderName` where the host path (`semanticReviewStep.ts:117`) uses `resolveHostDispatchProviderName` — the exact founding-bug shape the latter exists to prevent (`provider: codex` would key the pool to codex, not the conversation host). Property to hold: every dispatch entry point carries the same guards, or there is only one entry point.
- **Dead code: `src/audit/quota/headerExtraction.ts` + `headerExtractors/` have zero production consumers (owner question 2026-07-16, low).** Only the `index.ts` re-export + `tests/audit/header-extraction.test.mjs` reference them — the tested-but-unwired class that default-mode knip cannot catch. Delete symbol + orphaned tests per the periodic manual-audit recipe. [[knip-deadcode-gate-default-mode]]
- **G4 reduces to ONE narrow bug: `block_quota.host_model` is auditor IDENTITY persisted in the repo, and it outranks the descriptor (found G4 premise-check 2026-07-16, corrected same-day during implementation, medium).** `resolveHostModel` (`limits.ts:56-71`) resolves `explicit ?? block_quota.host_model ?? env`; `hostPool.ts:156` then does `quotaModelKeySegment = hostModel ?? input.hostModelId` — so the repo's `block_quota.host_model` beats the descriptor's `self.model_id` and **auditor B keys its quota to auditor A's model**. Violates [[capability-is-per-auditor-not-per-audit]]. **⚠ The rest of the original claim is REFUTED: nothing writes `quota`/`block_quota`** — they are operator-authored, and `packetFilter.ts:259` documents `quota.models` as the operator's override mechanism. So `quota.models[<model>]` is keyed BY MODEL NAME (same window for every auditor) → inheriting it is CORRECT, and `limits.ts:115` beating discovery is the intended escape hatch, **not a bug — do not "fix" it** (it only misfires because `hostModel` was mis-resolved upstream; fix the identity and it's right). `quota.default_context_tokens`/`reserved_output_tokens` and `block_quota.context_tokens`/`reserved_output_tokens` (`plan.ts:47-51`) are policy → stay on intent. **Fix = move `block_quota.host_model` → `self.model_id` only**; narrow the `RepoSessionIntent` HALF-type note (`src/shared/types/sessionConfig.ts:772-779`) accordingly. Also stale: G4's "may fold into G2" — G2 shipped and did not fold it. Separately real (and still open): `resolveSessionConfig.ts:86-116` maps none of the `self.*` capability fields; they reach dispatch hand-threaded through three audit CLI commands (`nextStepCommand.ts:130-133`, `prepareDispatchCommand.ts:43-48`, `quotaCommand.ts:38`) — a parallel channel bypassing the one seam. **⚠ Correcting this entry's own earlier claim that the channel "MUST collapse in the same commit as any shared-assembly lift": that premise did NOT apply and the 2026-07-16 lift shipped without it.** The constraint assumed shared assembly would take the DESCRIPTOR and read the resolved config; `buildHostPoolPreamble` instead takes already-resolved scalars (`providerName` / `explicitHostModel` / `hostModelId` / `hostContextTokens` / …), so the channel now hand-threads into ONE function rather than two — strictly better, and not a correctness coupling. The collapse remains worth doing on its own merits (one seam, not two channels), but it does not gate the lift. **Also note the lift moved the `hostModel ?? hostModelId` precedence INTO shared (`hostPool.ts`), so if G4 IS a bug its blast radius is now both draws — which is an argument for settling the owner call, not for reverting.** Detail: `docs/reviews/g4-g5-g6-premise-check-2026-07-16.md`.
  **SPEC — settled: it IS a bug, and the fix is to move the IDENTITY field only.** The distinction that
  makes this decidable is what each field is keyed BY. A repo-committed host-model field is auditor
  IDENTITY — it says which model is driving — so a second auditor working in the same repo inherits the
  first one's identity and keys its quota to a window it does not own. That is the per-auditor rule
  violated directly, and it now affects both draws.
  The sibling field is different in kind and must NOT be touched: operator quota overrides are keyed BY
  MODEL NAME, so every auditor using that model shares the window by design. Inheriting those is correct,
  and the override beating discovery is the intended escape hatch. It only ever looked wrong because the
  identity above it was resolved wrongly — fix the identity and the override behaves.
  **Resolution:** the host-model identity moves onto the per-auditor descriptor and stops being readable
  from repo-committed config; model-name-keyed operator overrides and the policy fields stay exactly
  where they are. **Property to hold:** anything naming WHO is running belongs to the auditor and is
  never persisted in the shared repo; anything keyed by a model name is shared config and is.
  ⚠ Separately real and still open: the auditor descriptor's capability fields reach dispatch
  hand-threaded through three CLI commands rather than through the one resolution seam — a parallel
  channel worth collapsing on its own merits, but it does not gate this fix.
- **G5's premise is 2/3 DEAD — narrow the spec before laying it out (found G4 premise-check 2026-07-16, low).** (a) `declared ∩ ambient-verifiable` SHIPPED as G2.5 (`resolveAmbientSources`). (b) The **auditor-id stamp is dead as specced** — `auditor_id`/`resolved_at` are parsed (`args.ts:348-349`) and read at exactly ONE site (`prompts.ts:61-62`) purely as an is-non-empty test: a write-only field ([[write-only-data-looks-authoritative]]). G2.5 established each IDE spawns its own process → own env → nothing shared to contaminate, and the spec's own Honest-residuals says the `(provider, account)` ledger — not auditor identity — is the load-bearing double-grant boundary. Before building a stamp, name the transient cross-auditor-shared run-state and re-derive whether an id is the fix. (c) Only the **lies-reachably quarantine** survives (`auditorSources.ts:147-148`); it is the sole catcher for G2.5's inline-`api_key` refusal. **G5 ≈ clause (c) alone.**
- **A ROTATING set of heavy suite tests fails only under parallel load — hermeticity, not regression (re-measured G3 A′ lap 2026-07-16, tool-should-decide, low-medium).** `tests/audit/linux-cycle-regression.test.mjs` fails in a full `vitest run` but passes alone (35s), and a **third failure rotates** between runs — observed as `tests/remediate/wave-scheduler.test.ts`, `tests/audit/next-step.test.mjs`, `tests/shared/quota-state.test.mjs` (all heavy, all pass alone). **Measured baseline (as of the 2026-07-16 lap, pre-dating the 2026-07-19 `INV-shared-core-14` fix): clean `main` failed `linux-cycle-regression` + one rotating mover** — re-measure before relying on this count; `INV-shared-core-14` no longer belongs in it. Also timed `linux-cycle-regression` mine-vs-main: 35s both. Per the test-failure protocol these are test bugs (timeout under worker contention / shared quota-state dirs), not code regressions. **The real cost is the is-it-mine investigation** — every dispatch-touching lap pays a full-suite baseline run on stashed main (~2×260s) to prove parity. Property to hold: a green branch must be distinguishable from a flaky one WITHOUT re-running the suite on main. Fix the hermeticity/timeouts, or quarantine the known-flaky set into a separate serial shard.
  **SPEC — persist the known-state baseline so parity is a LOOKUP, not a re-run.** The cost here is not the
  flakes, it is that every dispatch-touching lap re-derives the same baseline by stashing and running the
  full suite on main to prove innocence. The missing thing is a recorded answer to "what does main do under
  these conditions": store, at green baseline, each test's deterministic-or-parallel-flaky status annotated
  with the environment it was measured in (parallelism, OS, core count), since the whole phenomenon is
  load-dependent and a status measured under different concurrency means nothing.
  A branch failure then classifies against that record: a test that passes alone, fails under load, and is
  recorded parallel-flaky on main for the same environment is reported as parity with an annotation rather
  than as red. **Unrecognized failures stay red** — the classifier may only downgrade a failure it has a
  matching record for, never wave through one it does not recognize.
  **Property to hold:** a green branch is distinguishable from a flaky one without re-running the suite on
  main. ⚠ Not to be confused with an ignore-list: suppressing these tests everywhere destroys the signal
  permanently, and the hermeticity defects remain worth fixing on their own merits — this removes the
  investigation tax, it does not make the flakes acceptable.
- **No read-only surface shows the built dispatch pools — an exclusion rule is unverifiable until a live dispatch (G3 A″ lap 2026-07-16, tool-should-decide, medium).** Verifying "operator excludes one NIM model ⇒ siblings still route" end-to-end, I could observe the operator half at the real CLI (Gate-0 prompt → persisted `policy`) but **not the routing half**: `buildSourcePools` is reachable only from a live dispatch wave. Checked every read-only surface — `audit-code quota` reports only the host pool (`claude-code/*`) and reports the SAME with no exclusion at all, so it never builds source pools; `validate` surfaces none either. So an operator authors a rule and cannot see which pools resulted, and a typo'd rule (`openai-compatible:model-typo`) persists happily and matches nothing, silently. The grammar is OPEN by design so it can't be validated at parse time — but nothing reports "this rule matched zero backends". Property to hold: the operator can see the resolved dispatch pool set (and any zero-match rule) WITHOUT committing to a dispatch. Would also give the A″ routing filter a runtime surface to verify at, which it currently lacks.
- **Gate-0 display never reflects an exclusion for a SOURCE — no status column, and the endpoint tier can't mark a provider entry (G3 A″ lap 2026-07-16, tool-should-decide, low).** Two halves of one gap, both display-only (routing is correct — `buildSourcePools` honors every tier): (a) the Gate-0 **sources table** (`providerConfirmationStep.ts`, `| id | provider | model | $/Mtok |`) carries **no status column at all**, so NO exclusion tier is ever shown for a source — pre-existing for provider-name rules, but total for A″'s model/endpoint tiers, which can only ever match sources; (b) `provider_pool` is provider-granular and its entries carry no endpoint, so an **endpoint-host rule can never mark one** (`ruledOut` in `sharedProviderConfirmation.ts` evaluates `{provider, model}` only) — the Gate-0 table renders the backend "included" while dispatch correctly drops it. Property to hold: what the operator is shown as excluded is exactly what dispatch drops, at EVERY grammar tier. Direction is fail-safe (under-reports, never over-routes), which is why it is low. NOTE: `excluded` leaves the persisted shape in **B+D**, so fix the RENDER path, not the artifact field.
- **The per-tool seam artifact marks `excluded` at provider granularity only — inert today (G3 A″ lap 2026-07-16, low).** `confirmProviders` (`src/audit/orchestrator/providerConfirmation.ts`) still does `excludeSet.has(provider.name)` on what is now a **pattern** list, so a `provider:model` rule marks nothing in the per-tool `provider_confirmation.json`. Verified inert: the only reader of `.excluded` anywhere is the Gate-0 renderer, which reads the SHARED artifact. Cleanup, not a defect — but it is a latent trap the moment anything reads the seam's `excluded`.
- **SPEC — split the two things currently merged into one "excluded" set; then host exclusion has an obvious
  meaning.** An operator excluding the host or primary provider is not honored: host/primary pools are built
  unfiltered while only source pools get the exclusion set. This was deferred as needing "a decision about
  what excluding your own driver should even mean," because the exclusion set always contains the
  conversation host in-session, so handing it to the host-pool builder would zero out dispatch.
  **That dilemma is an artifact of conflating two different concepts under one set:** (a) OPERATOR POLICY —
  "do not use this backend", a deliberate instruction; and (b) SELF-SPAWN BLOCK — "this backend is me, I
  cannot spawn myself", a mechanical fact about the current process. Merging them is why applying the set
  to host pools looks catastrophic: it is the self-spawn fact, not the operator's intent, that would zero
  dispatch.
  **Resolution:** separate them at the source. Operator policy applies EVERYWHERE, host pools included.
  Self-spawn blocking applies only where spawning is what happens. Then "exclude your own host" means
  exactly what it says, and an operator who excludes every pool gets a loud, correct "you have excluded
  all dispatch capacity" rather than a silently-ignored instruction. No new decision is owed once the two
  concepts stop sharing a container.
  **Remaining residue on the same surface, each smaller:** (a) an absent or unparseable confirmation still
  fails OPEN — no policy read as no exclusions, which is the wrong default for a gate whose purpose is
  withholding approval; (b) part of the artifact's reach half is still persisted but read by nothing at
  dispatch — write-only data that looks authoritative; (c) the self-spawn signal covers some host
  environments but not all, so a source running inside its own host is not always blocked — a gap in (b)
  above, and it closes when the self-spawn concept is separated and made to enumerate its environments.
- **The reconciliation gate is silently disabled if the two confirmation artifacts split (G3 A′ review 2026-07-16, tool-should-decide, low).** The obligation gates on the per-tool SEAM (`has(bundle.provider_confirmation)`, `state.ts:98`) while the gate's delta early-outs on the SHARED artifact (`readSharedProviderConfirmation(root)`, `nextStepCommand.ts`). They are written together only under `if (root)`, so seam-present + shared-absent (a root-less promotion, or an operator deleting the shared file) ⇒ obligation satisfied AND delta `[]` ⇒ the gate never fires for the run, and `resolveExcludedProviders` also finds no policy ⇒ a newly-reachable backend routes unconfirmed. Narrow (needs the pair to split) but silent. Property to hold: the gate's CONFIRMED operand and the obligation's presence check must key on the same artifact, or a split must be loud. [[dispatch-policy-vs-reach-cut]]
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
- **Loop-core gate covers `src/audit/orchestrator/` but NOT the audit cli dispatch step-emitters (2a-ii lap, tool-should-decide, low-medium) [[loop-core-enforcement-layer]].** `LOOP_CORE_PATTERNS` includes `src/audit/orchestrator/` (so 2a-ii's Finding-A fix in `advanceTypes.ts`/`executorRunners.ts`/`intakeExecutors.ts` correctly demanded attestation) but NOT `src/audit/cli/nextStepCommand.ts` / `semanticReviewStep.ts` / `prompts.ts` — where the CORE 2a-ii dispatch-inventory READ switch lives. A dispatch-substrate edit confined to those cli emitters (plausible for 2a-iii's loader wiring) would ship WITHOUT the attestation backstop. Endpoint (owner call): either add the audit cli dispatch-emitters to `src/shared/loopCorePaths.ts` (+ the `.mjs` hook parity list), or accept them as cli-glue and rely on the reviewer catching it. Not auto-expanded — widening the set makes every edit to the big `nextStepCommand.ts` require attestation, a real friction tax to weigh. **G1 (`e7b593ac`) is a concrete SECOND instance:** a breaking dispatch-handshake transport change spanning `args.ts`/`prompts.ts`/`nextStepCommand.ts`/`semanticReviewStep.ts`/`prepareDispatchCommand.ts`/`quotaCommand.ts` shipped attestation-free (none are loop-core by path). An independent review WAS done by discipline (and caught a real roster-validation-drop regression) — so the reviewer-catches-it fallback held, but only because the author chose to run it. Reinforces the owner-call endpoint above.
  **SPEC — move the CODE, do not widen the pattern list. The owner call dissolves.** The choice was framed
  as "add the CLI dispatch emitters to the attested path set (and tax every edit to a huge, constantly-
  edited CLI file) or accept them as glue and hope a reviewer catches it." Both options are bad because
  both accept the real problem: **dispatch-substrate logic is living inside a CLI command file.** The path
  list is not mis-scoped — the code is misfiled. The core dispatch read-switch belongs in the substrate,
  where the existing pattern already covers it and where it is independently testable; what stays behind
  is genuine CLI glue that correctly needs no attestation, and the friction tax never materializes because
  the file that gets edited constantly no longer contains anything load-bearing.
  **Property to hold:** the attested set is defined by what the code IS, not by remembering to list where
  it happens to live. Any file whose path escapes the pattern while its contents are substrate is the same
  defect recurring. Same class as the landing-stage-misfiled-as-dispatch entry — both are module boundaries
  drawn by history rather than by role, and both are fixed by moving code rather than by tuning a list.
- **Friction walk (G3 re-plan lap, 2026-07-16):** (1) **ambiguous-direction (HIGH — cost a full review round and nearly a bad spec edit):** the doc set contradicted itself on where `DispatchPolicy` lives. `spec/unified-dispatch-worker-model.md:283` said "persists on the intent"; the memory [[dispatch-policy-vs-reach-cut]] said intent-collapse was "refuted"; the plan doc said the artifact is the only cross-tool channel. All three were *true* — of different phases (intent is the G6 endpoint; artifact is the pre-G6 reality) — but **nothing recorded that they were phases of one design**, so each doc read as a flat contradiction of the others. Draft 4 concluded the spec was stale and proposed striking an owner-approved decision. Fixed this lap by phase-qualifying the spec + memory, but the general defect stands: **a spec that states an endpoint without marking what gates it invites a later agent to "fix" the endpoint to match the implementation.** Endpoint-vs-phase should be a doc-lint rule ([[spec-degradation-and-doc-staleness]]). (2) **inefficient-feeding (HIGH):** the dated plan doc (`docs/reviews/g3-*.md`) reads as self-sufficient — verified ground-truth table, owner decisions, scope — so an agent starting from HANDOFF's "▶ Next" pointer plans from IT and never opens the design of record. That is exactly what happened here (and, per the owner, in prior laps: *"agents keep forgetting the actual goals"*). The dated plan carries mechanism; the spec carries the GOAL. Fix direction: dated plan docs should open with a mandatory "Goal (from spec §X)" restatement, or HANDOFF should point at the spec FIRST and the plan second. Cf. [[front-load-broad-search-before-contract-authoring]]. (3) **tool-should-decide (medium):** three of four drafts specced a gate that would never fire, and each was caught only by an adversarial agent tracing the call path — nothing mechanical flags "this predicate is satisfied-once-written so its executor is unreachable", "this artifact input is never invalidated", or "this obligation has no clearing path". A lint over the obligation table (every obligation's satisfy-predicate must have a reachable transition to unsatisfied, and every consume-an-input executor must invalidate it) would have caught all three deterministically. [[gate-must-be-traced-not-designed]]
- **Friction walk (repair-proxy dogfood lap, 2026-07-15):** (1) **tool-should-decide (medium), overlaps [[quota-before-cost-ordering]]:** the cost ordering shows models.dev **LIST price** ($1.92 for nim/glm-5.2), but the operator pays **$0** for it (NVIDIA NIM free tier). Free-to-operator vs metered is a per-`(operator,backend)` fact the catalog can't know; discovered pools default to list price, so a genuinely-free backend sorts as if expensive and a paid one (openrouter) can hide mid-list. Today's only lever is hand-declaring `cost_per_mtok:0` / `enabled:false` per backend in `repair_proxy.providers` (done for this run) — the tool should let the operator classify a backend's cost-relationship once, not re-price every model. (2) **tool-should-decide (low):** no way to mark a whole discovered transport's sub-provider as paid→excluded at Gate-0 itself; had to edit session config + re-run next-step. (3) **tool-should-decide (medium), = [[per-model-tiering]]:** owner reinforced that capability/tier is assigned per PROVIDER, not per (provider, model, effort). Concrete: Codex (`~/.codex/config.toml` model=`gpt-5.6-sol`, effort `high`, but `-m/--model` + `-c model=` take any model per-call) renders at Gate-0 as ONE `capable`/`resolved at dispatch` row because the legacy `codex` block has a single `model` field — its multiple models at different capability tiers collapse to one. The tool's own workaround (pin `sources[]` `{provider:codex, model, parameters:{extra_args}}` per model/effort) puts the burden on the operator; the tiering should be per-(provider,model,effort) natively, sourced from models.dev / declared config. (4) **env-var trap (low):** repair-proxy `mistral` provider hardcodes `authEnv: "MISTRAL_API_KEY"`, but the operator's Mistral La Plateforme key lived in `CODESTRAL_API_KEY` (Codestral and La Plateforme share one key but the env-var name differs) → pool silently `has_key=false`/excluded until the authEnv was repointed. A reachability probe that reports "keyed but wrong-env-var" vs "no key" would cut the diagnosis.
- **Friction walk (force-synthesize→remediate dogfood lap, 2026-07-12):** (1) **inefficient-feeding (medium):** the contract pipeline requires ~15 sequential HOST-authoring turns (goal→context→decomp→16 shards→seam→critique→testplan→assessment→counterexample→judge→DAG) BEFORE any dispatch, so with host fan-out off (to save Claude quota) the quota is spent up-front on planning regardless of routing fixes to $0 NIM/Codex; and each failed next-step CONSUMES the `*.input.json` (full regen, no in-place field fix). (2) **tool-should-decide (low):** the implementation_dag citation-grounding gate grounds on lowercased path/symbol *tokens* from title+description, so a node whose scope is dotfiles with no code symbols (`.gemini/*.toml`) or whose prose cites real paths non-token-shaped is rejected — 2 grounding re-loops until a real camelCase symbol / clean lowercase path was embedded.
- **Friction walk (quota-cluster batch-ship lap, 2026-07-11):** (1) **NIM `llm read`/`write` unusable for reasoning-heavy review** — the selected `nvidia/nemotron-3-ultra-550b` won't emit valid JSON for a `read` review prompt (returned prose "Let me ana…" twice → the strict JSON contract errors out), and a ~500-line diff times out at the default 120s. The "delegate heavy loop-core review to the free NIM pool" workflow ([[three-tier-quota-error-classification]], [[free-nim-pool-first-default-worker]]) silently degrades to doing it in-Claude. Endpoint: either pin a JSON-reliable model for `llm read`/`write`, add a longer default timeout for large stdin, or teach the worker to salvage prose→structured. (inefficient-feeding, medium). (2) **`pre-commit-gate.mjs` false-positives on `git commit -C <sha>`** — the bypass-flag scan flags `-C` as `-n`/`--no-verify`, blocking a legitimate reuse-message commit; had to fall back to `-F <file>`. Tighten the flag regex to word-boundaries. (tool-should-decide, low). (3) **`rtk npm run …` → "program not found"** on this box — the rtk npm wrapper can't resolve the npm shim, so `rtk npm run build`/`check` fail; use PowerShell `npm` directly (CLAUDE.md's "always prefix rtk" doesn't hold for npm here). (durable trap, low).
- **Friction walk (repair-proxy capability-feed ship lap, 2026-07-15):** (1) **tool-should-decide (medium):** the local `verify:release` gate returned **exit 0 while reporting "3 failed"** — a false green that let a deterministic bug (the Gate-0 fold double-ranked the legacy `openai_compatible` pool → `provider-confirmation-gate` `expected 2 to be 1`) reach the release CI, which correctly caught it in shard 3/4. The local full-suite gate must fail-nonzero on ANY deterministic test failure (suspect a `--retry` masking the count, or the profiling reporter swallowing vitest's exit code); until fixed, treat "N failed" in the summary as a hard stop regardless of exit code.
- **CI coverage gap: a docs-only commit skips the vitest suite, so a doc-lint / staleness-parity regression lands on main UNCAUGHT (2026-07-15, tool-should-decide, medium).** `audit-code-test-suite.yml`'s release-bump/docs skip guard skipped the vitest suite for commit `016d5945` (an owner-approved doc-review resolution touching `spec/audit-workflow-design.md` + `spec/audit/dependency-map.md`), so its two deterministic failures (design-docs-declarative banned-status-language at :85; staleness F1 inv-6 dep-map parity, where a producer-table row bled into the naive `.md` edge parser) sat red on main until the next CODE push re-ran the suite. Both were cheap, deterministic, doc-derived checks. Endpoint: run the doc-lint + dep-map-parity tests (design-docs-declarative, the staleness literal-parity guards) in the cheap `ci.yml` chain which does NOT skip on docs commits — a doc commit that breaks a doc-derived invariant should fail its own push, not the next unrelated code push. (Both failures fixed in `5c9edcb2`; the skip guard itself is the open item.)
- **Friction walk (openai-compatible content-inlining ship lap, 2026-07-15):** (1) **process/self (medium):** an adversarial-review HIGH-fix ADDED a field to a widely-asserted contract (`DispatchPlanEntry.file_paths`) AFTER the full-suite run; only targeted tests were re-run, so `review-packets.test.mjs`'s exact `Object.keys(plan[0]).sort()` key-set assertion (shard 1/4) was missed → caught by release CI, one forward-bump. Lesson: any post-review change to a CONTRACT SHAPE (a new field on a persisted/asserted type) forces a full-suite rerun, not a targeted one — the blast radius is every exact-shape assertion, not just the changed module. (2) **tool-should-decide (low):** exact `Object.keys().sort()` shape assertions are additive-hostile by design (leak-guard) but give a cryptic `expected 6 to deeply equal 5` with no field name; a helper that diffs and names the unexpected/missing key would cut the diagnosis loop.
- **A stale-artifact re-extraction `next-step` runs >2min with no progress signal, silently blowing a caller timeout (live dogfood 2026-07-17, inefficient-feeding, low).** After the design-review passes, the drain re-extracting 11 stale artifacts (repo_manifest/graph over 1250 components / 8466 edges, invalidated by a docs commit) exceeded a 2-minute command timeout with only a flood of identical `{"kind":"staleness",...}` lines and no heartbeat — forcing a blind retry at a longer timeout to see if it was wedged or working. Property to hold: a long deterministic drain should emit a progress/phase heartbeat (or the staleness spam should collapse to one line) so a caller can distinguish "working" from "wedged" without a retry. Minor; the retry succeeded.
- **RESOLVED 2026-07-17 (with a corrected root cause): "Conversation-first dispatches HOST-ONLY".** The premise "resolved pools never fan into the wave" was REFUTED by the run's own artifacts — the pools WERE folded in and driven; the real chain was null `contextCapTokens` (fit gates silently no-op) → 413/429 → ANY-non-complete-drive settles ALL pools → frontier collapses onto the walled host → false "exhausted" wall. Fixed as unified-routing steps A–G (never-null windows, one fit predicate, per-pool reason-aware settle, honest wall, capability floor, packer/fit consistency) — 6 attested loop-core commits, records `docs/reviews/host-fanout-premise-refuted-2026-07-17.md` + `unified-dispatch-routing-design-2026-07-17.md`. ⬇ Live-run watch (fresh conversation-first self-audit): small pools take fitting packets; an oversized packet SKIPS (no 413); a 429 on pool A leaves pool B dispatchable; a zero-grant renders its honest cause. [[grep-the-writers-before-believing-inheritance]] [[repair-proxy-dispatch-unblocked-probe-fix]]
- **SPEC — probe the local OpenAI-compatible ENDPOINT, the way CLI providers are probed on PATH.** The
  original framing ("NIM should auto-detect like the CLI providers") has a false premise: CLI providers
  are discovered by probing PATH for a binary, and a hosted API has no binary to find. An endpoint plus a
  credential genuinely cannot be guessed, so "detect NIM with no configuration" is not a coherent goal
  and should not be pursued as stated.
  What IS discoverable is a **locally running proxy**. When an OpenAI-compatible endpoint is listening at
  a well-known local address, its roster can be fetched and its liveness checked — exactly the evidence a
  PATH probe provides for a CLI, obtained a different way. That makes the lane appear without the
  operator hand-writing a declaration, which is the real want behind the original expectation.
  **Property to hold:** a backend the tool can PROVE is reachable appears in the pool without hand
  declaration, whatever the proof mechanism is for that backend class. A backend whose endpoint or
  credential cannot be discovered stays operator-declared — that is correct, not a gap.
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
  **SPEC — retry only what is TRANSIENTLY undispatchable; terminate what is STRUCTURALLY undispatchable.**
  The livelock fear is real but it applies to exactly one of two cases, and conflating them is why the
  retry stalled. A node that was not dispatched because no pool had capacity *at that moment* is transient
  — conditions change, and retrying is correct. A node that fits no pool at all (its context exceeds every
  available window, or its scope is empty so there is nothing to dispatch) is structural — conditions will
  never change, and retrying it forever is the livelock.
  So the retry is safe once the two are distinguished at the point of non-dispatch: record WHY a node was
  not dispatched, retry the transient class with a bounded attempt count, and terminate the structural
  class immediately with a named reason rather than letting it silently block its subtree. A bounded count
  on the transient class caps the worst case even if a reason is misclassified.
  **Property to hold:** a node never blocks its downstream subtree without a recorded reason, and no node
  is retried against a condition that cannot change. The scope-less guard belongs at the dispatch
  boundary for the same reason — refusing an empty-scope node there makes the structural case impossible
  to enqueue rather than merely detectable afterwards.
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
  **SPEC — the prompt's model is wrong; drive fan-out from the session that OWNS the notifications.**
  Completion notifications route to the top-level session, and that routing is host-harness behavior this
  project does not control. So a delegated dispatcher is structurally the wrong shape: it idles between
  events it will never receive, and every workaround reintroduces the manual per-node relay the delegation
  existed to remove.
  Resolution: the step prompt stops instructing a delegated dispatcher and describes flat fan-out driven by
  the session that owns the notification channel. Delegation stays available for bounded units of WORK; it
  is driving a completion-event loop that does not survive delegation. ⚠ Do not resolve it by having
  workers message the dispatcher directly — that builds a second, parallel completion channel alongside
  the harness's own, which then has to be kept correct in cases (crash, timeout, partial result) where the
  harness channel already is.
  **Property to hold:** the agent that awaits completions is the agent that receives them. Generalizes
  beyond this prompt: any instruction to delegate an event loop across a boundary the events do not cross
  is the same defect.
- **NIM in-process worker: one packet failed with "empty completion (no choices[0].message.content)" (2026-07-11 live run, watch).**
  Hybrid partition (3 packets): 2 returned results inline, 1 errored empty. If it recurs on a specific
  model (ultra vs nano), demote that source or add a bounded same-packet retry on a sibling $0 pool.
- **Abandoned-wave leases saturate the cold-start cap → phantom "quota wall" (2026-07-11 live run, low — NOT a release bug; the reconcile already exists).**
  A host grant came back `granted 0`, all 14 packets `cap_reached`, `headroom_before: null` (ledger never
  consulted): `admitBatch` seeds `countByPool` from the ledger's live leases (admissionLoop.ts:535-549), the
  ledger held 4 leaked leases (2/pool, agent `24556`) with the 20-min TTL still live, and with cold-start
  effectiveCap = 2/pool the phantoms fully saturated the cap. BUT the release machinery is present and
  correct — `mergeAndIngestCommand.ts:595` reconciles a grant's leases at the top of every merge and
  `dispatch.ts:754` reconciles on the pause path. The leak's true cause was OPERATIONAL: waves I KILLED
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
  **SPEC — delete "wave" as a concept; express the one legitimate barrier as a DEPENDENCY.** The layer
  that genuinely needs a merge first needs it because its work does not exist until earlier results land —
  that is precisely a task unlock, which is already reason (1) on the owner's own list. Modelling it as a
  global phase boundary is what forces every unrelated packet to wait for it, so the barrier and the
  artificial latency are the same mechanism.
  Once the deepening layer's prerequisite is a dependency edge rather than a phase, there is nothing left
  for "wave" to mean: everything is gated by budget, rate, and dependency unlock, uniformly, and the
  in-process engine's continuous slot-pull becomes the only model. **The host path converges onto that
  engine rather than keeping a second scheduler** — the deviation is the host path, not the engine, and
  maintaining both is the fork this project's one-core rule exists to prevent.
  **Property to hold:** a packet is held for exactly three reasons — its dependencies are unmet, the pool
  is rate-limited, or the budget will not admit it. No fourth reason exists, and "the previous phase has
  not finished" is not one of them.
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
    **SPEC — build the tarball ONCE, assert many. Do not build an in-process smoke driver.** The two
    candidates are not equivalent: an in-process driver consolidates ORCHESTRATION, but the duplicated
    work is the REBUILD, so it optimizes the wrong axis and additionally weakens the smoke — the entire
    point is exercising the real packaged/global-install path, which nothing else catches, and running it
    in-process erodes exactly that. Meanwhile both smokes pack the identical package.
    Resolution: one build phase produces the tarball, and every packaged smoke installs from that same
    artifact into its own fresh sandbox and runs its own assertions. Smoke semantics are unchanged and
    coverage is untouched — only the redundant rebuild is removed. ⚠ The next-step round-trips are NOT a
    target: they are fresh-process pipeline runs and cutting them cuts real coverage.
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

- **SPEC — a ledger-blocked retry must back off, reusing the ONE backoff the project already owns.** A
  crashed sibling's orphan lease can block a packet for the full lease TTL (20 min). Waiting is CORRECT —
  it never double-grants — but the run loop retries on a fixed interval throughout, hammering the ledger's
  read-modify-write under a file lock once per pending packet (~24k lock cycles worst case). ⚠ Correcting
  this entry's earlier attribution: the retry interval is a bare `50` literal in the dispatch loop, not
  the named lease-TTL constant, so it is invisible to anyone grepping for a tuning knob.
  **Property to hold:** a retry blocked on a resource nobody has released does not poll at a fixed rate.
  Reuse the existing exponential backoff already single-sourced in the file-lock helper rather than
  introducing a second backoff implementation — the project's rule is one core, not two mechanisms that
  drift. Efficiency-only; never trade away the wait-rather-than-double-grant property to get it.
  ⚠ Heartbeat-renewed short leases would also solve it and restore fast crash recovery, but that is the
  long-claims heartbeat design, which carries its own unresolved question about who beats during an
  out-of-process worker run. Do not couple this to it — backoff stands alone and is strictly simpler.


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


## Forward tracks

- **Backend-identity axes — settle transport / service / locus once (design of record: [`spec/backend-identity-axes.md`](../spec/backend-identity-axes.md)).** The Gate-0 bypass (fixed v0.33.11) was one symptom of a naming defect: `provider` names TWO concepts (the adapter that carries a request vs. the vendor that serves the model), `endpoint` holds TWO shapes (URL vs. launcher command), and every downstream keyspace had to independently rediscover which it needed. Quota got it right, the gate got it wrong for months, and a proposed "one identity function" fix would have been fail-OPEN. The spec settles the vocabulary and the axis each question binds to; the invariant is **co-locate and name, do not unify**.
  **Staged migration — each stage atomic + green on its own (atomic-replace ordering invariant):**
  1. ✅ **SHIPPED 2026-07-19. Vocabulary.** `DispatchableSource.provider` → `transport`, `backend_provider` → `service`; normalize `service = declared ?? transport` ONCE at the source-gather chokepoint. Landed as four commits: the service-axis price fix, the 394-ref rename, the `id`-outranks-derivation precedence fix (+ populate-cache de-stamping + `PROXY_CATALOG_VERSION=2`), and a loud validator error for operator files still using the old names. ⚠ **Normalization went in `collectDispatchableSources`, NOT the `gatherDispatchableSources` wrapper** — both are exported, so the wrapper would have left a bypass. ⚠ **Residual:** normalization activates the declared-account fold for a source carrying `account` but no `service`, changing those CapacityPool ids and orphaning their learned `quota-state.json` keys (degrades to blind defaults — not a correctness break, but unmigrated). Record: [`identity-migration-stage1-plan-2026-07-19.md`](reviews/identity-migration-stage1-plan-2026-07-19.md).
     <br>*(original spec, retained for the stages below)* normalize at the `gatherDispatchableSources` chokepoint so it is never optional downstream (this alone kills the declaration-dependent fold fragility, where a direct source omitting `backend_provider` stopped folding with its proxied twin and re-prompted the operator). ~527 refs / 29 files, mechanical — but any site the classification pass flags as reading transport where it MEANS service is a behavior fix and must be split into its own commit, never smuggled into a rename.
  2. ✅ **SHIPPED 2026-07-20. Co-locate the projections.** All four now live in `src/shared/providers/identity.ts`, each documented with the question it answers: `backendIdentity` (gate) / `sourceService` / `quotaPoolKey` (ledger, was `buildProviderModelKey`) / `transportRoute` (routing filter, was the private `backendExclusionPattern`). Pure move — every call-site argument preserved. ⚠ **Deviation from the spec's literal "same module"**: the target was `providerConfirmation.ts`, but that file imports `dispatch/costRank.ts` → `quota/modelStatics.ts`, so quota importing it would point quota back at providers through dispatch. A LEAF module with zero value imports satisfies the spec's own stated rationale ("the lowest module both consumers can import") without the cycle. ⚠ **A claimed axis divergence here was FALSE and is not a follow-up**: `dispatchableSourceId` (the persisted ledger key) already passes `service` post-stage-1; the transport-passing sites are a documented-unreachable fallback and a throwaway key feeding `resolveAccountIdSafe`, not ledger keys. `apiPool.ts`'s doc comment had said `transport[#account]/…` since before stage 1 and was corrected.
  3. **`Locus` discriminated union** (`{kind:"url"} | {kind:"command"}`); host-tier rules apply only to URLs. Lowest priority of the five — justified BY stage 4, not independently (there is no live parsing bug; `endpointHosts` guards on `//`).
  4. **Axis-explicit exclusion grammar** (`transport:` / `service:` / `host:` / `model:`). Retires two defects outright: an unknown axis becomes a PARSE ERROR rather than a silently-inert host rule (the "typo'd rule matches nothing, silently" item), and `service:nim` closes every transport reaching that vendor. Carries a persisted-policy migration — one user, so MIGRATE rather than dual-parse.
  5. **Fail-closed autonomous write emits the `service` axis.** Closes the multi-transport residue durably: a transport snapshot decays the moment proxy expansion adds a route, a service rule does not. Touches `intakeExecutors.ts` → loop-core, attestation required.
  **Property to hold:** a new consumer PICKS an axis from the spec's table; it never invents an identity. ⚠ Do NOT collapse the keyspaces — that instinct is what produced both the bypass and the fail-open proposal.

- **One repo intent, three filenames — the audit/remediate intent split is a `one core, two draws` smell (surfaced by G3 recon 2026-07-16).** Audit's intent is `<root>/.audit-tools/audit/session-config.json` (`src/audit/supervisor/sessionConfig.ts:16` + `auditArtifactsDir`); remediate's is `<root>/.remediation-artifacts/session-config.json ?? <root>/session-config.json` (`src/remediate/steps/sessionConfigLoad.ts:63-67`, called from `nextStep.ts:1779-1783`); a stale guard-message in `claudeCodeProvider.ts:15`/`agyProvider.ts:9` still points operators at a third path, `.audit-tools/remediation/session-config.json`, that nothing reads — the wrapper itself no longer seeds it (`wrapper/remediate-code-wrapper-install-hosts.mjs:665-667` deliberately creates the config empty on demand). They are DISJOINT — audit never writes a file remediate reads as intent — which is precisely why the root-scoped `provider-confirmation.json` exists as the only cross-tool decision channel (`sharedProviderConfirmation.ts:4-9`). Two draws of one concept with three homes and no shared store. Unifying the path is a prerequisite for ever collapsing the Gate-0 artifact into the intent (a G3 draft proposed exactly that and was refuted on this). Too large to ride G3.
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
  ~0 by `deriveCostRank`, routed first, spill already handled.
  **SPEC — Phase 0 is the whole track. Phase 1 is RULED OUT, not deferred.** The multi-account
  subscription-OAuth store is dropped on terms-of-service grounds: it works by impersonating official
  CLIs, which is the same reasoning that already ruled out driving a Codex subscription off its CLI, and
  that ruling is standing. Carrying it as "later, opt-in, never default-on" keeps a design alive that
  will not be built and invites a future lap to re-litigate it — so it is closed, and the multi-account
  credential store it needs is not built either, which also retires the token-security surface (multiple
  refresh tokens at rest) that was the track's other named risk.
  **What remains is genuinely valuable and carries no ban or security risk:** registering every
  genuinely-free backend as its own source pool. That needs no new engine — pool identity, cost-first
  admission with spill, and per-key backoff already do the rotation — so this is configuration and
  validation, not a build.
  **Property to hold:** free capacity is saturated before any metered pool, and no dispatch path ever
  authenticates as a client it is not. Design of record + phased plan in memory
  [[arbitrage-dispatch-tier-design]] (⚠ its Phase 1 is superseded by this ruling);
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

- **models.dev static window can over-state a specific deployment (carried from W1).** The snapshot lists e.g.
  `claude-opus-4-7` at 1M context; a real headless run serving a 200k variant with discovery absent would over-size
  work blocks off the static rung. Mitigated by `BLOCK_SAFETY_MARGIN` 0.7 + discovered-capability always overriding —
  watch on a real headless metered run.

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
    lease with NO heartbeat.     ⚠ **The stated architectural gotcha is REFUTED — verified against source.** It held that a long claim
    spans an out-of-process worker run "where the parent isn't looping, so there is no natural beater."
    But the heartbeat is driven by a TIMER, not by a loop: `withClaimHeartbeat` arms `setInterval` and
    tears it down in a `finally`. A parent awaiting a spawned worker is still running its event loop, so
    the timer fires normally for the whole span — awaiting a child does not block timers. **The beater is
    the spawning process, and it already exists.**
    **SPEC — wrap the long-lived claims in the existing heartbeat; no new beating mechanism is owed.** And
    the failure mode this raises is the CORRECT one: if the spawning process dies, its heartbeat stops and
    the claim is reclaimed quickly — which is exactly the behavior the slice wants, since a dead parent's
    worker is orphaned anyway. What must be preserved is the ownership re-check before persist, so a claim
    revoked mid-run cannot still land its result.
    ⚠ Re-verify the timer behavior before building — this refutation is one reading of one function, and
    a premise this load-bearing has already been wrong once here. This is a FOCUSED-LAP track — the most delicate
    machinery in the repo (pause/claim/quota), a genuine divergence to respect, and the owner's own
    "redesign before scheduled autonomy" caution applies; do NOT rush it as a tail-end change.


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
- **SPEC — measure the churn before building anything; the deferral condition IS the next action.**
  Prose-heavy artifact fields feed downstream LLM prompts, and content-hash staleness means a cosmetic
  reword cascades an expensive re-emit. The proposed narrowing is bounded semantic judgment on whether
  meaning changed, fail-safe to re-derive. It has been deferred "until the churn is measured" — but
  nothing measures it, so the deferral is self-perpetuating and the question is currently being settled by
  guesswork either way.
  **The next action is instrumentation, not the classifier.** Record, per dependency edge that triggers a
  refresh, the size and nature of the source change and the downstream token cost it caused. That yields
  the number the decision needs. Build the classifier only if the measured cascade cost justifies it.
  **Property to hold:** an efficiency mechanism is justified by a measured cost, never by an estimate of
  one. ⚠ Building the bounded classifier now would replace a hash threshold with a judgment threshold that
  is itself a guess — a manual flag wearing research clothing.

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

- **`rtk npm run <script>` fails with "program not found" from the Bash (Git Bash) tool
  (2026-07-20, inefficient-feeding, low).** `rtk npm run build` / `rtk npm run check` both die with
  `Error: Failed to run npm run / Caused by: program not found`; rtk cannot resolve the `npm` shim
  under Git Bash. Plain `npm run …` works fine from the same shell. So the global "always prefix with
  rtk" rule silently costs a round-trip on every build/check unless you already know this. Workaround:
  use plain `npm run …` from Bash, or route rtk-wrapped npm through the PowerShell tool instead.

- **An offload-lane model will fabricate SUPPORTING QUOTES while getting the STRUCTURE right
  (2026-07-20, medium).** A NIM (`glm-5.2`) call to verify an axis claim returned an accurate
  per-call-site breakdown that correctly refuted the claim — but attributed sentences to
  `spec/backend-identity-axes.md` that actually came from the just-written source file passed in the
  same call, and invented a verbatim "host quota pools … still key on transport or host identity"
  quote from the identity module that exists nowhere. The lane's structural analysis was worth the
  call; every citation in it was worthless. Treat quoted evidence from the lane as the LEAST reliable
  part of its output, not the most — the opposite of the intuition that a quote is checkable proof.
  ([[offload-lane-failures-are-usually-the-caller]] is about weak-looking output; this is the inverse
  failure — confident output with fake support.)

- **`agy -p` treats its OWN CLI flags as the research topic — never pass `--dangerously-skip-permissions` with a real task.** Two consecutive dispatches of a
  provider-confirmation analysis came back as an essay about `--dangerously-skip-permissions` itself:
  agy grepped the repo for `"dangerously"`, then web-searched the Antigravity permissions docs, and
  answered *that* instead of the prompt. Moving the task text into a file and passing `"$(cat file)"`
  did NOT help — the flag is still in argv, and that is what it latches onto. Worse, in the derailed
  run it began executing `audit-code.mjs next-step` against the live repo unprompted (no tracked file
  changed, but it was one step from mutating `.audit-tools/` state). **Use:** prefer codex or the NIM
  lane for repo analysis; if agy is required, do not combine a substantive prompt with that flag.
- **`rtk` is NOT installed on this box** — every `rtk <cmd>` fails `program not found`, including inside
  `&&` chains, which kills the whole chain. The global CLAUDE.md says to always prefix with `rtk`; that
  instruction is unrunnable here. Drop the prefix (or install rtk) rather than retrying.
- **`codex exec` hangs forever waiting on stdin — always redirect `< /dev/null`.** A backgrounded
  `codex exec --sandbox read-only "<prompt>"` printed `Reading additional input from stdin...` and
  sat at 39 bytes of output indefinitely, looking exactly like a slow model. It is not: codex reads
  stdin even when the prompt is a positional arg. **Use:** `codex exec … "<prompt>" < /dev/null`.
  Cost a full wasted background run during the 2026-07-19 memory pass.

- **The LiteLLM/NIM offload lane rate-limits hard above ~2 concurrent requests per model.** A 10-batch
  fan-out at concurrency 10 (and again at 3) returned
  `litellm.RateLimitError … Error code: 429` on nearly every batch, and NIM has no fallback group
  configured. **Use for any bulk pass:** concurrency ≤2, rotate the `model` across the roster
  (`glm-5.2`, `deepseek-v4-pro`, `minimax-m3`, `qwen3.5-397b`, `nemotron-3-ultra-550b`) per batch AND
  per retry, escalating backoff. Also make the driver **resumable** (skip already-processed items,
  merge into the output file) — a long fan-out will lose batches, and two concurrent writers to one
  output file will clobber each other's progress. Distinct from
  [[offload-lane-failures-are-usually-the-caller]]: this one really is the endpoint, and
  `finish_reason` is `undefined` (not `length`) because the body is an error, not a completion.

- **`git checkout -- <file>` silently destroys unstaged work when a review round is staged.** Common
  during review-driven rework: you `git add -A` to give reviewers a stable diff, keep editing in the
  working tree, then use `git checkout -- <file>` to undo a temporary mutation-test edit. That
  restores from the INDEX, i.e. the pre-rework staged version — so every unstaged fix to that file is
  gone, with no warning and a clean-looking tree. Bit once during account-metering step 2 (lost an
  `assertWindowScopes` call + its import; caught only because a red-green mutation then behaved
  impossibly). **Use instead:** copy the file to the scratchpad before mutating and `cp` it back, or
  `git stash` the mutation. Never `git checkout --` a file that has unstaged work you want.

- **`codex exec "<prompt>"` HANGS when stdin is a non-TTY pipe.** With a prompt passed as an argument,
  Codex still reads stdin to append as a `<stdin>` block; under any harness that leaves stdin open
  (background tasks, CI, most spawn wrappers) it blocks forever on "Reading additional input from
  stdin…" and is killed by the timeout with **exit 0 and empty output**. Silent — it looks exactly like
  a model that returned nothing. **Always `codex exec … </dev/null`**, or pass the prompt ON stdin
  instead of as an argument. Same class as the Windows `npx.cmd` shim trap: an offload lane that fails
  silently reads as a capability gap in the backend rather than a wiring bug on our side. Any dispatch
  worker spawning `codex` must close its stdin explicitly at the spawn site.

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
- **The free offload lane is the local LiteLLM proxy — it must be RUNNING, and the model must be one of
  its aliases.** `llm-worker-tools` (`llm read`/`llm write`) is retired; requests go to
  `127.0.0.1:4000` (see `~/.claude/CLAUDE.md` → *Offload lane*). Two consequences: (a) unlike the old
  CLI there is no standalone fallback — if the proxy is down the whole lane is down, so a failing
  offload means "start the proxy", not "the backend is broken"; (b) `--model` must name a LiteLLM alias
  from `~/.audit-code/litellm-config.yaml` (`glm-5.2`, `deepseek-v4-pro`, …), not a raw NIM catalog id
  and not `haiku`. Offloading to *Claude Haiku* is a separate lane (Agent tool `model: haiku`),
  unrelated to the proxy.
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
- **`rtk` cannot resolve `npm` — every `rtk npm run <script>` dies "program not found",** from both the
  Bash tool and PowerShell. So the token-saving wrapper is unusable for the most-run command class in
  this repo (`build` / `check` / `test` / `check:deadcode`) and every verify falls back to raw `npm`,
  forfeiting the filtering on exactly the noisiest output. Presumably `rtk` resolves `npm` as an exe
  rather than through the Windows shim (`npm.cmd`) — same class as `resolveWindowsShimSpawnCommand`.
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
