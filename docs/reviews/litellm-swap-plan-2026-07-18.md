# Proxy-transport swap plan — repair-proxy retired, generic proxy contract (2026-07-18)

Dated plan record for the proxy-transport replacement. Inputs: coupling inventory + LiteLLM surfaces
recon (scratchpad, 2026-07-18), owner-decision memory [[litellm-replaces-repair-proxy]], backlog entry
"LiteLLM replaces repair-proxy" (docs/backlog.md:52), and the owner's decoupling directive
(2026-07-18, governing constraint — see Goal). All recon claims below re-verified against HEAD
65936dd4 this session; every file:line in the ground-truth table was read/grepped directly.

## Goal (from owner decision)

Owner decision of record (2026-07-17): **repair-proxy is retired; LiteLLM replaces it** as the proxy
deployment fronting free/arbitrary backends for `claude-worker` spawns.

Governing constraint (owner directive, 2026-07-18): **decouple transport and model ranking from
audit-tools.** Transport is an external project; model ranking is an external project; audit-tools is
agnostic to both. Concretely:

- audit-tools must NOT grow a LiteLLM-shaped module the way it had a repair-proxy-shaped one. The
  declaration block is proxy-brand-**generic**, and discovery/liveness target a **neutral contract**:
  an OpenAI-compatible surface (`/v1/models`; `/model/info` if present; `/health/liveliness` if
  present) with graceful degradation when optional surfaces are absent. LiteLLM specifics are allowed
  only as one thin, clearly-bounded shape adapter at the edge — nothing downstream knows the brand.
- Capability/rank data is a **consumed input contract** (operator-declared rank, models.dev-synced
  table, or absent → the existing fail-open floor). No leaderboard fetching, syncing, or scoring logic
  inside audit-tools — now or in any future integration.
- What audit-tools sees at the seam: `(endpoint, auth, advertised models + limits + prices, optional
  ranks)`. Which proxy serves it and who computes ranks are other projects' concerns.

What survives unchanged: pool identity `backend_provider[#account]/model`, the `claude-worker` worker
kind, the unified routing decision. What is deleted: the `GET /registry` discovery shape, the
`repair_proxy` declaration key, `/registry` liveness probes, and every repair-proxy assumption
(dummy-key auth, slash-namespace `--model` composition, stale-while-revalidate comments). Ideal-code
rules apply: one user, delete the legacy path, single atomic replace, no back-compat shims.

## Verified ground truth

Every row checked this session against source (not recon-trusted).

