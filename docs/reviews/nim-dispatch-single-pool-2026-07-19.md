# NIM dispatch via LiteLLM — single-pool correction + capability ranker landed

**Date:** 2026-07-19 · **Lap:** exercise LiteLLM by fully taking advantage of NIM dispatch
**Proxy:** LiteLLM on `127.0.0.1:4000` fronting NVIDIA NIM · **Config:** `~/.audit-code/litellm-config.yaml`

## The correction that reframed the lap

The lap opened by expanding the proxy lane to 9 NIM aliases and calling them "9 pools". **That framing was
wrong, and the error is in the tool, not just the wording.** NVIDIA NIM is ONE account behind ONE shared
rate limit; the aliases are models *within* that budget. Three consequences follow, and all three were
confirmed against source:

1. audit-tools models each alias as an independent quota pool (defect — below).
2. NIM offers **119 models**, not 9 — the hand-written config covered a small hand-picked slice.
3. With a single shared budget there is **no capability/cost tradeoff to make**. Tiering exists to
   allocate scarce *independent* budgets across work of differing value. One budget ⇒ always dispatch
   the best model, at every complexity level.

The configuration now reflects (3): **one NIM pool, best model, all complexity levels.**

## DEFECT — N models on one account are metered as N independent budgets

Verified by source trace, not inference.

- **Pool identity is `(provider, account, model)`** — `apiPool.ts:37-57` → `quotaPoolKey`
  (`providers/identity.ts`), rendering `provider[#account]/model`. `model` is in the key, and that same key
  is the *budget* key.
- **Quota state, rate ceilings, and in-flight caps all key off it** — `apiPool.ts:425,428`;
  `state.ts:576`; `admissionLoop.ts:613,668-669,689`.
- **A 429 cools down only the model that emitted it** — `rollingDispatch.ts:1061,1087` →
  `state.ts:567`. The other siblings on the same credential stay fully admissible.
- **`admissionLoop.ts:227` sets `resourceKey` — the field its own docstring (:51-52) defines as
  "the metered account the lease keys to" — verbatim from the per-model `pool_id`.**

An account-fold mechanism *does* exist and its docstring (`accountId.ts:8-10`) cites this exact NIM
failure. It does not apply here for two independent reasons:

- `accountId.ts:39` hard-gates it to `provider === "openai-compatible"`; proxy-catalog sources are
  `provider: "claude-worker"` (`proxyCatalog.ts:342`), so it returns `null` and both fold sites
  short-circuit (`apiPool.ts:775`, `rollingDispatch.ts:695`).
- Even if the guard passed, `foldAccountCooldown` is contractually scoped to `cooldown_until` /
  `last_429_at` alone (`accountId.ts:55-57`) — never the budget axis.

**Net:** expanding the proxy lane to K models against one account admits ~K× the real ceiling and
learns 429 backoff K-ways independently. **Property to hold:** pools sharing one credential/rate limit
must share one budget, one in-flight cap, and one cooldown. The account segment currently separates
accounts; nothing merges models.

**Mitigated in config, not in code** — `proxy.top_k: 1` yields exactly one pool. The defect is latent
for any `top_k > 1` and for any operator declaring several models on one key.

## Capability ranker — landed through the existing seam, zero code change

The backlog's predicted producer pattern was validated empirically:

- NIM `/v1/models` (119) joined to OpenRouter `/api/v1/models`
  `benchmarks.artificial_analysis.agentic_index` → **21 of 119 covered**, joined by exact `id` else
  `hugging_face_id`. 13 scoring ≥ 8 became the config roster.
- Written into LiteLLM `model_info.capability_rank`, which `proxyCatalog.ts:159` already ingests as
  `advert.declared_rank`; `:564` inverts the sign (`score = -declared_rank`).
- **The documented sign trap is already handled correctly in HEAD** — `capability_rank` LOWER = better,
  `agentic_index` HIGHER = better, and the existing inversion composes right. Confirmed live: the
  populate now selects `glm-5.2` (rank 1), not the alphabetical head.

Nothing is redistributed — the scores land in the operator's own local proxy config, sidestepping the
Artificial Analysis redistribution blocker.

**Ranked NIM roster** (rank ← agentic_index): 1 `glm-5.2` (43.1) · 2 `deepseek-v4-pro` (36.4) ·
3 `minimax-m3` (35.4) · 4 `inkling` (32.3) · 5 `deepseek-v4-flash` (31.1) · 6 `nemotron-3-ultra-550b`
(27.4) · 7 `minimax-m2.7` (25.6) · 8 `step-3.7-flash` (21.5) · 9 `qwen3.5-122b` (20.7) ·
10 `qwen3.5-397b` (19.8) · 11 `gemma-4-31b-it` (14.4) · 12 `gpt-oss-120b` (13.2) ·
13 `nemotron-3-super-120b` (8.7).

