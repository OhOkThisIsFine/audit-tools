# LiteLLM proxy — live validation of the brand-neutral proxy contract (2026-07-18)

Closes the gap named in HANDOFF ▶ IMMEDIATE NEXT Track 1: the v0.33.7 proxy-transport swap
(`44417033`) had **never been exercised against a live proxy**. It now has been.

Companion to the design record [`litellm-swap-plan-2026-07-18.md`](litellm-swap-plan-2026-07-18.md).

## What was stood up

A LiteLLM 1.91.1 proxy on `127.0.0.1:4000` fronting NVIDIA NIM
(`https://integrate.api.nvidia.com/v1`, 119 models advertised), exposing 9 aliases chosen to span
capability tiers so roster discovery, `top_k` truncation, and the Track-3 tier fallback all have
real input. Config: `~/.audit-code/litellm-config.yaml` (no secrets in the file — keys are
`os.environ/…` references).

The machine declaration `~/.audit-code/sources-declared.json` was migrated off the retired
`repair_proxy` key onto the generic `proxy` block. Prior file backed up alongside it.

## Deliverable-by-deliverable result

| # | Deliverable | Result |
|---|---|---|
| a | `/v1/models` roster discovery + Gate-0 merge | **PASS** — 9 aliases discovered; `top_k: 3` truncated to 3; lane folded into `resolveAmbientSources().sources` beside the declared NIM source |
| b | `/model/info` enrichment (costs, context caps), graceful degrade when absent | **PASS (degrade path exercised)** — endpoint served 9 entries but with `max_input_tokens: null` and zero costs, so the roster-only degradation ran for real, not just in theory |
| c | Liveness `/health/liveliness` (fallback `/v1/models`) | **PASS** — `"I'm alive!"`; escalating-budget probe resolved on the first 1s budget |
| d | Auth: master-key threading + loud drop on unset `api_key_env` | **PASS after a fix** — see *Defect found* below |
| e | Workers receive `--model <alias>` verbatim; dispatch honors order | **PASS** — `proxyCatalog.ts:389` routes on the proxy alias, not the backend namespace; expanded ids are `claude-worker:nvidia_nim/<alias>` |

Per-model liveness probing behaved correctly: `deepseek-v4-pro` and `kimi-k2.6` were dropped as
`HTTP 404`, which is **genuine upstream** — NIM returns `"Not found for account"` for models this
key is not entitled to. The probe's asymmetry is right: fail-**closed** on 404/model-not-found,
fail-**open** on 401/429/5xx/timeout.

## Defect found and fixed — the proxy lane never reach-verified its own key

**Symptom.** With `proxy.api_key_env` declared but the env var unset, the lane was dropped with
`"proxy is reachable but the populate cache is absent/invalid — run the populate…"`. That sends the
operator to re-run a populate they already ran; the actual cause is an unset variable.

**Mechanism.** A proxy's health endpoint is unauthenticated (LiteLLM's `/health/liveliness` is), so
the liveness probe passes with no key. Populate then fails on auth (`GET /v1/models → HTTP 500`) and
leaves no cache. `resolveProxyLane` sees `readProxyCatalog() === null` and reports the *cache-absent*
branch — the auth reason existed upstream but was discarded before reaching `dropped[]`.

**Why it is a real gap, not a wording nit.** Every *declared source* with an `api_key_env` is
reach-verified (`verifySourceReach`, the `claude-worker` branch). The proxy **lane** accepted the same
field and never checked it — a declared-reach rule with a hole in exactly the shape an operator would
hit first. Consistent with *enforce in tooling, never host discretion*
([[enforce-robustness-in-tooling-not-host-discretion]]): the fix is a mechanical check, not a better
error string.

**Fix.** `resolveProxyLane` now reach-verifies `declaration.api_key_env` **before** the liveness
probe, mirroring `verifySourceReach` and naming the variable. Verified live: the drop reason is now
`env var "LITELLM_MASTER_KEY" is unset or empty in this process.`

**Test.** `tests/shared/proxy-lane.test.mjs` — two cases (unset ⇒ drop naming the var and *not*
mentioning "populate"; set ⇒ lane expands). Red-green validated: with the fix reverted exactly the
unset case fails; restored, 29/29 pass.

## Reproducing

```bash
PYTHONIOENCODING=utf-8 PYTHONUTF8=1 \
  litellm --config ~/.audit-code/litellm-config.yaml --port 4000
```

`PYTHONIOENCODING=utf-8` is load-bearing on Windows — litellm's startup banner is non-cp1252 and
the process dies in `show_banner()` without it. Logged under backlog *Durable traps*.

## What this run did NOT cover

- **Dispatch through the proxy under load** — packets were validated to the completion boundary
  (a real `/v1/chat/completions` round-trip returned content), but no full audit wave ran against it.
  That is the re-dogfood step, which this validation unblocks.
- **Quota/rate-limit behavior** at the proxy — needs a metered run large enough to hit a wall.
- **`/model/info` with real prices** — NIM advertises zero cost through LiteLLM, so cost-rank
  enrichment parsing is exercised structurally but not with meaningful values.