| # | Claim | Evidence (verified) |
|---|---|---|
| G1 | `repair_proxy` block has exactly ONE reader: `readRepairProxyDeclaration` | `src/shared/providers/auditorSources.ts:219-265` parses it (`:234` key access); grep `repair_proxy` across `src/` hits only auditorSources + comment sites (nextStepCommand.ts:386, proxyCatalog.ts:71,74) |
| G2 | `GET <endpoint>/registry` has exactly 3 request sites | `auditorSources.ts:465` (verifySourceReach), `:528` (resolveRepairProxyLane), `proxyCatalog.ts:433` (populate fetch; error prose :438,:447) |
| G3 | Registry parse is tolerant, never reads `routing`/`capability_source` | `proxyCatalog.ts:163-233` (`extractRegistryModels`); `capability_source` grep = 0 hits in src/, 6 in docs (backlog.md ×1, docs/reviews/unified-dispatch-routing-design-2026-07-17.md ×5) |
| G4 | Populate-time per-model probe is Anthropic-shaped `POST <endpoint>/v1/messages`, dummy `x-api-key: audit-tools-populate-probe`, 404/model-not-found drops, transport-failure fail-open | `proxyCatalog.ts:302-351` (`:311` URL, `:314` header, `:327-341` drop, `:345-347` keep) |
| G5 | Expansion emits `id: claude-worker:<provider>/<model>`, `worker_kind:"agentic"`, operator cost wins, `capability_rank` + `quota.context_tokens` stamped when present | `proxyCatalog.ts:243-295` (`:276-291`) |
| G6 | Worker argv composes `--model <backend_provider>/<model>` at launch | `claudeWorkerProvider.ts:160-166` (`:163`) |
| G7 | Worker env overlay: `ANTHROPIC_BASE_URL=endpoint`, `ANTHROPIC_API_KEY=` dummy sentinel `"audit-tools-claude-worker"`, isolated `CLAUDE_CONFIG_DIR` | `claudeWorkerProvider.ts:29` (sentinel), `:180-184` (overlay) |
| G8 | verifySourceReach REFUSES inline `api_key` on claude-worker and names `api_key_env` as the future form | `auditorSources.ts:456-462` (reason text `:460`) |
| G9 | Liveness probe budgets are `[1_000, 4_000]` ms escalation; the "~750ms budget" comment is stale | `auditorSources.ts:124-132` (`:126` budgets), stale comment `:62`; stale server-behavior comment "proxy side also serves /registry stale-while-revalidate" `:112` |
| G10 | Capability floor fails OPEN on score-less pools (owner decision, already tagged) | `proxyCatalog.ts:119-125` docblock cites [[litellm-replaces-repair-proxy]]; `admissionLoop.ts` `buildCapabilityFloorCapable` UNKNOWN fail-open (recon §4; floor reads only pool fields) |
| G11 | Drop-reason ids are `repair-proxy` / `repair-proxy:<endpoint>`; lane resolve reads cache only, declared-wins dedup on `backend_provider/model` | `auditorSources.ts:521,:526,:566-579` |
| G12 | "repair-proxy url" prose sites in src/ | `validation/sessionConfig.ts:220`, `claudeWorkerProvider.ts:70`, `auditorSources.ts:450`, `apiPool.ts:157` (grep-complete) |
| G13 | Audit populate trigger + stderr warning names "repair-proxy registry populate" | `nextStepCommand.ts:381-400` (`:395`) |
| G14 | Example declaration carries `repair_proxy` block + a hand-declared claude-worker source with split `backend_provider:"nim"` / `model:"z-ai/glm-5.2"` | `examples/catalog/sources-declared.json:12-25` |
| G15 | Test surface pinning repair-proxy shapes: proxy-catalog (46 hits), repair-proxy-lane (29), gate0-proxy-fold (3), claude-worker-provider (2), claude-worker-source (1), examples-session-config (4) | grep `registry\|repair[-_]proxy\|audit-tools-claude-worker` over tests/shared (claim-lease/effective-context-window/deliverable-paths hits are the unrelated ClaimRegistry — false positives) |
| G16 | Loop-core set: `src/shared/dispatch/`, `src/shared/quota/` ARE loop-core; `src/shared/providers/`, `src/audit/cli/nextStepCommand.ts`, `src/remediate/steps/sessionConfigLoad.ts` are NOT | `src/shared/loopCorePaths.ts:26-47` |
| G17 | Backlog entry exists and matches the memory | `docs/backlog.md:52` |

## Review outcomes (2026-07-18, 3-slice adversarial)

- **Slice A** refuted the roster-only silent-degradation worry: context cap fallback chain declared → models.dev → `DEFAULT_CONTEXT_TOKENS=32_000` means `contextCapTokens` is never null; fit gate always real. Confirmed auth threading complete.
- **Slice C** confirmed atomic touch list complete; all 3 regression pins red-on-HEAD (`--model <alias>` verbatim, `ANTHROPIC_AUTH_TOKEN` overlay, legacy `repair_proxy` key → dropped reason); loop-core = `apiPool.ts` + `admissionLoop.ts` + `costRank.ts` (prose-only edits, attestation required).
- **Slice B** identified then **REFUTED** blocking defect claim: `src/shared/quota/openCodeQuotaSource.ts:77` derives provider via `model.split("/")[0]`. Refutation: `handlesProvider` guard (line 68) gates this quota source to opencode provider names exclusively, so opaque-alias pools cannot reach it; the slash split is the opencode quota key's own documented namespace convention (docstring lines 15–23). Reviewer cited real line numbers but never traced the provider gate — another instance of the standing "a gate must be traced, not assumed" lesson.

