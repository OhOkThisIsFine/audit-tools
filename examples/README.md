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
### `~/.audit-code/sources-declared.json` — broker pool intents

**This is not a session-config, and no example of it ships here.** Dispatch sources are per-auditor
CAPABILITY, not repo intent, so `sources[]` was removed from the persisted session-config type. The
declaration is machine-level, at `~/.audit-code/sources-declared.json` — the backends *you* own. Every
`next-step` intersects it with what the running process can actually reach
(`declared ∩ ambient-verifiable`) and dispatches to the survivors. Two IDEs on one box each resolve it
against their own environment, so each gets its own pool with nothing shared.
See `spec/unified-dispatch-worker-model.md` → *Source resolution — in-process, by construction*.

A copy-paste example used to ship at `examples/catalog/`. It was deleted rather than corrected: its
`model` values named pools belonging to a broker this repo does not own, and when that broker renamed
them the shipped example became a config that fails every dispatch with an error reading like a proxy
fault. A checked-in copy of another system's roster is the thing that rots — so ask your broker for its
live pool names instead of copying any written list.

**The shape.** One `{ "sources": [ … ] }` object. Each entry declares an `id`, a `transport`, the
`endpoint` serving it, and a `model` — a provider-neutral pool intent that the broker expands into
concrete candidates, ordering, health and failover. Optional per-entry: `worker_kind`,
`capability_rank` (dispatch order), and a `quota` block (`context_tokens`, `output_tokens`,
`max_concurrent`). Name the credential with `api_key_env`, or set `no_auth: true` for a loopback-only
broker; never put a secret in this file. `auditor-descriptor/self-with-sources.json` carries one entry
of exactly this shape inline, as the `--auditor` escape hatch.
