# Examples

Every `*.example.json` here is named after what it illustrates. The payloads are
illustrative, not normative — a couple have a JSON Schema under `schemas/`, and
only the ones a contract test names are validated at all. The two configuration
homes below are the exception: those are config, not artifact payloads.

Review work is emitted as a versioned host workload under `.audit-tools/audit/`
during a run, so there is no static execution-backend example here.

Repository configuration has two strict, provider-neutral homes:

- **`session-config/minimal.json`** — optional session intent (`review_mode` and
  `observability`). Unknown keys fail closed.
- **`analyzer-policy.example.json`** — durable external-analyzer resolution and
  consent decisions. Per-run consent tokens are not persistable.

Provider, model, routing, quota, context-window, and worker-command inventory is
not an audit-tools configuration surface. The conversation host owns those
execution choices.