Proxy surface facts (from the LiteLLM surfaces recon; **verify against a live proxy before hard-coding**
— `litellm_version` via `/health/readiness`): `/v1/models` is the OpenAI-standard list
(`{data:[{id,...}]}` — alias ids only, no provider/cost/context); `/model/info` is LiteLLM's richer
surface (`{data:[{model_name, litellm_params:{model,api_base,...}, model_info:{litellm_provider, mode,
max_input_tokens, input_cost_per_token, output_cost_per_token, supports_function_calling, ...}}]}`,
with an older `{model_name:{...}}` map form); `/health/liveliness` is unauthenticated liveness;
`GET /health` fires REAL per-model calls; `POST /v1/messages` is an Anthropic-compatible endpoint (any
backend, translated); Claude Code fronting uses `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`; master
key optional — keyless proxy is open, keyed proxy 401s unauthenticated calls.

## The neutral proxy contract (what audit-tools targets)

Everything downstream of this section is written against this contract, never a brand:

| Surface | Status | audit-tools behavior |
|---|---|---|
| `GET /v1/models` (OpenAI list) | **required baseline** | model roster: `data[].id` = the proxy-facing routing alias |
| `GET /model/info` (rich advert) | optional | enrichment: provider identity, context caps, prices, capability booleans, operator custom keys. Absent/unparseable → roster-only degradation |
| `GET /health/liveliness` | optional | liveness probe target; absent → degrade to `/v1/models`-answers-HTTP as liveness |
| `POST /v1/messages` (Anthropic-compatible) | required for the claude-worker lane | worker transport + per-model populate probe |
| Auth | optional bearer key via `api_key_env` | keyless endpoint = no header; keyed = `Authorization: Bearer` on HTTP calls, `ANTHROPIC_AUTH_TOKEN` on spawns |

The ONE brand-aware unit is a thin shape adapter (a single function set inside `proxyCatalog.ts`, or a
sibling `proxyAdvertShape.ts`) that maps a `/model/info` row → the neutral internal
`ModelAdvert {alias, provider?, context_tokens?, input_cost_per_token?, output_cost_per_token?,
mode?, supports_tool_calls?, declared_rank?}`. Its docblock names the LiteLLM-documented shape it
parses; **no symbol outside it carries the brand**, and a future different proxy adds a sibling
mapping, not a fork downstream.

## Decisions

### (a) Declaration shape — generic `proxy` block (resolved by owner directive)

Replace the top-level `repair_proxy` key of `~/.audit-code/sources-declared.json` with:

```json
"proxy": { "endpoint": "http://127.0.0.1:4000", "top_k": 2, "cost_per_mtok": 0, "api_key_env": "PROXY_MASTER_KEY" }
```

(`top_k`, `cost_per_mtok`, `api_key_env` optional; endpoint canonicalization + per-knob tolerant-drop
semantics carry over 1:1 from `readRepairProxyDeclaration`.) No `kind` discriminator: the block
declares "an OpenAI-compatible proxy with an Anthropic-compatible `/v1/messages` listens here" — the
neutral contract above — and shape variance is absorbed by discovery-time degradation, not a
declared brand switch. Renames: `ProxyDeclaration` / `readProxyDeclaration` / `resolveProxyLane`;
drop-reason ids `proxy` / `proxy:<endpoint>`.

Legacy key: **no back-compat alias.** A declaration still carrying `repair_proxy` gets one
`dropped[]` entry — `{id:"proxy", reason:"repair_proxy is retired — declare a proxy block"}` — so the
retirement fails loud, not silent. This is a migration-error surface (one line in the reader reusing
the existing malformed-block dropped[] channel), not a compat shim. *(Minor owner call: pure silence
is defensible; loud is recommended per fail-open-with-reason house style.)*

### (b) Discovery mapping — `/v1/models` baseline, `/model/info` enrichment via the edge adapter

Populate (auth per (d)):