Note `qwen3.5-397b` (19.8) ranks *below* `deepseek-v4-flash` (31.1) — parameter count is not capability,
which is precisely why the alphabetical/size-intuition fallbacks were choosing badly.

## Chain validated live

| Step | Result |
|---|---|
| `/health/liveliness` | ✅ |
| `/v1/models` roster discovery | ✅ 13 aliases |
| `/model/info` enrichment incl. `capability_rank` | ✅ ranks 1–13 surface |
| OpenAI-format completion → NIM | ✅ |
| **Anthropic-format `/v1/messages` → NIM** (the path `claude-worker` dispatches through) | ✅ |
| populate reach probe drops unreachable | ✅ `kimi-k2.6` → HTTP 404 |
| declared-reach drop with reason | ✅ `opencode-free` (`OPENCODE_ZEN_API_KEY` unset) |
| audit-tools resolve → ranked single pool | ✅ `claude-worker:nvidia_nim/glm-5.2`, rank 1, agentic |

**Not yet done:** dispatch through the proxy under a real audit wave, and quota behavior at the proxy.
The lane is now correctly configured for it.

## Codex / agy quota — reachable, but NOT through LiteLLM

Asked to front codex + agy quota with LiteLLM too. **That specific shape cannot be built, for two
independent reasons — one architectural, one a standing owner decision.**

1. **CLI agents cannot be fronted by an HTTP proxy.** codex and agy are *kind-2 CLI agentic* workers
   ([`spec/unified-dispatch-worker-model.md`](../../spec/unified-dispatch-worker-model.md)): each is
   itself a harness with its own model provider, own config, own tool loop, spawned as a subprocess and
   never redirected over a wire. LiteLLM multiplexes HTTP model APIs; there is no endpoint to point it
   at. Previously verified, not assumed.
2. **Codex-subscription-off-CLI is ruled OUT on ToS (owner decision, 2026-07-14).** Driving the
   ChatGPT/Codex *subscription* (OAuth in `~/.codex/auth.json`, Responses API wire) from a non-OpenAI
   client violates OpenAI's terms. The owner was offered it explicitly — their account, their risk —
   and chose "don't cross it." **Only the owner can reverse this; it was not revisited here.**

**But the quota is genuinely reachable, and the real gap was elsewhere.** `synthesizePrimarySource`
(`apiPool.ts:485-532`) only synthesizes a codex/agy pool when that provider is the run's PRIMARY. In a
conversation-first run the primary is the host — so codex and agy pools were never built at all, and
that quota sat idle. Nothing to do with proxies.

Fix is pure config: declare them as CLI-agentic sources. `sourceProviderConfig` already maps
`provider: "codex"` / `"agy"` (`apiPool.ts:173,201` — `endpoint` → command, `model` → model), so they
become `DispatchableSource` → `CapacityPool` with no code change. Verified live:

```
RESOLVED: 3
  - codex-cli                        | provider=codex         | kind=agentic
  - agy-cli                          | provider=agy           | kind=agentic
  - claude-worker:nvidia_nim/glm-5.2 | provider=claude-worker | kind=agentic
```

Each keys to a distinct account (`codex-cli`, `agy-cli`, `nvidia_nim`), so the three meter separately —
which is correct: they are three different credentials with three different rate limits. This is also
the ToS-clean path by construction: audit-tools spawns each vendor's own CLI exactly as intended, with
no subscription bridge and no wire redirection.

**Note the metering rule now differs per pool**, per the owner's clarification: NIM is free ⇒ always
take the best model; codex/agy are metered ⇒ cheapest model clearing the capability floor. Both already
fall out of `costFirstCmp` (`admissionLoop.ts:527`) — `costRank ↑ || capabilityRank ↓ || capabilityScore ↑`
— so a free pool's costs tie and capability decides, while a metered pool sorts by price first. No
policy code was needed; the rule is emergent, and now correct because ranks exist.

## Config changes made (machine-level, backed up)

- `~/.audit-code/litellm-config.yaml` → regenerated, capability-ranked. Backup:
  `litellm-config.yaml.bak-preranker`.
- `~/.audit-code/sources-declared.json` → `proxy.top_k` 3 → 1; removed the direct `nvidia-nim`
  single-shot entry (it was a *second* pool on the same NIM account — the same defect, in config form).
  It pinned `z-ai/glm-5.2`, which the ranker independently confirms is the best choice. Added
  `codex-cli` + `agy-cli` CLI-agentic sources. Backup: `sources-declared.json.bak-precli`.

## Code fix — REWORKED after review refusal (round 2, awaiting re-review)

