# Cross-provider quota-signal matrix

> Design rationale for the shipped per-provider `QuotaSource` set — the generalization of the
> Claude `ClaudeOAuthQuotaSource` to the rest of the pool (`src/shared/quota/`). Records why each
> backend's signal was chosen: the endpoint, credential path, and mapping each `QuotaSource`
> implements. Endpoints below are **undocumented/internal** (read from each tool's open source or
> reverse-engineered); defensive-parse + graceful-degrade always.

## Goal + contract

Each backend gets the best achievable `QuotaSource` feeding the shared contract:
`queryCurrentUsage(providerModelKey) → QuotaUsageSnapshot { remaining_pct (0–1 fraction),
reset_at, … }`. Signal preference, always: **proactive endpoint > reactive headers on a
completion > reactive dated-limit error > local consumption estimate**. How that signal governs
dispatch is [`audit/dispatch-admission-control.md`](audit/dispatch-admission-control.md)'s concern
(admission over the shared quota ledger, with the per-pool token-budget substrate folded in), not
this matrix's.

## Summary

| Backend | Best signal | Endpoint / source | Token source | Confidence |
|---|---|---|---|---|
| **Claude** (shipped) | proactive GET | `api.anthropic.com/api/oauth/usage` | `~/.claude/.credentials.json` | HIGH (live-confirmed) |
| **Codex** (ChatGPT OAuth) | **proactive GET** | `chatgpt.com/backend-api/wham/usage` | `~/.codex/auth.json` | HIGH (live-confirmed — 200, shape matches) |
| **OpenCode** | **federates** (no own quota) | per-provider, via its stored tokens | `~/.local/share/opencode/auth.json` | HIGH |
| **Antigravity** (Gemini) | proactive POST (med) / dated-error (high) | `cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels` (or LS over localhost) | `%APPDATA%/Antigravity/User/globalStorage/state.vscdb` | MED proactive / HIGH reactive |
| **Gemini CLI** (OAuth/Code-Assist) | **proactive POST** | `cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota` → `buckets[].{remainingFraction,resetTime}` | `~/.gemini/oauth_creds.json` | HIGH shape — but individual tiers **deprecated on gemini-cli 2026-06-18**; Std/Ent only (see §6) |
| **VS Code Copilot** | **proactive GET** | `api.github.com/copilot_internal/user` | DPAPI SecretStorage (`state.vscdb`) / `gh`/`copilot` CLI | HIGH endpoint / MED token (live-shape PENDING — see §4 note) |
| Gemini raw API | reactive only | 429 `RESOURCE_EXHAUSTED` + `RetryInfo` | API key | HIGH (Google staff: no proactive header) |
| **NVIDIA NIM — hosted** | reactive only | 429 + `Retry-After` on `/v1/chat/completions` (no `X-RateLimit-*`, no credits GET) | `NVIDIA_API_KEY` env (`nvapi-…`) | HIGH (no proactive surface — official API ref documents none) |
| **NVIDIA NIM — self-hosted** | **unbounded-local** | none (local GPU pool; `/v1/metrics` is perf telemetry, not quota) | `NVIDIA_API_KEY` / none | HIGH (vLLM-passthrough metrics carry no quota) |

---

## 0. Claude (shipped) — credential resolution

The reference analog every other provider below is measured against. The signal:
`ClaudeOAuthQuotaSource` probes the undocumented `GET api.anthropic.com/api/oauth/usage`
(OAuth Bearer + `anthropic-beta: oauth-2025-04-20` + first-party-shaped `User-Agent`). Response:
top-level `five_hour` / `seven_day` windows each `{utilization, resets_at}`, plus `limits[]` with
per-scope `{percent, resets_at, scope.model}` — pick the most-constraining (highest utilization)
window → `remaining_pct`.

**Who needs Claude quota, and which credential** — gate on Claude being the active dispatch target;
never probe/touch Claude creds otherwise. Host = Claude Desktop → Desktop's account quota; host = other
IDE dispatching via the Claude CLI provider → the CLI's quota; host = other IDE, no Claude CLI dispatch →
don't touch Claude creds at all. Quota is **account-level**: any valid credential for the same account
returns the same `/usage` numbers regardless of surface.

**No supported decryption-free read of Desktop's own token** (confirmed vs official Claude Code / Agent
SDK docs): no host→subprocess token handoff API is public; `apiKeyHelper` is terminal-CLI-only (not
Desktop/OAuth); Desktop's token lives in the OS-encrypted store (Electron safeStorage / DPAPI) and manual
decryption is unsupported + version-fragile → **forbidden by robustness-in-tooling**. The only blessed
subprocess handoff is `claude setup-token` → long-lived `CLAUDE_CODE_OAUTH_TOKEN` (an OAuth token, works
against `/usage`).