1. `GET <endpoint>/v1/models` → roster of aliases (`data[].id`). Fetch failure/unparseable →
   `{written:false, reason}`, prior cache untouched (today's degrade semantics).
2. `GET <endpoint>/model/info` → if it answers with a parseable shape, the edge adapter joins
   enrichment onto the roster by alias (`model_name`). Absent (404) / unparseable / partial →
   roster-only expansion; filtered-never-thrown per row (preserving `extractRegistryModels`' degrade
   discipline). Parse only the current `{"data":[...]}` array form; older map form `{model_name:{...}}`
   degrades loudly (no back-compat tolerance — owner directive: legacy paths deleted, single atomic replace).

Per-alias `DispatchableSource` mapping (all enrichment fields degrade to absent):

| DispatchableSource field | Neutral-contract source | Degradation when `/model/info` absent |
|---|---|---|
| `model` | the roster alias, **verbatim** (the only id the proxy routes on — see (e)) | — |
| `backend_provider` | advert provider (`litellm_provider` via adapter; fallback: prefix of the underlying `<provider>/<model>` param) | prefix of the alias before the first `/` when slash-formed; else `"proxy"` (one shared pool — **owner decision 2026-07-18**, degraded rung of neutral contract, revisitable) |
| `endpoint` | declared `proxy.endpoint` | — |
| `worker_kind` | `"agentic"` | — |
| `cost_per_mtok` | operator `cost_per_mtok` wins (unchanged precedence); else mean of advert input/output per-Mtok prices (whichever present when only one) | absent → models.dev catalog downstream |
| `quota.context_tokens` | advert `max_input_tokens` (the input window is what packet-fit gates on; output caps are not context) | absent |
| `capability_rank` | advert operator-set custom key `capability_rank` when present (consumed rank input — see (f)) | absent → fail-open floor |
| `api_key_env` | declared `proxy.api_key_env`, stamped on every expanded source | — |
| `id` | `claude-worker:<backend_provider>/<model>` | unchanged form |

Eligibility filters (replacing repair-proxy's `reachable/has_key` gate, which the neutral contract
does not serve): advert `mode` present and ≠ `"chat"` → skip (embeddings/TTS/image cannot be agentic
workers); `supports_tool_calls === false` → skip (a `claude -p` worker requires tool calls);
null/absent → **keep** (unknown ≠ incapable — unlisted models carry no advert). Reach/key truth comes
from the surviving per-alias `POST /v1/messages` probe (G4), which drops 404/model-not-found: the
roster means "configured", the probe means "live". *(Owner decision, 2026-07-18: cost blend = mean of
input/output $/Mtok.)*

Dedup, top-K per provider, stable content-derived ordering, `POPULATE_CACHE_FRESH_TTL_MS`, cache
filename `catalog-cache.json`, and `readProxyCatalog` validation carry over unchanged. Module keeps
its neutral name `proxyCatalog.ts`.

### (c) Liveness — `/health/liveliness` first, roster fallback, escalating budgets kept

Both resolve-side probe sites (`auditorSources.ts:465`, `:528`) switch from `${endpoint}/registry` to
the neutral liveness rule: `GET <endpoint>/health/liveliness` counts alive on 2xx; when that path is
absent (non-2xx/no answer), one fallback attempt `GET <endpoint>/v1/models` counts alive on **any HTTP
status** (a 401 from a keyed proxy still proves a listening proxy — the sync probe stays keyless).
**Never `GET /health`**: it fires a real model call per configured deployment (slow + spends tokens) —
a pinned test asserts the probed URLs so this cannot regress. `probeReachableWithEscalation` with
`[1_000, 4_000]` ms budgets survives verbatim (the cold-drop lesson is proxy-independent). Delete the
stale "~750ms budget" comment (`:62`) and the repair-proxy stale-while-revalidate rationale (`:112`).

### (d) Auth — optional `api_key_env`, `ANTHROPIC_AUTH_TOKEN` overlay, keyless default

- **Declaration:** optional `proxy.api_key_env` names the env var holding the proxy's key. Absent →
  keyless local proxy assumed.
- **Populate:** the `/v1/models` + `/model/info` fetches and the per-alias `/v1/messages` probe send
  `Authorization: Bearer <env value>` when `api_key_env` is declared and set; no header when keyless.
  The probe's dummy `x-api-key: audit-tools-populate-probe` (G4) is deleted — a keyed proxy 401s a
  dummy, and the probe's fail-open on 401 would silently keep sources whose launches then all 401
  (exactly the silent-drop class the memory warns about).
- **Worker overlay** (`claudeWorkerProvider.ts:180-184`): set
  `ANTHROPIC_AUTH_TOKEN: <resolved key, or the dummy sentinel when keyless>` alongside the existing
  `ANTHROPIC_BASE_URL` + isolated `CLAUDE_CONFIG_DIR`. Keep overwriting `ANTHROPIC_API_KEY` with the
  dummy sentinel unconditionally — the never-leak-the-ambient-real-key property (G7) is
  transport-independent and stays. Key resolution happens at launch from `process.env` via the
  source's stamped `api_key_env` (same-env rule, G2.5).
- **Reach check** (`auditorSources.ts:441-471`): keep the inline-`api_key` refusal (G8) verbatim;
  additionally, when the source carries `api_key_env`, require the var to be set (unset → dropped with
  reason, mirroring the openai-compatible possession-vs-reach split). Probe URLs per (c).

### (e) Worker routing — `--model <alias>` verbatim against the Anthropic-compatible endpoint

**Routing key:** the neutral contract routes solely on the roster alias. The slash-namespace
composition `--model ${backend_provider}/${model}` (G6) is a repair-proxy contract assumption and is
**deleted**: `ClaudeWorkerProvider` passes `--model ${this.model}` verbatim, and populate writes
`model` = the alias the roster listed (b). Tool-enforced correctness — the argv can never name a route
the proxy doesn't serve, and no "configure your aliases as provider/model" operator convention exists
for the tool to depend on (a convention someone must remember is the latent-failure class CLAUDE.md
bans). Hand-declared claude-worker sources follow the same contract: `model` = the proxy-facing alias,
`backend_provider` = upstream identity only (never argv). Declared-wins dedup and pool identity keep
working unchanged on `backend_provider/model`.

**Endpoint:** the worker overlay points `ANTHROPIC_BASE_URL` at the declared endpoint, whose
`/v1/messages` is the contract's Anthropic-compatible slot — brand-free. Tradeoff stated: a
translating proxy covers standard tools/tool_choice (what Read/Edit/Bash agentic workers use) but may
lag on exotic Anthropic features (fine-grained tool streaming, server tools). Deployment guidance —
e.g. LiteLLM's `/anthropic` verbatim-passthrough path for full-fidelity Anthropic-only workers —
lives ONLY in docs/examples: the operator declares `endpoint: "<proxy>/anthropic"`; endpoint is
already data, so no code branch or mode knob exists. Bare-endpoint default already wired via
`ANTHROPIC_BASE_URL` per (d); per-source endpoint override is the fidelity escape hatch already in place.

### (f) Capability/rank — nothing to build; ranking stays an external project

Stated explicitly so nobody rebuilds a leaderboard sync: the neutral contract serves **no capability
score**, and that is already handled. `deriveScore`/`deriveRawCapabilityRank`'s registry `capability`
block support dies with the `/registry` extractor; score-less pools land in
`buildCapabilityFloorCapable`'s UNKNOWN → **fail-open** path (G10, owner decision 2026-07-17, already
tagged in source) — eligible at every floor, loud via the `onFailOpen` observer. Price + context stamp
from the advert per (b); models.dev/costRank supplies catalog price downstream unchanged.

