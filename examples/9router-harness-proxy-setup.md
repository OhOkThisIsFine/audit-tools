# 9router as the harness-level dispatch proxy

Deployment guidance (not audit-tools code). Lets the Claude Code harness — both your daily driving
and the harness audit-tools runs under — fail over across provider subscriptions + free backends when
one is quota-blocked. audit-tools stays a pure packet-assigner; the harness's `ANTHROPIC_BASE_URL`
does the routing "according to its wont." Nothing is hardcoded into audit-tools.

## What's deployed

- `9router` 0.5.40 global npm CLI (`npm install -g 9router`). A long-running local gateway
  (Next.js) presenting an OpenAI/Anthropic-compatible surface, with per-account quota tracking,
  auto token-refresh, and Subscription → Cheap → Free auto-fallback with per-account rotation.
- Running at **`http://127.0.0.1:20128`** — bound to localhost deliberately (holds your subscription
  OAuth tokens; the CLI default `0.0.0.0` exposes it on the LAN).
- Endpoints: dashboard `/dashboard` (→ `/login`), OpenAI-compatible API `/v1`, health `/api/health`.

## Keep it running (persistence) — auto-start installed

A hidden **at-logon scheduled task** `9router-autostart` is registered (runs
`9router --tray --host 127.0.0.1 --skip-update -n` as the current user). It starts the gateway in the
system tray at every logon; verified it brings the server up detached from any shell. Manage it:

```powershell
Get-ScheduledTask 9router-autostart            # state
Start-ScheduledTask 9router-autostart          # start now
Stop-ScheduledTask  9router-autostart          # stop the task instance
Unregister-ScheduledTask 9router-autostart -Confirm:$false   # remove auto-start
```

`--host 127.0.0.1` keeps it local-only (correct for a token-holding proxy); edit the task action if
you deliberately want LAN access.

## One-time setup (your steps — auth is yours to do)

1. **⚠ Set a strong dashboard password FIRST — security-critical.** 9router's fallback password is the
   hardcoded default `123456` until you set one, and this proxy is about to hold your subscription
   OAuth tokens. It's localhost-bound (so nothing off-box can reach it yet), but set a real password
   before connecting any provider: open `http://127.0.0.1:20128` → set the password.
2. **Connect providers** (Dashboard → Providers):
   - *Free, no signup:* **Kiro AI** (`kr/…`, ~50 credits/mo incl. Claude 4.5 / GLM-5 / MiniMax) or
     **OpenCode Free** (no auth). Good to prove failover immediately.
   - *Your subscriptions:* **Claude Code** (`cc/…`), **Codex** (`cx/…`), **GitHub Copilot**. 9router
     can **auto-import your existing local CLI tokens** (Providers → import) rather than a fresh
     browser OAuth, then auto-refreshes them.
   - *API-key backends* (NIM, etc.): Dashboard → Add API Key. For NIM, either add NVIDIA directly or
     add a custom OpenAI-compatible node pointed at your existing LiteLLM (`http://127.0.0.1:4000`) to
     reuse that roster.
3. **Routing — dynamic, not combos.** Static combos *pin* model ids and go stale when providers ship
   new models, so they can't be the routing brain (only 9router's reactive fallback). The settled
   direction is **dynamic routing** — audit-tools reads 9router's live roster/quota and picks the
   current target; see
   [`../docs/reviews/host-routed-dispatch-design-2026-07-23.md`](../docs/reviews/host-routed-dispatch-design-2026-07-23.md).
   Combos remain available in the dashboard as optional reactive-fallback chains if you want them.
4. **Copy the 9router API key** (Dashboard → Keys).
5. **Point Claude Code at it.** Easiest: **Dashboard → CLI Tools → Claude Code → Apply** (9router
   writes the config). Manual equivalent in `~/.claude/settings.json` `env`:
   ```json
   { "env": {
       "ANTHROPIC_BASE_URL": "http://127.0.0.1:20128",
       "ANTHROPIC_AUTH_TOKEN": "<your-9router-api-key>"
   } }
   ```
   Restart Claude Code (base URL is read once at startup). Verify with a trivial prompt, then watch
   the dashboard show the request routed + which tier served it. To use a combo, set the model to the
   combo name (e.g. `heavy-reason`).

## How audit-tools inherits this (zero code change)

When you run `/audit-code` (or remediate) inside a Claude Code pointed at 9router, the
conversation-first host dispatches (Claude subagents) ride the same `ANTHROPIC_BASE_URL` → 9router
does the failover under them. audit-tools is unchanged — it assigns packets to the host provider; the
proxy decides which backend serves each request.

**Optional follow-up (not required):** audit-tools *also* has its own direct source-pool lanes
(`~/.audit-code/sources-declared.json` — the NIM/codex/agy entries) that bypass the host and hit
backends directly. Since the intent is "let the IDE assign," you can thin those out so *everything*
rides the host→9router path and there's one routing brain instead of two. That's a config change, not
code — decide it after you've seen 9router's routing behave the way you want.

## Notes

- ToS: subscription-OAuth capture (Claude/Codex/etc.) is ToS-adjacent for those vendors; you've
  accepted this for your own accounts/own risk. Keep it opt-in per provider.
- The tokens live in 9router's local data store — treat that machine/dir as holding high-value
  secrets (don't expose the port, don't sync the data dir to anything shared).