**Resolution order** (auto-discovered, no manual flag; first hit wins):
1. `CLAUDE_CODE_OAUTH_TOKEN` (env or session config) — the supported handoff; works for any host
   including Desktop. One-time `claude setup-token`.
2. `~/.claude/.credentials.json` with **refresh-on-expiry**: when `accessToken` is missing/expired (or
   `/usage` 401s) and a `refreshToken` exists, POST the refresh grant (`console.anthropic.com/v1/oauth/token`,
   grant_type=refresh_token), then **persist the rotated creds atomically under `withFileLock`** —
   double-checked (re-read after acquiring the lock so concurrent probes never double-rotate). This is the
   CLI-dispatch credential. (The defect this fixed: the source only *read* `accessToken` and bailed on
   expiry; the access token lives ~8h, the long-lived `refreshToken` beside it was never used → the source
   went dark ~8h after any CLI login. Refresh logic never existed — a gap, not a regression.)
3. Else degrade to the reactive `HostSessionQuotaSource` (parses "you hit your session limit" from the
   worker channel) — no credential, graceful, no proactive remaining-%.

**Hard-won hazard: refresh tokens rotate.** A refresh grant rotates the refresh token; the old one is
immediately invalidated. (1) Persist the new refresh token or the credential is bricked — during
investigation an un-persisted refresh + a failed retry wrote `undefined` into the creds file (the exact
clobber the file-lock + double-check must prevent). (2) Never refresh+rotate a creds file owned by another
*active* host; Desktop uses its own encrypted store, so refreshing the idle CLI file is safe — the gating
above guarantees we only refresh the file whose surface we're actually dispatching to.

**Constants, not couplings:** OAuth `client_id` (Claude Code's public client) + token endpoint are named
constants with override options (same pattern as `USAGE_ENDPOINT` / beta-header constants); no model
identities hardcoded (`limits[].scope.model` is data-driven).

---

## 1. Codex (OpenAI, ChatGPT-subscription OAuth) — PROACTIVE (HIGH)

Strictly better than the Claude analog: a free standalone GET **and** reactive headers
(the Codex CLI polls the GET on a ~60s timer, independent of completions).

**Probe**
```
GET https://chatgpt.com/backend-api/wham/usage
  Authorization: Bearer <tokens.access_token>     # ~/.codex/auth.json
  ChatGPT-Account-Id: <tokens.account_id>          # ~/.codex/auth.json
  User-Agent: codex_cli_rs/<ver> (or codex-cli)
  originator: codex_cli_rs
```
**Response** (`RateLimitStatusPayload`): `{ plan_type, rate_limit: { allowed, limit_reached,
primary_window (5h), secondary_window (weekly) }, credits, additional_rate_limits[] }`.
Each window (`RateLimitWindowSnapshot`): `{ used_percent (0–100), limit_window_seconds,
reset_after_seconds, reset_at (unix sec) }`. (Codex-API-key auth instead → `{base}/api/codex/usage`.)

**✓ LIVE-CONFIRMED** (`CodexQuotaSource` production path + raw probe): real 200,
top-level keys `[user_id, account_id, email, plan_type, rate_limit, code_review_rate_limit,
additional_rate_limits, credits, spend_control, rate_limit_reached_type, promo, referral_beacon,
rate_limit_reset_credits]`; `rate_limit.{primary,secondary}_window` carried `used_percent / reset_at /
reset_after_seconds / limit_window_seconds` exactly as parsed; most-constraining-window pick worked
(`secondary used_percent:100` → `remaining_pct:0`, `reset_at` Jun 19). The mapping is validated against reality.

**Local tier (no call):** `~/.codex/auth.json tokens.id_token` (JWT) → claim
`https://api.openai.com/auth.chatgpt_plan_type` (= "plus") + `chatgpt_account_id`,
`chatgpt_subscription_active_until`. (Caveat: `active_until` can be past a stored token's date —
confirm wham/usage still authorizes when running it live.)

**Mapping:** per window `remaining_pct = 1 − used_percent/100`, `reset_at = window.reset_at`
(or `now + reset_after_seconds`). Emit two snapshots (5h + weekly), keyed by
`limit_window_seconds` (18000 vs 604800). `credits.unlimited/has_credits` flags whether %-limits apply.

**Refresh** (on 401) — *ecosystem/protocol background, informational only — NOT implemented in
`CodexQuotaSource` (`fetchSnapshot` returns `null` on failure; no refresh logic)*: `POST
https://auth.openai.com/oauth/token`, `grant_type=refresh_token`, `client_id=app_EMoamEEZ73f0CkXaXp7hrann`.

**Degrade:** proactive GET → reactive `x-codex-*` headers on `/responses` completions
(`x-codex-primary-used-percent`, `-primary-reset-at`, `-primary-window-minutes`, + secondary)
→ 429 body `error.type=="usage_limit_reached"` + `error.resets_at` → local
`~/.codex/sessions/**/rollout-*.jsonl` `token_count` events (stale, no network).

**Citations:** `openai/codex` `codex-rs/backend-client/src/client/rate_limit_resets.rs:27-57`
(+ `rate_limit_resets_tests.rs:17-20` URL-pin), `.../client.rs:240-251,284-306`,
`model-provider/src/bearer_auth_provider.rs:32-42`, OpenAPI models
`codex-backend-openapi-models/src/models/rate_limit_*`, reactive `codex-api/src/rate_limits.rs:57-86`,
`api_bridge.rs:81-99`, `protocol/src/error.rs:458-583`; issues #10869 (60s poll), #18822;
third-party `wakamex/codex-cli-usage`, `steipete/CodexBar`, `7shi/codex-oauth` (refresh flow).

---

## 2. OpenCode — FEDERATES (no own quota; HIGH)

OpenCode is a thin multi-provider router. Its credential store holds zero usage/quota
state; all rate-limit handling is **reactive** (parses each underlying provider's 429
`retry-after`/body in `session/retry.ts`). Its only proactive quota is its OWN hosted
"Go/Zen" product — irrelevant to BYOK. "Usage" in `acp/usage.ts` is per-session
token/context display, not account quota.

**So: map `opencode-provider → the underlying QuotaSource`, sourcing the token from
OpenCode's own store** `~/.local/share/opencode/auth.json` (+ the `account.json` `active`
map picks which credential per provider is live):