Rank data audit-tools will consume, ever, is an **input contract only**: operator-declared
`capability_rank` (on a source, or as a proxy-side custom advert key that round-trips through
`/model/info`), or a someone-else-maintained synced table (models.dev family). Any FUTURE ranking
integration is a consumed file/endpoint shape feeding `capability_rank` — never fetching, syncing, or
scoring logic inside audit-tools. That computation is a separate project's concern.

### (g) Atomic replace — one commit, exact touch list

One commit lands the neutral-contract adapter AND deletes every `/registry`/`repair_proxy` surface
(CLAUDE.md atomic-replace invariant — never add-then-delete across commits). Verified touch list:

**Source (behavior):**
1. `src/shared/providers/proxyCatalog.ts` — neutral discovery (`/v1/models` roster +
   `/model/info` enrichment via the one edge shape adapter) replaces `extractRegistryModels` + the
   `/registry` fetch (:163-233, :433-447); probe auth per (d) (:314); expansion alias/field mapping per
   (b) (:243-295); docblocks.
2. `src/shared/providers/auditorSources.ts` — `ProxyDeclaration`/`readProxyDeclaration` replace the
   `RepairProxy*` pair (:198-265) + `api_key_env` knob + legacy-key dropped reason; `resolveProxyLane`
   rename with drop ids `proxy`/`proxy:<endpoint>` (:514-580); both probe sites → liveness rule (c)
   (:465, :528); reach-check `api_key_env` presence rule (:441-471); delete stale `~750ms` (:62) and
   stale-while-revalidate (:109-115) comments.
