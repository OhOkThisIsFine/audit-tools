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
  of provider-neutral broker pool intents; see below.

### `catalog/sources-declared.json` — broker pool intents

**This is no longer a session-config.** Dispatch sources are per-auditor CAPABILITY, not repo intent, so
`sources[]` was removed from the persisted session-config type and the file moved to
`examples/catalog/sources-declared.json`. Copy it to `~/.audit-code/sources-declared.json` — the
machine-level declaration of the backends you own. Every `next-step` intersects it with what the running
process can actually reach (`declared ∩ ambient-verifiable`) and dispatches to the survivors. Two IDEs on
one box each resolve it against their own environment, so each gets its own pool with nothing shared.
See `spec/unified-dispatch-worker-model.md` → *Source resolution — in-process, by construction*.

The example points the generic `openai-compatible` adapter at a loopback dispatch broker and names
only `pool/fast`, `pool/coding`, and `pool/reasoning`. The broker owns concrete providers, model ids,
credentials, ordering, health, and failover. Audit-tools sees three stable capability intents and
continues to enforce context fit, quota/headroom, concurrency, and result validation.

The example uses `no_auth: true` because the broker is loopback-only. A remote or authenticated
broker should name its credential with `api_key_env`; never put a secret in this file.
