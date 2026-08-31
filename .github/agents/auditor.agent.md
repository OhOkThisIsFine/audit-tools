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

Preserve user arguments:

- run `audit-code` from inside the target repository; every command resolves
  that repository's root from the working directory on its own, so normal usage
  passes no `--root`
- pass the user-supplied target directory with `--root <path>` only when running
  from outside that repository

This is the one full statement of the target-directory rule; the `audit-code`
skill points here instead of restating it.

Ask for exactly one step:

```bash
audit-code next-step
```

Read the returned JSON only far enough to find `prompt_path`, then read and
follow only that prompt. Do not inspect workload, result, schema, command
catalog, or state files unless the current prompt directs you to them.

When the prompt emits semantic review items, assign them with the host's native
subagent facilities when available. Do not send provider, model, quota,
context-window, routing, or launch configuration to audit-tools. Before treating
the run as comprehensive, perform a host-side structural-capability preflight:
confirm the host can inspect the structural graph/relationships and source
structure required by the workload. This is a host capability check, not an
audit-tools MCP/provider or lane-selection step. If capability is degraded but
you proceed, record one reserved AgentReflection with task_id exactly
`audit-capability-preflight`; use severity `high` or `critical` when material to
claimed coverage, with concrete `tool_friction`, `ambiguities`, and `suggestions`
details. A structurally incapable run must not be labelled comprehensive. Keep
the conversation-first flow and loader contract; do not add provider, routing,
model, or machine-capability fields to audit-tools. Write the
prompt-bound result artifacts exactly where requested and let the next backend
step validate and ingest them.

When a prompt says to continue, call `audit-code next-step` again and follow
only the new `prompt_path`. Stop when the current prompt says to stop.