3. `src/shared/providers/claudeWorkerProvider.ts` — verbatim `--model` (:160-166);
   `ANTHROPIC_AUTH_TOKEN` overlay + `api_key_env` resolution (:180-184); sentinel/docblock/error prose
   (:24-29, :69-71, :78-96).
4. `src/shared/validation/sessionConfig.ts` — message prose (:220).
**Source (prose/comments only):**
5. `src/shared/types/sessionConfig.ts` (:156, :30-37 area docs) · 6. `src/shared/quota/apiPool.ts`
   (:77, :157) · 7. `src/shared/dispatch/admissionLoop.ts` (:65, :385) ·
8. `src/shared/dispatch/costRank.ts` (:176, :218 — "operator/registry-declared" →
   "operator/advert-declared") · 9. `src/shared/providers/providerConfirmation.ts` (:487 etc.) +
   `sharedProviderConfirmation.ts` + `src/shared/types/providerConfirmation.ts` ·
10. `src/audit/cli/nextStepCommand.ts` (:381-400 comment + WARNING text) ·
11. `src/remediate/steps/sessionConfigLoad.ts` (comments) · 12. `src/shared/io/stateDir.ts` (:7).
**Examples:** 13. `examples/catalog/sources-declared.json` — `proxy` block; hand-declared source's
`model` becomes the alias form per (e) · 14. `examples/README.md` (deployment guidance, incl. the
LiteLLM `/anthropic` endpoint note — the only place a brand may appear, as an example deployment).
**Tests:** per (h) — `proxy-catalog.test.mjs` rewrite, `repair-proxy-lane.test.mjs` →
**`proxy-lane.test.mjs`** rename+rewrite, `gate0-proxy-fold.test.mjs`,
`claude-worker-provider.test.mjs`, `claude-worker-source.test.mjs`,
`examples-session-config.test.mjs`, `tests/helpers/state-dir-setup.mjs` (comment), comment-only
renames in `provider-confirmation-cost.test.mjs` / `admission-loop.test.mjs`.
**Docs (same commit):** 15. `docs/backlog.md` — delete entry :52 (shipped) · 16.
`docs/reviews/unified-dispatch-routing-design-2026-07-17.md` — one-line superseded note at its 5
`capability_source` mentions' section head (dated record: annotate, don't rewrite history) · 17.
`CLAUDE.md` providers paragraph (`claude-worker` description names repair-proxy → "the declared
proxy") · 18. `spec/unified-dispatch-worker-model.md` (18 refs — timeless spec, reworded to the
neutral proxy contract, not annotated) · 19. `docs/HANDOFF.md`. Memory sync (litellm memory →
shipped/generic-contract status; repair-proxy-registry memory already marked RETIRING) follows at
sprint close per standing rule.

Not touched (verified transport-agnostic, G16/recon §7): pool identity + quota/admission substrate,
capability-floor logic, Gate-0 roster, worker-kind classification, provider-factory exclusion,
state-dir hermeticity, `resolveProxyCatalogPath`/cache filename, `populateDeclaredProxyCatalog` /
`populateProxyCatalogIfMissing` export names (generic already).

Brand-name budget check: after this commit, `litellm`/`LiteLLM` appears in src/ ONLY inside the edge
shape adapter's implementation + docblock; `repair-proxy` appears nowhere outside dated
`docs/reviews/*` records. A grep for both is part of the execution checklist.

### (h) Test plan