| OpenCode provider | Stored cred | → Underlying QuotaSource |
|---|---|---|
| `anthropic` | `oauth` (`sk-ant-oat01-…`) | **Reuse Claude** `api/oauth/usage` (Bearer + `anthropic-beta: oauth-2025-04-20` + **`User-Agent: claude-code/<ver>`** — the UA matters; without it you land in an aggressive 429 bucket). Refresh: `console.anthropic.com/v1/oauth/token`, client_id `9d1c250a-e61b-44d9-88ed-5944d1962f5e`. |
| `openai` | `oauth` + `accountId` | **Reuse Codex** `wham/usage` (identical ChatGPT OAuth app). |
| `github-copilot` | `oauth` (`gho_…`) | **Reuse Copilot** `copilot_internal/user` with the `gho_` token. |
| `google` | `api` key (`AIza…`) | No proactive endpoint — reactive 429 / `RetryInfo` only. |

**Degrade:** resolve active provider+model → dispatch to its underlying QuotaSource
(refresh token first if `expires < now`) → if none proactive, mirror OpenCode's reactive
parse (`retry-after`/429) → if `api`-type cred, reactive-only.

**ToS flag:** Anthropic discourages 3rd-party Pro/Max use; keep the probe byte-identical to
Claude Code's (UA + beta header) to stay on the generous bucket and avoid self-DoS 429s.

**Citations:** `sst/opencode` `packages/opencode/src/auth/index.ts` (cred schema),
`session/retry.ts:35-66,122-151` (reactive only), `acp/usage.ts` (context display),
`plugin/openai/codex.ts:124-138` (ChatGPT OAuth app), `plugin/github-copilot/copilot.ts`
(gho token exchange), `web/.../providers.mdx:296-322` (Claude Pro/Max login + ToS caveat).

---

## 3. Antigravity (Google, Gemini) — proactive POST (MED) / dated-error (HIGH)

Antigravity is a VS Code/Electron fork; Gemini-backed. **Token lives in
`%APPDATA%/Antigravity/User/globalStorage/state.vscdb`** (SQLite `ItemTable`):
`antigravityAuthStatus` (`{name, apiKey: ya29.…, email, userStatusProtoBinaryBase64}`) +
`antigravityUnifiedStateSync.oauthToken` (base64 OAuth proto). NOT in leveldb/cookies.
Refresh at `oauth2.googleapis.com/token`.

**Proactive (MED — single primary source + shape corroboration):**
```
POST https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels
  Authorization: Bearer <access>;  User-Agent: antigravity;  body {"project":"<id>"}
→ models[].quotaInfo.{ remainingFraction (0–1), resetTime (ISO) }, userTier.name
```
gemini-cli's analog (HIGH-verified in `google-gemini/gemini-cli`
`packages/core/src/code_assist/{types.ts,server.ts}`) is `v1internal:retrieveUserQuota`
→ `buckets[].{ remainingAmount, remainingFraction, resetTime, tokenType, modelId }`. Both
share the `remainingFraction`+`resetTime` shape (convergence raises confidence).

