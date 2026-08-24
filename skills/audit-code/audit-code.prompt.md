---
description: Autonomous local-loop code auditing through provider-neutral host workloads
argument-hint: [target-dir]
allowed-tools: [Read, Bash, Glob, Grep, Agent]
---

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

- pass the user-supplied target directory with `--root <path>` on every
  `audit-code` command (`ensure` and each `next-step`)

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
context-window, routing, or launch configuration to audit-tools. Write the
prompt-bound result artifacts exactly where requested and let the next backend
step validate and ingest them.

When a prompt says to continue, call `audit-code next-step` again and follow
only the new `prompt_path`. Stop when the current prompt says to stop.