**Rewritten:**
- `proxy-catalog.test.mjs` — discovery half re-pinned: roster fetch URL literally
  `<endpoint>/v1/models`; enrichment URL `<endpoint>/model/info`; shape-adapter fixtures **verbatim
  from the recon's documented example responses** (the OpenAI `/v1/models` list, the `/model/info`
  `{"data":[...]}` array form only — no legacy back-compat for older map form) so the adapter is pinned
  to documented shapes, not invented ones; **degradation pins**: `/model/info` 404/unparseable →
  roster-only sources (alias-derived/`"proxy"` provider, no cost/context) — the graceful-degradation
  half of the neutral contract must be red-green tested, not assumed; mode/`supports_tool_calls`
  eligibility (false → skipped, absent → kept); alias-as-`model` mapping; `max_input_tokens` →
  `quota.context_tokens`; cost blend + operator-cost precedence; consumed `capability_rank` advert key.
  Survives with fixtures updated: top-K, dedup, stable order, degrade-never-throw, cache filename, TTL
  throttle, `/v1/messages` probe drop/fail-open. Dies with the extractor: provider-MAP `/registry` form,
  `capability.composite_rank`/`arena_rank` score pins, `reachable/has_key` gate pins.
- `repair-proxy-lane.test.mjs` → **`proxy-lane.test.mjs`** — declaration reader (`proxy` key,
  malformed-block reasons, `api_key_env` knob), liveness rule pins (`/health/liveliness` 2xx alive;
  fallback `/v1/models` any-HTTP alive; **never `/health`**), drop ids `proxy`/`proxy:<endpoint>`,
  declared-wins dedup, populate-if-missing no-fetch cases, **legacy `repair_proxy` key → dropped[]
  reason**.

**Updated:** `gate0-proxy-fold.test.mjs` (declaration block key; expanded-source shape) ·
`claude-worker-provider.test.mjs` (overlay pins: `ANTHROPIC_AUTH_TOKEN` set from `api_key_env` /
sentinel when keyless; ambient `ANTHROPIC_API_KEY` still never leaks; argv pin `--model <alias>`
verbatim) · `claude-worker-source.test.mjs` (liveness URLs; `api_key_env`-unset → dropped; inline-key
refusal kept) · `examples-session-config.test.mjs` (`proxy.endpoint` assertion) ·
`state-dir-setup.mjs` helper comment.

**Unchanged:** `state-dir.test.mjs` (path routing only), `admission-loop.test.mjs` /
`provider-confirmation-cost.test.mjs` (behavior generic; comment renames only). **Deleted files:
none** — every file maps onto surviving behavior.

**New pins (and their class):**
1. Neutral-contract discovery over the verbatim doc fixtures, including roster-only degradation —
   contract pin.
2. Liveness URLs are `/health/liveliness` then `/v1/models`, and **never** `/health` (assert literal
   URLs; the real-model-call footgun must be unrepresentable) — contract pin.
3. Auth: discovery fetches + `/v1/messages` probe carry `Authorization: Bearer` iff `api_key_env`
   declared+set; no dummy `x-api-key` remains — contract pin.
4. **Regression-class, red-green mandatory** (reintroduce-the-defect rule): (i) argv is the alias
   verbatim — must FAIL against the old `${backend_provider}/${model}` composition before the fix;
   (ii) `ANTHROPIC_AUTH_TOKEN` present in the overlay — must FAIL against the old overlay;
   (iii) legacy `repair_proxy` key surfaces a dropped reason — must FAIL against the old reader (which
   happily parsed it). Each shown red on pre-swap code (run the new test file against HEAD before the
   source change lands in the working tree), then green after.

### (i) Loop-core classification

From `src/shared/loopCorePaths.ts:26-47`, touched files under the attestation gate:
- `src/shared/quota/apiPool.ts` (comment-only edit) — **loop-core** (`src/shared/quota/`).
- `src/shared/dispatch/admissionLoop.ts`, `src/shared/dispatch/costRank.ts` (comment-only) —
  **loop-core** (`src/shared/dispatch/`).

