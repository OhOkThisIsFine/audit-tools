# Examples

This directory holds:

- example repo/unit manifests
- example file disposition
- example audit state snapshot
- example risk register
- example critical flows + flow coverage
- example coverage matrices
- example audit tasks + requeue tasks (plain + flow-scoped)
- example audit results
- example external analyzer results
- example runtime validation tasks/report/update
- example audit plan metrics

Review packets are never persisted — they're partitioned JIT at dispatch (see `CLAUDE.md`) — so there
is no example for them.

`session-config/` holds example `session-config.json` files for several providers (`claude-code`,
`opencode`, `worker-command`, `subprocess-template`, `vscode-task`, plus `auto` and per-model
variants). The remaining backends — `codex`, `openai-compatible`, `antigravity` — are configured the
same way (a `<provider>` block under the provider key; see the config shapes in
`src/shared/types/sessionConfig.ts` and the provider notes in the repo `CLAUDE.md`); example files for
them are not yet bundled here.

### `opencode-free.json` — a free dispatch pool via `sources[]` (arbitrage tier, Phase 0)

`opencode-free.json` shows the quota-arbitrage pattern: adding a genuinely-free backend as an extra
**dispatch source pool** alongside the conversation host, so background work routes to it first. It is a
pure-config `sources[]` entry — no provider code — using the `openai-compatible` shape pointed at
opencode's public ZEN endpoint:

- `endpoint: "https://opencode.ai/zen/v1"` with `api_key: "public"` — the free models need only the
  static `Bearer public` token (no account, no signup; the "get an API key" flow is opencode's *paid*
  tier).
- `cost_per_mtok: 0` declares the source free, so `deriveCostRank` sorts it below any priced pool and
  the admission router fills it first. This declared `0` is **backed by reactive cost verification**:
  opencode returns an actual `cost` on each completion, so if a "free" model starts charging, the pool
  is demoted out of free-first for the rest of the run and a `declared_cost_drift` friction event fires
  telling you to reconcile the declaration — a stale `cost_per_mtok:0` can't silently keep winning.
- `model` — the free model ids are **promotional and time-limited**; fetch the current list from
  `GET https://opencode.ai/zen/v1/models` (public, unauthenticated) rather than trusting the example's
  id. Free models are small / coding-optimized and degrade like any `reactive_only` source (a broken
  model spills to the next pool on a 401/format error, never an outage).

Cost must be declared per **source** (`sources[].cost_per_mtok`): the legacy singleton
`openai_compatible` provider block has no cost field, so a free backend is configured as a `sources[]`
entry, not the singleton.