The round-1 attempt was refused; every defect below is now addressed. **What changed in the rework:**

- **Defect 1 (the critical over-merge) — fixed by inverting the rung order.** `resolvePoolAccountKey`
  now checks `backend_provider` FIRST: that field means the endpoint is a TRANSPORT, so the pool-key
  head (already keyed on the real backend) is the account, and the credential rung is used only when
  there is no transport. Two backends behind one proxy no longer merge. Pinned by a test that gives
  both lanes the same endpoint AND `api_key_env` — the exact shape that collapsed them before.
- **Defects 4/5/6 (the cap axis) — resolved by reading the contract instead of guessing.**
  `concurrency_cap` is documented as one backend ENDPOINT's simultaneity limit "enforced per-pool"
  (`capacity.ts:196-204`, `sessionConfig.ts:468-474`). So the per-account count change was reverted
  outright. That removes the max-not-min ceiling, the starvation of low-cap pools, and the divergence
  with `rollingDispatch.ts:1546` in one move — no reconciliation needed, because the contract already
  said which axis it was. **Scope narrowed honestly: this fix covers the BUDGET and COOLDOWN axes
  only.**
- **Defects 2 + 3 (two partitions, and the metering path losing explicit-`id` sources) — fixed
  structurally.** The account key is now resolved ONCE at `CapacityPool` construction (`accountKey`),
  where the source is still in scope, and carried on the wire as
  `DispatchCapacityPoolSummary.account_key` (required). Every consumer READS it; none re-derives. That
  is what makes one partition true rather than asserted — the host admission path never sees a
  `source`, so it could not have derived the credential-keyed account for an id'd source at all.
- **Defect 8 (comment drift)** — the stale `resourceKey` = pool-id claims are corrected.

**Red-green, per site, all seven — and it is now a CHECK, not a claim.**
`node scripts/shared/assert-sites-pinned.mjs scripts/shared/pinned-sites/account-scoped-metering.json`
reverts each site individually, requires each reversion to turn the suite red, and exits non-zero
naming any site whose reversion left it green. Current output: `All 7 site(s) individually pinned.`

Two bugs surfaced while writing that gate, both worth recording because they are the same shape as the
defect it guards. (1) **The gate was written fail-open** — it could not parse vitest's summary (which
goes to stderr) and treated "unparseable" as `failed: 0`, so its first run reported all seven sites
unpinned while measuring nothing. It now throws instead of guessing. (2) It then failed loudly on
`spawnSync npx.cmd EINVAL` — the Windows shim trap — rather than emitting plausible-looking wrong
numbers; routed through `resolveWindowsShimSpawnCommand` per the OS-agnostic rule. A verification tool
that cannot tell you it is broken is worse than no verification tool.

| Reverted site | Result |
|---|---|
| `admissionLoop` resourceKey ← `account_key` | 1 failed |
| `buildSourcePool` accountKey stamp | 3 failed |
| transport guard in `resolvePoolAccountKey` | 1 failed |
| `rollingDispatch` admit resourceKey | 1 failed |
| `apiPool` cooldown fold grouping | 1 failed |
| `rollingDispatch` cooldown fold grouping | 1 failed |
| `capacity` summary `account_key` passthrough | 1 failed |
| *(restored)* | **80 passed** |

The two that were unpinned in round 1 — the rolling-engine admit and the summary passthrough — needed
NEW tests, not just re-running the old ones: the first exercises a different code path from
`admitBatch`, and the second was invisible because the old test hand-built its summaries.

## ⚠ Round-1 record — REVIEW REFUSED (kept for the lessons)

An independent adversarial review **refused sign-off**. The defect being fixed is real; the fix is not
correct. Verdict + full defect list below. **Two claims made in the first draft of this section were
FALSE and are corrected here** — they are kept visible rather than quietly edited out, because the way
they were wrong is the reusable lesson.

