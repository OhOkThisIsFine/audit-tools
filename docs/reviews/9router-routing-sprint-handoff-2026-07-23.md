# 9router integration + routing redesign — sprint handoff (2026-07-23)

Self-contained pickup for a new conversation. This sprint did **no audit-tools source changes** — it
deployed/configured 9router (external) and produced design docs. Everything below is docs + external
config + memory.

## How this started

Investigating "why aren't Codex/AGY dispatched via LiteLLM?" → answer: LiteLLM fronts *models*, CLI
agents are *harnesses*. Owner then wanted 9router's functionality (front arbitrary provider agents via
the Claude harness + quota failover). Led to deploying 9router and redesigning audit-tools dispatch.

## Current state (live)

- **9router 0.5.40** installed globally, running at **`http://127.0.0.1:20128`** (localhost-bound),
  **auto-starts at logon** via Windows scheduled task **`9router-autostart`** (verified). Dashboard
  password set by owner. Data/token store: `~/.9router/db/data.sqlite` (local).
- **Settings hardened:** RTK (tool-output compression) **OFF** (would corrupt audit fidelity); routing
  **Combo Round Robin OFF** (primary-first); Require-login ON; Endpoint Local (no tunnel/tailscale);
  Observability ON. Only compatibility conflict was RTK — fixed.
- **Providers connected:** Claude, Codex, Antigravity (AGY), Gemini-CLI, Kiro, NVIDIA NIM (native),
  + many free/paid — 161 models. **Free quota is large:** AGY ~10 models×1000/5h (incl. *free* Claude
  Sonnet/Opus 4.6), Gemini-CLI 8×1000/day, Kiro 50/wk. **Only DeepSeek / Mistral / Perplexity actually
  bill** — everything else is free-tier or already-paid subscription.
- **Combos:** 6 task-class combos were created, then **DELETED by owner** (they pin model ids → go
  stale). **None currently exist.** Daily-driver routing is **deferred** by owner until quota bites.
- **ToS:** the old "Codex-subscription-off-CLI is OUT / don't cross it" ruling was **REMOVED** (owner
  reversal, 2026-07-23) — subscription-OAuth capture is IN, own-risk, opt-in.

## Decided / done

- **LiteLLM is retirable.** Confirmed 2026-07-23: 9router passes `response_format: json_schema` to NIM
  and NIM enforces it (clean conforming output). So the offload lane (`~/.claude/llm-call.mjs`) can
  point at `9router:20128/v1` with `nvidia/…` models and keep schema enforcement; audit-tools' NIM
  source pools retire in the redesign. LiteLLM's only remaining jobs both migrate to 9router.
- **Routing architecture settled (right-sized).** audit-code **categorizes only** (packet requirements,
  no model ids); a **deterministic router** — audit-tools' *existing* capability/cost/quota logic,
  **re-pointed** at 9router's live roster/quota — **routes**; 9router **transports** + reactive-fallback.
  "Everything-agnostic" = runtime-discovered, NOT a separate process, so **no extraction / no
  from-scratch router** is needed. Full plan: [`host-routed-dispatch-design-2026-07-23.md`](host-routed-dispatch-design-2026-07-23.md).

## NOT done — immediate next

1. **Claude Code wiring — NOT done.** ⚠ The dashboard **CLI-Tools → Claude-Code route HANGS the whole
   9router server** (event-loop block from a Windows subprocess probe). Do NOT use it. Wire manually:
   `~/.claude/settings.json` → `env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:20128",
   ANTHROPIC_AUTH_TOKEN: "<key>" }`, target a single current model (owner deferred daily-driver
   routing). No API key exists yet (require-key is off, so a placeholder token works on localhost).
2. **Routing integration — plan only, not built.** Right-sized change list in the design doc:
   (a) re-point `proxyCatalog` at 9router `/v1/models`; (b) add `NineRouterQuotaSource` reading
   `/api/usage` + quota tracker; (c) **capability-rank prefix-mapping** (`ag/`,`cx/`,`kr/` ids don't
   match models.dev — the one real gap, do this first); (d) dispatch through 9router; (e) served-target
   readback. Not a rewrite — a re-point + two small adapters.

## Files this sprint produced (all UNCOMMITTED on `main`)

- `examples/9router-harness-proxy-setup.md` — deploy / config / manage guide
- `examples/configure-9router.mjs` — combo reproducer, kept **LOCAL/uncommitted** (combos superseded
  by dynamic routing; retained only as a possible daily-driver stopgap)
- `docs/reviews/host-routed-dispatch-design-2026-07-23.md` — **routing design + build plan (start here)**
- `docs/reviews/proactive-dispatch-via-9router-2026-07-23.md`, `litellm-vs-cli-dispatch-investigation-2026-07-23.md`
- this handoff
- Memory: `9router-functionality-wanted-tos-reversed`, `proactive-dispatch-is-naming-the-target`,
  `routing-is-separate-from-categorization` (added); `repair-proxy-registry-and-codex-tos` (ToS ruling removed).

## Traps hit (don't rediscover)

- **9router `cli-tools/<tool>` routes can wedge the whole server** (block the event loop). Recover:
  `Stop-Process` the pid on :20128, then `Start-ScheduledTask 9router-autostart`.
- **Combos pin model ids**; no `cc/`/`cx/`/`ag/` "latest" alias exists → they go stale on new models.
  Reactive fallback only, never the routing brain — this is *why* routing must be dynamic.

## The audit-tools product track is unchanged

This sprint didn't touch the product's own immediate-next (the dogfood-resume defect tier in
`docs/backlog.md` / `docs/HANDOFF.md`). That work is where it was.
