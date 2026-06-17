# Cross-provider quota-signal matrix (research deliverable)

> Research, 2026-06-16. The per-provider `QuotaSource` matrix the backlog calls for
> (*Cross-IDE/provider quota detection*). Feeds the audit-tools cross-provider quota
> build — the generalization of the shipped Claude `ClaudeOAuthQuotaSource` to the
> rest of the pool. Endpoints below are **undocumented/internal** (read from each
> tool's open source or reverse-engineered); defensive-parse + graceful-degrade always.

## Goal + contract

Each backend gets the best achievable `QuotaSource` feeding the shared contract:
`queryCurrentUsage(providerModelKey) → QuotaUsageSnapshot { remaining_pct (0–1 fraction),
reset_at, … }`. Signal preference, always: **proactive endpoint > reactive headers on a
completion > reactive dated-limit error > local consumption estimate**. The scheduler
already consumes `remaining_pct` (thresholds 0.1/0.3) to throttle/cool-down before a 429.

## Summary

| Backend | Best signal | Endpoint / source | Token source | Confidence |
|---|---|---|---|---|
| **Claude** (shipped) | proactive GET | `api.anthropic.com/api/oauth/usage` | `~/.claude/.credentials.json` | HIGH (live-confirmed) |
| **Codex** (ChatGPT OAuth) | **proactive GET** | `chatgpt.com/backend-api/wham/usage` | `~/.codex/auth.json` | HIGH (source + URL-pin test) |
| **OpenCode** | **federates** (no own quota) | per-provider, via its stored tokens | `~/.local/share/opencode/auth.json` | HIGH |
| **Antigravity** (Gemini) | proactive POST (med) / dated-error (high) | `cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels` (or LS over localhost) | `%APPDATA%/Antigravity/User/globalStorage/state.vscdb` | MED proactive / HIGH reactive |
| **VS Code Copilot** | **proactive GET** | `api.github.com/copilot_internal/user` | DPAPI SecretStorage (`state.vscdb`) / `gh`/`copilot` CLI | HIGH endpoint / MED token-extraction |
| Gemini raw API | reactive only | 429 `RESOURCE_EXHAUSTED` + `RetryInfo` | API key | HIGH (Google staff: no proactive header) |

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

**Local tier (no call):** `~/.codex/auth.json tokens.id_token` (JWT) → claim
`https://api.openai.com/auth.chatgpt_plan_type` (= "plus" here) + `chatgpt_account_id`,
`chatgpt_subscription_active_until`. (NOTE on this machine: `active_until` is `2026-06-11`,
already past — confirm wham/usage still authorizes when running it live.)

**Mapping:** per window `remaining_pct = 1 − used_percent/100`, `reset_at = window.reset_at`
(or `now + reset_after_seconds`). Emit two snapshots (5h + weekly), keyed by
`limit_window_seconds` (18000 vs 604800). `credits.unlimited/has_credits` flags whether %-limits apply.

**Refresh** (on 401): `POST https://auth.openai.com/oauth/token`, `grant_type=refresh_token`,
`client_id=app_EMoamEEZ73f0CkXaXp7hrann`.

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
`COPILOT_HOME` override) or **`gh` CLI** `~/.config/gh/hosts.yml`. (On THIS machine: Copilot Chat
ext not installed — only leftover globalStorage; no `~/.config/github-copilot/` — so a CLI token
is the extractable source.)

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
