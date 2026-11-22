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

Preserve user arguments:

- run from inside the target repository; every command resolves that repository's
  root from the working directory on its own, so normal usage passes no `--root`.
  Pass the user-supplied target directory with `--root <path>` only when running
  from outside that repository.

Ask for exactly one step:

```bash
audit-code next-step
```

The command prints a JSON step record. Read the prompt file at its
`prompt_path`, then follow only that prompt. Do not inspect workload, result,
schema, or state files unless the current prompt directs you to them.

When the prompt emits bound questions, answer the issued assignments in separate
contexts when the host can, else yourself, as the prompt directs. Follow the
current prompt's submission instructions (the bound submit command or tool, or a
result path when explicitly given). Do not substitute an old per-file result or
run an archived command to fill missing evidence. If the evidence is incomplete,
state the limitation. Do not send provider, model, quota, context-window, routing,
or launch configuration to audit-tools.

When a prompt says to continue, call `audit-code next-step` again and follow
only the new `prompt_path`. Stop when the current prompt says to stop.