Everything else touched (`src/shared/providers/*`, `src/shared/types/*`, `src/shared/validation/*`,
`src/shared/io/stateDir.ts`, `src/audit/cli/nextStepCommand.ts`,
`src/remediate/steps/sessionConfigLoad.ts`, examples, tests, docs) is **outside** the loop-core set.
Because the one atomic commit stages the quota/dispatch comment edits, the pre-commit gate requires a
fresh staged-tree-bound review attestation (`node .claude/hooks/attest-loop-core-review.mjs …`) — run
the attest as its own Bash call before `git commit` (the chained `attest && commit` form is blocked;
backlog friction note 2026-07-18). The loop-core edits are prose-only, which makes the attested review
cheap but does not exempt it.

### Out-of-scope follow-ups (candidate cleanup under owner no-legacy rule)

Owner directive (2026-07-18): legacy and back-compat paths have no place in this project. The current
plan applies it to `/model/info` dual-form tolerance (deleted) and the `repair_proxy` key rejection
(loud dropped reason, no compat shim). Pre-existing legacy-compat folds survive outside this diff's
scope and are candidates for future cleanup:
- `src/shared/quota/apiPool.ts` lines ~370-371, ~497-498 — legacy `openai_compatible` block fold in
  credential resolution, per-pool cost handling.
- `src/shared/types/sessionConfig.ts` lines ~700-701 — legacy `openai_compatible` block fold in schema.

## Phantom fix & revert record

A context-parameter refactor was implemented across `src/shared/quota/openCodeQuotaSource.ts`,
`src/shared/quota/apiPool.ts`, `src/shared/quota/httpQuotaSource.ts`, and two related files — intended
to thread `backend_provider` context to quota sources. The change was fully reverted: `httpQuotaSource.ts:144`
passed an empty `{}` context object, so the new branch was unreachable (dead code regardless of the
parameter signature). All changes were reverted atomically; nothing from this phantom fix is carried into
the current plan.

## Execution order (within the one commit)

1. New shape adapter + declaration reader + probe/auth/argv changes, written test-first where
   red-green applies (h.4).
2. Full sweep: grep `repair[-_]proxy|/registry` over src/ must end at zero; grep `litellm` over src/
   must hit only the edge shape adapter (brand-name budget check, (g)).
3. `npm run build && npm run check` green; touched suites green; attest; commit; standard pipeline
   (`/ship`) to publish.

## Resolved decisions & dissolved calls (owner, 2026-07-18)

**Resolved (owner decision, 2026-07-18):**
1. **(b)** cost blend formula for `cost_per_mtok` from per-token advert prices: **mean of input/output
   $/Mtok** (determinism/simplicity).
2. **(b-degraded)** roster-only fallback provider identity: **alias slash-prefix, else shared `"proxy"`
   bucket** (coarse pool identity, honest at degradation rung, revisitable).

**Dissolved (forced answers, already-decided infrastructure):**
1. **(a-legacy)** legacy `repair_proxy` key handling: **forced loud via dropped-reason** — existing
   `dropped[]` invariant and `auditorSources.ts` pattern enforce it; no owner discretion path.
2. **(e)** bare-endpoint/transport default: **already wired** — `ANTHROPIC_BASE_URL` env var
   (described in section (d)); endpoint is already operator-declared data; no owner call.

## Delta vs the pre-directive draft (for review traceability)

The directive changed: (a) `litellm` block → generic `proxy` block; discovery re-based from
"`/model/info` only, no `/v1/models` fallback" to "`/v1/models` required baseline + `/model/info`
optional enrichment + explicit roster-only degradation" (which added owner call 3); liveness gained
the `/v1/models` any-HTTP fallback for proxies without `/health/liveliness`; all module/symbol/test
names de-branded (`proxy-lane.test.mjs`, `readProxyDeclaration`, `resolveProxyLane`, drop ids); the
LiteLLM `/anthropic` passthrough demoted from a plan decision to docs/examples deployment guidance;
(f) extended with the future-ranking-is-a-consumed-contract clause; and a brand-name budget check
added to (g)/execution. Unchanged: verified ground truth, auth/overlay design, verbatim-alias argv,
atomic-replace touch list skeleton, red-green pins, loop-core classification.
