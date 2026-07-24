# Proactively directing dispatch to chosen targets (vs 9router's reactive fallback)

Design answer to: "9router's quota-fallback is great, but separately, how can the dispatcher (the
driving agent) *proactively* direct dispatch to chosen targets?"

## The core insight — proactive direction is not a feature to build, it's *naming the target*

9router routes on the request's `model` field. Every backend is addressable by a namespaced id:
`cc/claude-opus-4-7` (Claude sub), `cx/gpt-5.3-codex` (Codex sub), `glm/glm-5.1`, `kr/claude-sonnet-4.5`
(Kiro free), `nim/…`, etc. And a **combo** is a *named ordered routing policy* — `{primary, …fallbacks}`
that auto-switches on quota/error.

So the two behaviors are the same mechanism at different granularities:

- **Proactive direction = the id/combo the dispatcher puts in each request.** Naming `cx/gpt-5.3-codex`
  *is* choosing that target.
- **Reactive fallback = what 9router does *inside* a combo** when the named primary is blocked.

They compose cleanly: name a combo whose **primary is your chosen target** → you steer proactively,
9router deviates only when that target is actually quota-blocked. You don't pick one or the other.

## The design decision you actually own: how much routing authority the dispatcher keeps

This is the real knob, and it maps directly onto your "audit-tools assigns packets, the IDE routes"
stance:

- **Coarse (delegate fine routing to 9router):** the dispatcher names a **combo** = a task-class policy
  (`heavy-reason`, `cheap-bulk`, `codex-lane`). audit-tools' "choice" is which policy; 9router owns the
  exact provider + fallback. Maximally decoupled — audit-tools emits one string, no provider knowledge.
- **Fine (dispatcher makes the exact call):** the dispatcher names a **hard model id**; 9router just
  executes it (with whatever single-target fallback you allow). audit-tools' existing routing brain
  (capability floor · cost rank · λ dial · operator priority order) makes the per-packet decision.

Both are proactive. The choice is where the *fine* decision lives. Given your stance, the default
should be **coarse: audit-tools names a combo, 9router routes within it** — the dispatcher steers by
task-class, the IDE-side router does the rest, and nothing provider-specific is hardcoded in
audit-tools (it emits a combo-name string, which is data, not coupling).

## How each dispatcher expresses the choice

**audit-tools (already a proactive selector).** It has a full target-selection engine today. To route
to 9router: declare source pools whose `model` is a 9router namespaced id **or a combo name**. The
existing capability/cost/λ/operator-order routing picks the pool per packet → the pool's model string
names the 9router target/combo → proactive direction with zero new coupling. This is the both-worlds
result: proactive selection in audit-tools, reactive fallback in 9router.

**Conversational dispatcher (the driving agent in Claude Code).** Honest limitation: vanilla Claude
Code sends *one* configured model per session, so the in-conversation agent can't freely address
arbitrary 9router ids per message through the standard harness. Two levers:
- **Session default = a combo** (e.g. point the session at `premium-coding`) → one proactive default +
  reactive safety, but not per-task variation.
- **Per-task override = call 9router `/v1` directly** with a chosen id (the existing `llm-call.mjs`
  offload helper, repointed at `http://127.0.0.1:20128/v1`). This is how the agent "actively chooses
  the target" for a specific sub-task — name `cx/gpt-5.3-codex` for one, `nim/glm-5.2` for another.

## The one thing that will bite if ignored: read back which target actually served

Proactive selection + reactive fallback only compose **honestly** if the dispatcher learns which target
9router actually used. If audit-tools proactively picks X, 9router silently falls back to Y (X blocked),
and audit-tools books the work against X, its quota/cost accounting is now wrong — the classic
silent-fallback corruption. 9router returns the served model in the response/usage; the dispatcher must
reconcile against it, exactly as audit-tools already reads back `observedCostUsd` and fires cost-drift
demotion (`extractReportedCostUsd`). **Rule: named target is a request; served target is a fact — book
against the fact.** This is the seam that keeps proactive+reactive from lying to the dispatcher.

## Recommended shape

1. **Define combos as your target vocabulary** (dashboard) — a handful of task-class policies, each with
   a chosen primary (proactive) + fallback chain (reactive). "Choose a target" becomes "name a combo."
2. **audit-tools names the combo per packet** (source-pool model = combo name). Its routing picks the
   class; 9router routes+falls-back within it. No provider coupling.
3. **Conversational per-task steering** via direct 9router `/v1` calls with a named id when the agent
   wants an exact target; otherwise the session-combo default carries it.
4. **Feed the served-target back** into the dispatcher's accounting (reuse the observed-cost seam).

Reactive fallback (9router) and proactive direction (dispatcher names the combo/id) are the same
routing surface read from two ends — not two systems to reconcile.