**False claim 1 — "each fix reverted independently turns the new test red."** Verified after the
review: reverting `rollingDispatch.ts:1003` to `slot.poolId` leaves all 6 new tests GREEN. Three sites
were red-green validated (`admissionLoop`'s `resourceKey`, the count key, the guard deletion) and the
result was then generalized to "each fix" — covering the `rollingDispatch` site and both fold-site
rewires, which were never individually checked. The single most-emphasized fix in this record ("the
second admission site … fixing only the first would have been the named-instance trap again") is
entirely unpinned. **Generalizing a verified sample to the whole set is how a red-green claim goes
false while every individual check that was actually run passed.**

**False claim 2 — "one account grouping single-sourced across all three axes."** The code uses TWO
partitions: metering calls `accountKeyFromPoolKey` (pool-key head only), while the cooldown fold calls
`resolvePoolAccountKey` (credential first). For a proxy roster these disagree.

### Review defects (independent reviewer, REFUSE)

1. **CRITICAL over-merge — worse than the original bug.** Deleting the
   `provider !== "openai-compatible"` guard lets rung 1 key on the **transport**: `expandSources`
   (`proxyCatalog.ts:340-347`) stamps every proxy lane with the SAME `endpoint` and `api_key_env`,
   differing only by `backend_provider`. So every backend behind one proxy collapses into one cooldown
   account — a free NIM 429 would stall a paid lane fronted by the same proxy. This is exactly what
   `dispatchableSourceId` (`apiPool.ts:38-47`) exists to prevent: *"the transport NEVER enters the
   quota identity."* **The rationale for deleting the guard was inverted** — rung 2 alone already
   handles proxy lanes correctly (`nvidia_nim` vs `anthropic` heads separate the backends while merging
   their models). The guard was not the bug.
2. **Two axes, two partitions** — see false claim 2.
3. **Under-merge: the motivating case is NOT fixed.** An explicitly-`id`'d source (`apiPool.ts:55`)
   produces a pool id with no `/`, so `accountKeyFromPoolKey("nim-nano") === "nim-nano"` and budget +
   cap stay per-model. That is precisely the `nim-nano`/`nim-super`/`nim-kimi`-on-one-key case
   `accountId.ts:13-18` cites as the reason the module exists. The new test *appears* to cover it but
   asserts `resolvePoolAccountKey` in isolation — **a function the metering path never calls.** False
   assurance, not coverage.
4. **`declaredCap` is per-ENDPOINT by documented contract** (`capacity.ts:196-204`,
   `sessionConfig.ts:468-474`), and the new comment at `admissionLoop.ts:616-617` asserts the opposite.
5. **Per-pool cap vs per-account count ⇒ ceiling becomes MAX, not MIN.** With caps 1 and 8 on one
   account, the low-cap pool is permanently `cap_reached` while the account ceiling is 8. The new test
   uses identical caps (2/2/2) and cannot see it.
6. **Engine divergence** — `rollingDispatch.ts:1546` still enforces `concurrencyCap` per-pool while the
   host path now enforces per-account: one field, two meanings. The named-instance trap, again.
7. **Budget is order-dependent** — `admissionLoop.ts:686` passes one pool's `remaining_token_budget`
   against the shared account key, making the effective account budget the MAX across its models.
8. **Comment/doc drift** in loop-core: `apiPool.ts:774-776` describes rung 2 while the code runs rung 1
   first (which is what made defect 1 invisible on read); `reservationLedger.ts:15,74` and
   `rollingDispatch.ts:434,436,443` still state `resourceKey` IS the pool id.

**Clean on:** no import cycle; count seed/increment/check internally coherent; lease reconcile safe;
`accountKeyFromPoolKey` itself correct against `quotaPoolKey`; folding host `active_subagents`
across model tiers is a genuine improvement.

**Sign-off requires:** rung 1 removed or restricted to backend-not-transport endpoints; ONE grouping
function across all three axes; a derivation that survives an explicit `id` on the metering path; a
decision on whether `concurrency_cap` is per-endpoint or per-account applied to BOTH engines with
min-not-max semantics; and red-green coverage at `rollingDispatch.ts:1003` and both fold sites.

### Original (pre-review) description of the change

`accountKeyFromPoolKey` (`scheduler.ts`, inverse of `quotaPoolKey` in `providers/identity.ts`) + `resolvePoolAccountKey`
(`accountId.ts`) single-source ONE account grouping, now used by all three per-account axes:

- **Budget + in-flight cap** — `admissionLoop.ts`: `resourceKey` derives from the account, and the
  in-flight count keys on `resourceKey` rather than `poolId`.
- **The second admission site** — `rollingDispatch.ts`'s in-process engine had its own
  `resourceKey = slot.poolId`. Found by the NIM analysis pass, not by hand; fixing only the first would
  have been the named-instance trap again.
- **429 cooldown** — both fold sites now group on the same key. `deriveLocalAccountId`'s
  `provider === "openai-compatible"` guard is gone: a bare `(endpoint, api_key_env)` pair identifies a
  credential regardless of transport, which is what previously excluded every proxy lane.

Learned output/input ratios stay keyed per-MODEL (`packetCost` is pure; its caller passes `poolId`) —
metering is per-account, learning is per-model, and those are deliberately different axes.

**Red-green validated** — each fix reverted independently turns the new
`tests/shared/account-scoped-metering.test.mjs` red. The headline: with the count-key reverted, three
models on one credential and a cap of 2 admit **9 packets instead of 2**.

⚠ **Loop-core** (`src/shared/quota/`, `src/shared/dispatch/`) — requires independent review +
attestation before landing. Not yet reviewed.
