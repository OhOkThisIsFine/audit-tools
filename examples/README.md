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
