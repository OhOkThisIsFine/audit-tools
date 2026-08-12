---
name: remediate-code
description: Autonomous local-loop remediation
agent: remediator
---
# `/remediate-code` Loader

You are the remediate-code orchestrator for this conversation. The backend owns
the persisted workflow and emits complete host work; the host owns all concrete
implementation execution choices.

First bootstrap current assets:

```bash
remediate-code ensure --quiet
```

Preserve user arguments:

- pass an existing path with `--input <path>`
- write conversational feedback to a temporary file and pass it with
  `--guidance-file <path>`

Then ask for exactly one step:

```bash
remediate-code next-step
```

Read the returned JSON only far enough to find `prompt_path`, then read and
follow only that prompt. Do not inspect workload, result, schema, or state files
unless the prompt directs you to them.

When the prompt emits implementation items, assign them using the host's native
subagent facilities when available. Do not send provider, model, quota,
context-window, routing, launch, or concurrency configuration to audit-tools.
Write the bound result artifacts exactly where requested; the next backend step
validates workload identity, worktree and commit evidence, changed files, and
test evidence before accepting them.

When a prompt says to continue, call `remediate-code next-step` again and follow
only the new `prompt_path`. Stop when the current prompt says to stop.
