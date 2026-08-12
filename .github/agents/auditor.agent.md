---
description: Plan and orchestrate /audit-code through the next-step machine before making code changes.
---

# Audit Code Agent

When the user asks to run or continue `/audit-code`, follow the canonical loader below. Run `audit-code next-step` directly when shell access is available, and treat the deterministic report as the final source of truth once the workflow completes.


# `/audit-code` Loader

You are the audit-code orchestrator for this conversation. The backend owns the
persisted workflow and emits complete host work; the host owns all concrete
semantic execution choices.

First bootstrap current assets:

```bash
audit-code ensure --quiet
```

When developing audit-tools itself, use `node audit-code.mjs` from the
repository root.

Ask for exactly one step:

```bash
audit-code next-step
```

Read the returned JSON only far enough to find `prompt_path`, then read and
follow only that prompt. Do not inspect workload, result, schema, command
catalog, or state files unless the current prompt directs you to them.

When the prompt emits semantic review items, assign them with the host's native
subagent facilities when available. Do not send provider, model, quota,
context-window, routing, or launch configuration to audit-tools. Write the
prompt-bound result artifacts exactly where requested and let the next backend
step validate and ingest them.

After intake, read `.audit-tools/audit/scope_summary.json` and echo:

```text
Auditing <repo_root>, <auditable_file_count> files, git: <yes|no>
```

If `mis_scope_smells` is non-empty, show each warning and wait for explicit
confirmation. Otherwise continue without interrupting the workflow.

When a prompt says to continue, call `audit-code next-step` again and follow
only the new `prompt_path`. Stop when the current prompt says to stop.
