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

Configuration splits across three shapes, one per home (the INTENT/CAPABILITY cut in
`spec/unified-dispatch-worker-model.md`):

- **`session-config/`** — repo-persisted **intent only** (`RepoSessionIntent`): scope, synthesis,
  analyzers, quota *policy*. Dispatch-inventory fields (`provider`, `sources`, per-backend launch
  blocks) are rejected at load — they are per-auditor capability and never live in the repo. Every
  fixture here is validated by `tests/shared/examples-session-config.test.ts`, so an example that
  stops loading fails the suite.
- **`auditor-descriptor/`** — the per-invocation `--auditor <json>` handshake: `self` (the driving
  agent's provider identity, model scalars, subagent capabilities) plus optional explicit `sources[]`
  (the operator's escape hatch — normally sources resolve ambiently instead).
- **`catalog/sources-declared.json`** — the machine-level declaration (`~/.audit-code/sources-declared.json`)
  of backends this box owns, including the optional `proxy` lane; see below.

### `catalog/sources-declared.json` — a free dispatch pool (arbitrage tier, Phase 0)

**This is no longer a session-config.** Dispatch sources are per-auditor CAPABILITY, not repo intent, so
`sources[]` was removed from the persisted session-config type and the file moved to
`examples/catalog/sources-declared.json`. Copy it to `~/.audit-code/sources-declared.json` — the
machine-level declaration of the backends you own. Every `next-step` intersects it with what the running
process can actually reach (`declared ∩ ambient-verifiable`) and dispatches to the survivors. Two IDEs on
one box each resolve it against their own environment, so each gets its own pool with nothing shared.
See `spec/unified-dispatch-worker-model.md` → *Source resolution — in-process, by construction*.

It shows the quota-arbitrage pattern: adding a genuinely-free backend as an extra **dispatch source pool**
alongside the conversation host, so background work routes to it first. Pure config — no provider code —
using the `openai-compatible` shape pointed at opencode's public ZEN endpoint. To run it:

- Export `OPENCODE_ZEN_API_KEY=public` — the free models need only the static `Bearer public` token (no
  account, no signup; the "get an API key" flow is opencode's *paid* tier). The declaration names the
  variable (`api_key_env`) and never carries an inline `api_key`; **why** a declared lane must prove
  reach rather than merely possess a credential is at
  `spec/unified-dispatch-worker-model.md` → *Source resolution — in-process, by construction*.
- The free model ids are **promotional and time-limited** — fetch the current list from
  `GET https://opencode.ai/zen/v1/models` (public, unauthenticated) rather than trusting the example's id.

`cost_per_mtok: 0` declares the source free. Declared cost wins pricing precedence for a source and is
backed by reactive verification, so a "free" tier that starts billing is demoted for the rest of the run —
the ranking rule lives in [`spec/cost-first-routing.md`](../spec/cost-first-routing.md), and the drift
event is documented at its code site (`src/shared/friction/stepBoundaryCapture.ts`,
`declared_cost_drift`). Cost is declared per **source** (`sources[].cost_per_mtok`); the legacy singleton
`openai_compatible` provider block has no cost field.
