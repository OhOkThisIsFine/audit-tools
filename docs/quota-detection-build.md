# Quota detection — proactive per-provider QuotaSource (working build doc)

> Transient build/checkpoint doc. Fold into HANDOFF/backlog at sprint end.
> HANDOFF step 1 ("sort out quota detection first"). Companion to A8 dispatch.

## What the survey found (reframes the HANDOFF "build a QuotaSource interface")

The `QuotaSource` abstraction **already exists** and the scheduler **already consumes** it:
- `QuotaSource { queryCurrentUsage(providerModelKey) → QuotaUsageSnapshot|null }`
  (`packages/shared/src/quota/quotaSource.ts`). Snapshot = `{ remaining_pct, reset_at,
  requests_remaining, tokens_remaining, captured_at, source }`.
- `buildQuotaSource()` composes `CompositeQuotaSource([...proactive, ...additional, Learned])`
  (`compositeQuotaSource.ts`) — first non-null snapshot wins; throwing sources are skipped.
- `scheduler.ts applyQuotaSourceAdjustment` turns `remaining_pct` into throttle/cooldown:
  `< QUOTA_REMAINING_PCT_CRITICAL (0.1)` → wave=1 + cooldown to `reset_at`; `< _LOW (0.3)` → halve.
  **`remaining_pct` is a 0–1 FRACTION, not 0–100** (despite the name).
- Reactive 429 / "usage limit… try again at <date>" / retry-after parsing exists
  (`errorParsing.ts`, `errorParsers/claudeCodeErrorParser.ts`); codex exhaustion already lands
  in `quota-state.json` cooldowns via the learned path.

**The real gap:** (1) no PROACTIVE source (nothing queried remaining-quota before a 429);
(2) **nothing in production calls `buildQuotaSource` or populates `pool.quotaSourceSnapshot`** —
the cascade is wired through capacity/scheduler but never fed.

## Confirmed live (2026-06-16, 200 OK on this machine)

`GET api.anthropic.com/api/oauth/usage` (Bearer `claudeAiOauth.accessToken` from
`~/.claude/.credentials.json`; `anthropic-beta: oauth-2025-04-20`; UA `claude-cli/<ver> (external, cli)`).
Body: `five_hour`/`seven_day` `{utilization, resets_at}`; a normalized **`limits[]`**
(`{kind, percent, severity, resets_at, scope{model{display_name}}, is_active}`) — cleanest signal;
`spend` (cost); `extra_usage`; many always-null codename buckets. Tier is in local creds
(`rateLimitTier`/`subscriptionType`) → `/profile` optional. Full shape: memory
`claude-oauth-usage-quota-endpoint`.

## Step B — ClaudeOAuthQuotaSource — ✅ DONE, green (646/0 shared)

`packages/shared/src/quota/claudeOAuthQuotaSource.ts`:
- `implements QuotaSource`, `name="claude-oauth"`. Gates on provider (`claude-code`/`claude`);
  returns null (no I/O) for any other key.
- Reads creds → GET `/usage` → `mapUsageToSnapshot`: binding window = highest utilization across
  `limits[]` (model-applicable via `scope.model.display_name`, data-driven) + `five_hour`/`seven_day`;
  `remaining_pct = (100 − util)/100` (exact for integer %); `reset_at` = that window's reset.
- Cache ~45s/key; degrade→null on missing creds / expired token / non-200 / parse error / network.
  **No token refresh here** (host `claude` CLI owns the rotating creds; rewriting risks breaking auth).
- **No hardcoded model names** (INV-QD-04): per-model constraints come ONLY from `limits[].scope.model`;
  dropped the top-level `seven_day_opus/sonnet` field reads.
- `buildQuotaSource({ claudeOAuth? })` now includes it by default (ahead of learned); `false` disables.
- Exported from `index.ts` (`ClaudeOAuthQuotaSource`, `buildQuotaSource`, `parseProviderModelKey`,
  `mapUsageToSnapshot`, types). Tests: `tests/claudeOAuthQuotaSource.test.mjs` (13) +
  `compositeQuotaSource.test.mjs` (claudeOAuth default/disable).

## Step C — wire the snapshot into pool construction — NEXT (makes it live)

Find where `CapacityPool[]` is built in each live path and set `quotaSourceSnapshot` by awaiting
`buildQuotaSource().queryCurrentUsage(buildProviderModelKey(provider, hostModel))`:
- audit-code: `prepareDispatchArtifacts` / capacity build site.
- remediate-code: `waveScheduler` / `scheduleWave` capacity build site.
- `computeDispatchCapacity` (`capacity.ts:254`) and `rollingDispatch.ts:273` already thread
  `pool.quotaSourceSnapshot` → consumed in `scheduleWave`.
- Cache in the source means many pool builds in one burst → one probe. Pass a shared instance.

## Step D — cross-provider QuotaSource matrix (the bigger follow-on)

Per-provider best signal (proactive endpoint > reactive dated-limit parse > consumption estimate):
codex/OpenAI, gemini, opencode, antigravity, local (unbounded), other IDEs (Cursor org admin API).
Most reduce to wrapping the existing reactive error-parse into a `QuotaSource` + `exhausted-until`.
Backlog: "Cross-IDE/provider quota detection".