**LOWER-RISK alternative:** read the local **Antigravity Language Server over localhost**
(what in-IDE monitors `tuckiestudio/antigravity-usage-monitor`, `llegomark/ag-telemetry` do —
no external calls, same `remainingFraction`/`resetTime`). Preferred over replaying the
internal cloud endpoint with a scraped token (Google prohibits reverse-proxy use — ToS).

**Reactive dated-error (HIGH, 2 verbatim sources):** 429 `RESOURCE_EXHAUSTED` + UI string
*"Your quota will reset after `<Hh Mm Ss>`. Your plan's baseline quota will refresh on
`<M/D/YYYY, h:mm:ss AM/PM>`"* — sentence 2 = sprint (~5h relative), sentence 3 = weekly absolute.

**Raw Gemini API:** Google staff confirm **no proactive remaining endpoint / no `X-RateLimit-*`
header**; reactive only (429 + `RetryInfo.retryDelay` + `QuotaFailure.quotaId` → classify
`PerDay`/`PerMinute`). True proactive needs Cloud Monitoring + a GCP project (n/a for AI-Studio keys).

**Local fallback:** `userStatusProtoBinaryBase64` → tier (`g1-pro-tier` "Google AI Pro") + caps,
but **no live remaining cached locally** (`modelCredits` is static sentinel config). Tier/caps only.

**Mapping:** `remaining_pct = min(quotaInfo.remainingFraction)`, `reset_at = min(resetTime)`;
on 429 → `remaining_pct=0`, `reset_at = now + sprint`, plus weekly absolute. The in-app
Settings→Models bar is a documented-unreliable oracle (shows 100% while limited) — don't trust it.

**Citations:** `state.vscdb` token (firsthand); `taoalpha` gist + DeepWiki `lbjlaq/Antigravity-Manager`
(fetchAvailableModels); `google-gemini/gemini-cli` `code_assist/types.ts,server.ts` (retrieveUserQuota);
discuss.ai.google.dev/t/40576 (no proactive header), /t/134004 (dated error), /t/125971 (bar unreliable);
`ink1ing/anti-api` (ToS prohibition).

