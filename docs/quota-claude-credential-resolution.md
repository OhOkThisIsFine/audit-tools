# Claude quota credential resolution (design note)

Durable conclusions from the 2026-06-23 quota-detection investigation. Conceptual,
not a changelog — how the Claude proactive quota source must source its credential.

## The signal exists; the credential sourcing was naive

`ClaudeOAuthQuotaSource` probes the undocumented `GET api.anthropic.com/api/oauth/usage`
endpoint (OAuth Bearer + `anthropic-beta: oauth-2025-04-20` + first-party-shaped
`User-Agent`). The probe + window-mapping + cascade wiring are all intact. The defect
was upstream of the probe: it only **read** `accessToken` from `~/.claude/.credentials.json`
and bailed on expiry. The access token lives ~8h; the `refreshToken` beside it lives far
longer and was never used. So the source goes dark ~8h after any CLI login and never
self-heals. Refresh logic never existed (confirmed via git history) — this is a gap, not a
regression.

`/usage` response shape (the part we map): top-level `five_hour` / `seven_day` windows
each `{utilization, resets_at}`, plus `limits[]` with per-scope `{percent, resets_at,
scope.model}`. We pick the most-constraining (highest utilization) window → `remaining_pct`.

## Who needs Claude quota, and which credential

Quota is needed only when Claude is the **active dispatch target** — gate on that, never
probe/touch Claude creds otherwise:

- **Host = Claude Desktop** → need Desktop's account quota.
- **Host = other IDE, dispatching subagents via the Claude CLI provider** → need the CLI's quota.
- **Host = other IDE, no Claude CLI dispatch** → don't consult or touch Claude creds at all.

Quota is **account-level**: any valid credential for the same account returns the same
`/usage` numbers regardless of which Claude surface (Desktop / CLI) is dispatching.

## No supported way to read Desktop's own token (decryption-free)

Authoritatively confirmed against official Claude Code / Agent SDK docs:

- No host→subprocess token handoff API (`getAccessToken()`, credential-helper for OAuth,
  stdio credential channel) is public.
- `CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH` / `CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH` are
  internal/undocumented; not a usable affordance.
- `apiKeyHelper` is terminal-CLI-only and does not apply to Desktop/OAuth.
- Desktop's token is in the OS-encrypted store (Electron safeStorage / DPAPI). Manual
  decryption is unsupported and version-fragile → **forbidden by robustness-in-tooling**.
- The ONLY blessed credential handoff for a subprocess is `claude setup-token` →
  long-lived `CLAUDE_CODE_OAUTH_TOKEN`. It is an OAuth token and works against `/usage`.

## Resolution order (robust, decryption-free, operator-supplied — never scraped)

Auto-discovered (no manual flag); first hit wins:

1. `CLAUDE_CODE_OAUTH_TOKEN` (env or session config) — the supported handoff. Works for
   any host, including Desktop. One-time `claude setup-token`.
2. `~/.claude/.credentials.json` with **refresh-on-expiry**: when `accessToken` is
   missing/expired (or `/usage` 401s) and a `refreshToken` exists, POST the refresh grant
   (`console.anthropic.com/v1/oauth/token`, grant_type=refresh_token), then **persist the
   rotated creds atomically under `withFileLock`** (double-checked: re-read after acquiring
   the lock so concurrent probes never double-rotate and invalidate each other). This is
   the CLI-dispatch credential.
3. Else degrade to the reactive `HostSessionQuotaSource` (parses "you hit your session
   limit" from the worker channel) — no credential, graceful, no proactive remaining-%.

### Hard-won hazard: refresh tokens rotate

A refresh grant **rotates** the refresh token; the old one is immediately invalidated.
Two consequences the implementation MUST respect:
- Persist the new refresh token or the credential is bricked. (During investigation an
  un-persisted refresh + a failed retry wrote `undefined` into the creds file — recovered
  in-session, but it's the exact clobber the file-lock + double-check must prevent.)
- Never refresh+rotate a creds file owned by another *active* host. Desktop uses its own
  encrypted store, so refreshing the idle CLI file is safe — but the gating above is what
  guarantees we only refresh the file whose surface we're actually dispatching to.

## Constants, not couplings

OAuth `client_id` (Claude Code's public client) + token endpoint are named constants with
override options — same pattern as the existing `USAGE_ENDPOINT` / beta-header constants.
No model identities hardcoded (per `limits[].scope.model`, data-driven).