**Antigravity CLI is the unified migration target + community has already solved its quota.**
Google is folding gemini-cli's individual tiers AND the IDE consumers into **Antigravity CLI** (`agy`,
`google-antigravity/antigravity-cli`). Antigravity uses the SAME dual-limit shape as
Codex/Claude (5h rolling + weekly hard-cap, per-model). Multiple community tools already poll its quota
proactively — **`skainguyen1412/antigravity-usage`** (its README states a "Dual-Fetch": local Antigravity
**Language Server** first, then the Google **Cloud Code API** fallback — i.e. exactly the two routes above),
**`fuelcheck`** ("Gemini 3.1 Pro: 62% remaining (resets in 3h 14m)"), **Antigravity Cockpit**, and
**`steipete/CodexBar` #1178**. So the future-proof Gemini-family `QuotaSource` is **Antigravity (CLI)**, not
gemini-cli — reuse the §3 local-LS/cloudcode-pa recipe. `agy` is a same-mechanism alias, not a new source:
it is aliased into the existing `AntigravityQuotaSource` (`ANTIGRAVITY_PROVIDER_NAMES =
new Set(["antigravity","agy"])` in `src/shared/quota/antigravityQuotaSource.ts`), which reads only
`state.vscdb` / `ANTIGRAVITY_ACCESS_TOKEN` — the IDE credential path. The earlier build caveat (the CLI's
token store likely differs from the IDE's `state.vscdb`) was **bypassed by aliasing, not addressed**: it
remains UNVERIFIED whether the `agy` CLI genuinely shares the IDE's credential store. If it does not, agy
quota reads silently return `null` (degrade) — a live-verify watch (see `docs/backlog.md`).

---

## 4. VS Code — GitHub Copilot — PROACTIVE (HIGH endpoint / MED token)

"VS Code" as a backend = GitHub Copilot (where the quota lives). The `vscode.lm` API
exposes no quota read (reactive only).

**Probe**
```
GET https://api.github.com/copilot_internal/user
  Authorization: Bearer <gho_… GitHub OAuth token>
  Editor-Version: vscode/1.x;  Editor-Plugin-Version: copilot-chat/x;  User-Agent: GithubCopilot/x
```
**Response:** `quota_snapshots.{ chat, completions, premium_interactions }` each
`{ entitlement, remaining, percent_remaining (0–100), unlimited, quota_id }` + top-level
`quota_reset_date`. The raw `gho_` is accepted directly (no exchange needed for the read).

**Mapping** (use `premium_interactions`, or `chat` for free tiers):
`remaining_pct = unlimited ? 1 : percent_remaining/100`; `reset_at = Date.parse(quota_reset_date)`.

**Token source (Windows = the hard part):** VS Code stores the GitHub token in **SecretStorage
= DPAPI/`safeStorage`-encrypted inside `state.vscdb`** — not plaintext-extractable. Fallbacks:
the **Copilot CLI** `~/.copilot/config.json` (plaintext `gho_/ghu_` when keychain unavailable;
`COPILOT_HOME` override) or **`gh` CLI** hosts file. The gh config dir is **OS-specific**:
`%AppData%\GitHub CLI` on Windows, `~/.config/gh` on macOS/Linux, `$GH_CONFIG_DIR` override — the code
resolves this via `resolveGhHostsPath` (not a hardcoded `~/.config/gh`, which was an OS-portability bug).

**Live-confirm — PENDING where no file-reachable token exists.** When there is no Copilot CLI
(`~/.copilot` absent) and `gh` stores its token in the **OS keyring** (`hosts.yml` has none) with a token
lacking `copilot` scope (`gist, read:org, repo, workflow`), `CopilotQuotaSource` correctly
degrades to null (degrade path ✓). The response-shape mapping stays fixture-tested only — re-confirm where a
Copilot token is file-reachable: `GH_COPILOT_TOKEN`/`GH_TOKEN` env, the Copilot CLI config, or `gh` with
file/insecure storage. (The keyring itself is out of scope for a read-only probe.)

**Degrade:** `copilot_internal/user` → reuse the token-exchange envelope
`GET copilot_internal/v2/token` → `limited_user_quotas.chat` + `chat_enabled` (coarse, free-tier)
→ documented `GET /users/{me}/settings/billing/premium_request/usage` (consumption; **fails for
enterprise-managed seats**; needs Plan-read OAuth) → reactive 429 at call time → local
consumption estimate vs plan cap (Pro 300/mo, Pro+ 1500/mo; reset 1st of month UTC).

**Citations:** `imspsycho/copilot-api` `get-copilot-usage.ts` (endpoint + `QuotaDetail` fields),
`fgonzalezurriola/opencode-copilot-usage` `src/index.ts` (endpoint + parses `premium_interactions`),
DeepWiki `microsoft/vscode-copilot-chat` 2.3 (token-exchange `limited_user_quotas`, SecretStorage),
GitHub Docs billing/usage + copilot-cli config-dir; community #178117 (stability caveat).

---

## Security / ToS notes

- **Antigravity token (action):** the Antigravity research subagent decoded an OAuth token
  fragment from `antigravityUnifiedStateSync.oauthToken` into its transcript (self-reported).
  **Rotate by signing out/in to Antigravity.**
- **Read-only token use only** — Bearer to the provider's own host, never log/transmit/persist.
  All probes are GET/read; never refresh-and-rewrite a 3rd-party cred store from a quota probe
  (would risk breaking the host CLI's auth chain) — degrade instead, like `ClaudeOAuthQuotaSource`.
- **ToS:** Antigravity (Google) and Anthropic-via-OpenCode Pro/Max are 3rd-party-use-discouraged.
  Prefer the local-language-server route for Antigravity; mimic the first-party UA for Anthropic.
- **OS portability:** all token paths above are Windows-observed; macOS/Linux differ (keychains,
  XDG dirs) — discover, don't assume.

## Implementation notes (audit-tools)

- Each becomes a `QuotaSource` (one file per provider, like `claudeOAuthQuotaSource.ts`),
  registered via `buildQuotaSource({ additionalSources })` or as a provider-gated default.
  Reuse the **hermeticity guard** (skip the default network fetch under a test runner / kill-switch;
  honor an injected `fetchImpl`) and the **no-refresh-in-source / degrade-to-null** discipline.
- OpenCode is NOT a separate source — it's a **token broker**: resolve active provider from its
  `auth.json` + `account.json`, then delegate to the matching underlying source.
- Map `providerModelKey` provider segment → source: `codex`→wham/usage, `claude-code`/`claude`→
  oauth/usage (done), `opencode`→federate, `antigravity`→cloudcode-pa/local-LS, `vscode`/`copilot`→
  copilot_internal/user.
- The binding constraint stays **quota+rate, not max-parallel-N**; per-window snapshots (5h/weekly)
  + per-model where exposed enable utilization-driven spill + strength/cost routing across pools.

---

## 5. NVIDIA NIM (NVIDIA Inference Microservices)

OpenAI-compatible across both modes (drop-in `base_url` + Bearer key), so it slots into the
pool model exactly like the matrix's other OpenAI-compatible providers. **No proactive quota
surface exists in either mode** — verdict below is verified against NVIDIA's own docs, not memory.

### 5a. Hosted (build.nvidia.com / API catalog) — REACTIVE ONLY (HIGH)

The hosted catalog at `integrate.api.nvidia.com` is a free-credit trial tier. Auth is a static
API key, NOT OAuth — there is no rotating credential and no per-account usage endpoint.

- **Signal tier:** reactive 429 + `Retry-After` only. **No proactive credits/usage GET; no
  `X-RateLimit-*` / `RateLimit-Remaining` response headers** documented on `/v1/chat/completions`.
  Credit balance is **dashboard-UI-only** (profile → "Request More"); not queryable via API.
- **Probe (there is none proactive).** Reactive recipe:
  ```
  POST https://integrate.api.nvidia.com/v1/chat/completions
    Authorization: Bearer <NVIDIA_API_KEY>     # nvapi-… , static key
  → 200 normal | 429 Too Many Requests + (honor) Retry-After: <seconds>
  ```
- **Token source:** `NVIDIA_API_KEY` env var (`nvapi-…`). No first-party on-disk store — the key
  is user-provided env/config; OpenAI-compatible hosts (OpenCode et al.) keep it as a generic
  `{ type: "api", key: "nvapi-…" }` cred. (NOTE: a static key is fundamentally weaker signal
  than the Claude/Codex OAuth analogs — there is nothing to GET.)
- **Documented limits (tier, not queryable):** free tier ~**40 RPM** baseline (raisable to ~200
  RPM by dashboard request); credits = 1,000 on signup (→ up to 5,000 on request). Browser use
  on build.nvidia.com does not consume credits; remote API calls do. Limits are RPM-based; no
  documented TPM ceiling. **NVIDIA staff note increases are not always granted on request** —
  client-side backoff is the expected mitigation.
- **Mapping:** no live `remaining_pct` obtainable. On 429 → `remaining_pct = 0`,
  `reset_at = now + Retry-After` (if present, else short backoff). `requests_remaining` /
  `tokens_remaining` = null (never exposed). Optionally learn the 40/200 RPM ceiling into the
  existing learned-limits subsystem and estimate a sliding-window `remaining_pct` locally.
- **Degrade chain:** (no proactive GET exists) → reactive 429 + `Retry-After` at call time →
  local RPM sliding-window estimate vs learned 40/200 cap → null.
- **Citations:** NVIDIA NIM LLM API reference (endpoints `/v1/chat/completions`, `/v1/completions`,
  `/v1/responses`, `/v1/models`, `/v1/health/{live,ready}`, `/v1/metadata`, `/v1/license`,
  `/v1/metrics`; **zero mention of rate-limit headers, 429, quotas, or credits**)
  `docs.nvidia.com/nim/large-language-models/latest/reference/api-reference.html`; base URL +
  `NVIDIA_API_KEY` + `nvapi-` + OpenAI-compat: `decodethefuture.org/en/nvidia-nim-api-explained`,
  OpenCode generic-OpenAI-compat gist (`gist.github.com/syntaxhacker/bd3014c383bf7247bb982acb91d732d2`);
  40→200 RPM + 1,000-credit trial + UI-only balance: NVIDIA Developer Forums
  (`/t/api-credits-for-build-nvidia-com/306633`, the many "40→200 RPM" rate-limit-increase threads,
  `/t/what-is-a-credit/305579`). **Could NOT verify:** any private/internal credits-balance API
  (none found in docs or forums — treat as nonexistent for our purposes).

### 5b. Self-hosted NIM container — UNBOUNDED-LOCAL (HIGH)

A NIM container on local/on-prem GPU (`http://localhost:8000/v1`, OpenAI-compatible) has **no
account-quota concept**. Like the matrix's stance on local LLMs, treat it as effectively
unbounded — the real ceiling is GPU throughput/VRAM, modeled as a local dispatch pool with no
proactive quota source.

- **Signal tier:** unbounded-local. No quota endpoint; no rate-limit headers. `/v1/metrics` is
  Prometheus **performance** telemetry, NOT quota.
- **`/v1/metrics` (what's actually there):** NIM passes through the inference backend's native
  vLLM metrics unmodified — `vllm:num_requests_running`, `vllm:num_requests_waiting`,
  `vllm:kv_cache_usage_perc` (1.0 = 100% KV cache), `vllm:prompt_tokens`,
  `vllm:generation_tokens`, latency/throughput histograms. **None is an account RPM/TPM/credits
  metric.** `curl -s http://localhost:8000/v1/metrics`.
- **Capacity limits are physical, not quota:** `NIM_MAX_MODEL_LEN` / `--max-model-len`, KV-cache
  VRAM (OOM if exceeded), in-flight concurrency bounded by KV cache. These are saturation signals,
  not entitlement — fits the "no proactive quota, local pool" model.
- **Token source:** `NVIDIA_API_KEY` if the container is started with auth, else none. Base URL
  is operator-configured (`localhost:8000` default).
- **Mapping:** `remaining_pct` ≈ 1 (unbounded). If a backpressure signal is ever wanted, derive a
  *soft* pressure proxy from `kv_cache_usage_perc` / `num_requests_waiting` scraped off
  `/v1/metrics` — but that is concurrency backpressure, not a quota snapshot; keep it out of the
  `remaining_pct` quota contract unless deliberately repurposed.
- **Degrade chain:** unbounded-local (return null / treat as a fixed-concurrency pool) → optional
  `/v1/metrics` KV-pressure proxy if backpressure routing is later desired.
- **Citations:** NIM logging & observability (`/v1/metrics` = unmodified vLLM passthrough)
  `docs.nvidia.com/nim/large-language-models/latest/reference/logging-and-observability.html`;
  vLLM metric names `docs.vllm.ai/en/stable/usage/metrics/`; advanced config / `NIM_MAX_MODEL_LEN`
  + KV-cache VRAM `docs.nvidia.com/nim/large-language-models/latest/reference/advanced-configuration.html`.

### 5c. Pool fit + BUILD recommendation

- **Pool fit:** provider name `nvidia-nim` (or split `nvidia-nim` / `nvidia-nim-local`), opaque
  model id (catalog id string, e.g. a Nemotron/Llama id — never hardcode a model table, per the
  agnostic invariant), `base_url` config (`integrate.api.nvidia.com/v1` hosted | `localhost:8000/v1`
  self-hosted), Bearer `NVIDIA_API_KEY` auth. Both are generic OpenAI-compatible pools — the
  dispatcher needs no NIM-specific logic.
- **Is a proactive `QuotaSource` warranted? NO.** Unlike Claude/Codex/Copilot (which have real
  proactive GETs), NIM exposes **no proactive credits/usage/limits endpoint in either mode** —
  confirmed absent in the official API reference. So:
  - **Hosted:** do NOT build a proactive `BaseHttpQuotaSource` subclass — there is nothing to GET.
    Handle as **reactive-429 + `Retry-After`** at dispatch, and (optionally) feed the documented
    40/200 RPM ceiling into the existing **learned-limits / sliding-window** subsystem for a local
    `remaining_pct` estimate. This is the matrix's "reactive dated-limit / local estimate" rung,
    not a new proactive source.
  - **Self-hosted:** register as an **unbounded local pool** (no `QuotaSource`), exactly like other
    local LLMs. Optional later: a `/v1/metrics` KV-pressure backpressure proxy — explicitly NOT a
    quota source.
- **ToS / caveats:** hosted catalog is a **free trial** (credits + business-email AI-Enterprise
  unlock); not a production SLA tier — design for hard 429s. Static `nvapi-` key = treat as a
  secret (env/config only; never log). **Flagged unverified:** no programmatic credit-balance API
  was found in any NVIDIA doc or forum thread — asserting its nonexistence is a *negative* finding
  from absence-in-docs, not a positive confirmation from NVIDIA that one will never exist.
- **Community cross-check ("did anyone else solve it?"): NO.** The negative finding is
  corroborated by users actively asking for it and getting no answer: forum *"Cannot find the
  amount of credits left on NIM API"* (t/337051) and *"Usage tracking in nvidia nim api"* (t/367730 —
  *"no way to monitor total token consumption, per-model usage, or usage over time"*). The
  **NGC** Python SDK only exposes **storage** quota (per-ACE), not inference/credits. No third-party
  tool polls a proactive NIM usage endpoint (GitHub "NIM monitor" hits are all GPU/Prometheus infra
  exporters). LiteLLM **does** confirm NIM returns a `Retry-After` on its upstream 429 (issue #21553)
  — so the reactive rung is real; the proactive rung genuinely does not exist.

---

## 6. Gemini CLI (Google, `google-gemini/gemini-cli`) — proactive POST (HIGH shape) — individual tiers DEPRECATED 2026-06-18

Same `cloudcode-pa` family as §3 Antigravity, but a CLEANER signal: gemini-cli's OAuth/Code-Assist
tier calls a purpose-built quota RPC (vs Antigravity's model-list scrape), and its token is a plain
JSON file (vs Antigravity's SQLite) — OS-portability is just `os.homedir()`.

**Routing (`core/contentGenerator.ts`):** only `oauth-personal` (LOGIN_WITH_GOOGLE) + compute-ADC
route through `CodeAssistServer` → cloudcode-pa (HAS quota). `gemini-api-key` / `vertex-ai`
construct a plain `GoogleGenAI` → raw API, NO quota endpoint (reactive-only = the Gemini-raw-API row).

**Token source (OS-agnostic):** `${GEMINI_CLI_HOME || os.homedir()}/.gemini/oauth_creds.json` →
`{ access_token, refresh_token, id_token, expiry_date }`. Encrypted-storage variant (FORCE_ENCRYPTED_FILE
flag) → unreadable → degrade. Secondary path: `$GOOGLE_APPLICATION_CREDENTIALS`.

**Probe (proactive — shape source-verified, NOT live-probed here):**
```
POST https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota
  Authorization: Bearer <access_token>;  body {"project":"<id>"}   # or {} if unknown
→ RetrieveUserQuotaResponse { buckets[]: { remainingAmount?, remainingFraction? (0–1),
    resetTime? (ISO), tokenType?, modelId? } }
```
**Mapping:** `remaining_pct = min remainingFraction across buckets` (least-remaining binds);
`reset_at` = that bucket's `resetTime`; `requests_remaining` = parse(`remainingAmount`). Free cap
documented 60 rpm + 1,000 model-req/day. Refresh (host-owned, on 401): `oauth2.googleapis.com/token`.

**Community-confirmed:** `/usage` IS backed by `retrieveUserQuota` (gemini-cli issue
#27363). **Important parse caveat from that bug:** when a bucket is at 100% the API **OMITS
`remainingAmount`** and returns `remainingFraction: 1` alone — gemini-cli's own parser gates on
`bucket.remainingAmount` truthy and so breaks at full quota. Our mapping keys on `remainingFraction`
(treat `remainingAmount` as optional/absent-at-100%), so it sidesteps that bug by construction.

**Degrade:** retrieveUserQuota → `loadCodeAssist` tier+cap only (no live remaining) → 429
`RESOURCE_EXHAUSTED` + `RetryInfo.retryDelay`. API-key/Vertex tiers: reactive from the start.

**⛔ DEPRECATION (verified against Google's primary source):** *"Starting June 18, 2026,
Gemini Code Assist IDE extensions will stop serving requests for the Gemini Code Assist for
individuals, Google AI Pro, and Google AI Ultra tiers."* — both IDE extensions AND the Gemini CLI are
affected; Standard/Enterprise subscriptions are unaffected; consumers are migrated to the **Antigravity
family** (already covered by §3).

**BUILD RECOMMENDATION: do NOT build a dedicated `GeminiCliQuotaSource` now.** The high-value
free/Pro/Ultra signal disappears 2026-06-18, and the surviving Standard/Enterprise case is the SAME
cloudcode-pa family the §3 Antigravity source already covers — Google explicitly steers consumers there.
If a Std/Ent gemini-cli pool ever becomes a real dispatch target, build it then as a thin
`BaseHttpQuotaSource` sibling (`fetchGeminiCliUsage` + `mapGeminiCliUsage`, provider gate
`{"gemini","gemini-cli"}`, the creds path above) — cleaner than the Antigravity source, but redundant
today. The OpenCode broker's `google` row stays reactive unless an OAuth (not API-key) cred is present.

**Citations:** `google-gemini/gemini-cli` `packages/core/src/code_assist/{types.ts,server.ts,codeAssist.ts,oauth2.ts}`
(`retrieveUserQuota`, `RetrieveUserQuotaResponse/BucketInfo`, `CODE_ASSIST_ENDPOINT`, OAuth client id),
`config/storage.ts` + `utils/paths.ts` (`~/.gemini/oauth_creds.json`, `GEMINI_CLI_HOME`),
`core/contentGenerator.ts` (auth-mode routing); deprecation **verified** at
`developers.google.com/gemini-code-assist/docs/deprecations/code-assist-individuals`; API-key
reactive-only `ai.google.dev/gemini-api/docs/rate-limits`; shape corroboration `steipete/CodexBar`
`docs/gemini.md`. **Could NOT live-probe** the real `retrieveUserQuota` 200 here — mark fixture/source-
shape only (several issues report `cloudcode-pa` 403/SERVICE_DISABLED for project-ineligible accounts → degrade cleanly).
